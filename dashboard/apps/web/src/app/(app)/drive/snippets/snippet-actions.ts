"use server";

/**
 * Snippet server actions. Writing, sharing and revoking a snippet are metadata
 * mutations, so they live here; the public read path (raw text, download) is a
 * Route Handler because it serves bytes.
 *
 * Every action re-resolves the session and re-validates its input with the
 * shared Zod schema. The one exception is the unlock action at the bottom, which
 * is deliberately public: on a snippet link the token plus the password IS the
 * credential, and there is no session to resolve.
 */

import { cookies } from "next/headers";
import { loadEnv } from "@polaris/config";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { requirePermission } from "@/lib/session";
import { sharingBaseUrl } from "@/lib/domain-service";
import * as snippetService from "@/lib/snippet-service";
import { ensureShareReachability } from "@/lib/public-reach";
import { clientIp, hashForLog } from "@/lib/request-context";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { gateSnippetRequest, snippetDenialMessage } from "@/lib/snippet-access";
import { createSnippetSchema, shareSnippetSchema, updateSnippetSchema } from "@polaris/core";

/** Attempts allowed before a public password gate blocks, and the window. */
const UNLOCK_LIMIT = 10;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

/** One access-log row as shown to the snippet's owner. */
export interface SnippetLogRow {
    id: string;
    at: string;
    ip: string | null;
    action: string;
    reason: string | null;
}

/** The screens a change to a snippet can be seen on. */
function revalidateSnippets(snippetId?: string): void {
    revalidatePath("/drive/snippets");
    if (snippetId) revalidatePath(`/drive/snippets/${snippetId}`);
}

/** Write a snippet, and hand back its link when it was shared straight away. */
export async function createSnippetAction(
    input: unknown
): Promise<{ id?: string; url?: string | null; error?: string }> {
    const user = await requirePermission("snippets.write");
    const parsed = createSnippetSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid snippet" };

    const { id, token } = await snippetService.createSnippet(user.id, parsed.data);
    await recordAudit({
        actorId: user.id,
        action: "snippet.create",
        targetType: "snippet",
        targetId: id,
        metadata: {
            visibility: parsed.data.visibility,
            files: parsed.data.files.length,
            hasPassword: Boolean(parsed.data.password),
            burnAfterRead: parsed.data.burnAfterRead,
            sealed: parsed.data.clientSealed
        }
    });
    revalidateSnippets();
    if (!token) return { id, url: null };
    // Behind NAT with no public domain, raise a tunnel so the link actually works.
    await ensureShareReachability();
    // The configured sharing origin, not the tab's host: a link built on
    // whatever hostname the author happened to be using is a link that works for
    // them and nobody else.
    return { id, url: `${await sharingBaseUrl()}/p/${token}` };
}

/** Rewrite a snippet's text (owner-scoped). */
export async function updateSnippetAction(
    snippetId: string,
    input: unknown
): Promise<{ error?: string }> {
    const user = await requirePermission("snippets.write");
    const parsed = updateSnippetSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid snippet" };
    if (!(await snippetService.updateSnippet(user.id, snippetId, parsed.data))) {
        return { error: "This snippet is not yours." };
    }
    await recordAudit({
        actorId: user.id,
        action: "snippet.update",
        targetType: "snippet",
        targetId: snippetId
    });
    revalidateSnippets(snippetId);
    return {};
}

/** Change how a snippet is shared, returning the link when there is one. */
export async function shareSnippetAction(
    snippetId: string,
    input: unknown
): Promise<{ url?: string | null; error?: string }> {
    const user = await requirePermission("snippets.write");
    const parsed = shareSnippetSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid sharing" };

    const result = await snippetService.shareSnippet(user.id, snippetId, parsed.data);
    if (!result.ok) return { error: "This snippet is not yours." };
    await recordAudit({
        actorId: user.id,
        action: "snippet.share",
        targetType: "snippet",
        targetId: snippetId,
        metadata: { visibility: parsed.data.visibility ?? "unchanged" }
    });
    if (result.url) await ensureShareReachability();
    revalidateSnippets(snippetId);
    return { url: result.url };
}

/** Reveal a snippet's link again (owner-only; decrypts the stored token). */
export async function revealSnippetLinkAction(
    snippetId: string
): Promise<{ url?: string; error?: string }> {
    const user = await requirePermission("snippets.write");
    const url = await snippetService.revealSnippetLink(user.id, snippetId);
    if (!url) return { error: "This snippet has no link. Share it to create one." };
    return { url };
}

/** Stop serving a snippet's link (owner-scoped). */
export async function revokeSnippetShareAction(snippetId: string): Promise<void> {
    const user = await requirePermission("snippets.write");
    await snippetService.revokeSnippetShare(user.id, snippetId);
    await recordAudit({
        actorId: user.id,
        action: "snippet.revoke",
        targetType: "snippet",
        targetId: snippetId
    });
    revalidateSnippets(snippetId);
}

/** Delete a snippet and its text (owner-scoped). */
export async function deleteSnippetAction(snippetId: string): Promise<{ error?: string }> {
    const user = await requirePermission("snippets.write");
    if (!(await snippetService.deleteSnippet(user.id, snippetId)))
        return { error: "This snippet is not yours." };
    await recordAudit({
        actorId: user.id,
        action: "snippet.delete",
        targetType: "snippet",
        targetId: snippetId
    });
    revalidateSnippets();
    return {};
}

/** The access log of a snippet the caller owns. */
export async function getSnippetLogsAction(snippetId: string): Promise<{ logs: SnippetLogRow[] }> {
    const user = await requirePermission("snippets.write");
    const logs = await snippetService.listSnippetAccessLogs(user.id, snippetId);
    return {
        logs: logs.map((row) => ({
            id: row.id,
            at: row.at.toISOString(),
            ip: row.ip,
            action: row.action,
            reason: row.reason
        }))
    };
}

/** One file of a snippet, as the public page shows it. */
export interface PublicSnippetFile {
    name: string;
    language: string;
    body: string;
    size: number;
}

/**
 * Public: open a one-time snippet, which destroys it.
 *
 * A burn-after-reading link is not opened by loading its page - a mail scanner
 * or a chat preview would spend it before its recipient ever clicked - so the
 * page shows a gate and this is what the gate's button calls. The view is
 * registered first, atomically: the second caller in a race is refused rather
 * than both being served, and only then is the text read and wiped.
 */
export async function openBurnSnippetAction(
    token: string
): Promise<{ files?: PublicSnippetFile[]; error?: string }> {
    const gate = await gateSnippetRequest(token, "open");
    if (!gate.ok) return { error: snippetDenialMessage(gate.reason) };
    if (!gate.snippet.burnAfterRead) return { error: "This link is not a one-time link." };

    if (!(await snippetService.registerSnippetView(gate.snippet.id))) {
        return { error: snippetDenialMessage("exhausted") };
    }
    const files = await snippetService.readSnippetFiles(gate.snippet.id);
    await snippetService.burnSnippet(gate.snippet.id);
    await snippetService.logSnippetAccess({
        snippetId: gate.snippet.id,
        action: "burn",
        ip: gate.ip,
        ipHash: gate.ipHash,
        userAgentHash: gate.userAgentHash
    });
    return {
        files: files.map((file) => ({
            name: file.name,
            language: file.language,
            body: file.body,
            size: file.size
        }))
    };
}

/**
 * Public: verify a snippet link's password and, on success, set an unforgeable
 * httpOnly cookie so the page and the raw endpoint stop asking. No session -
 * the link plus the password is the credential - so the answer is deliberately
 * generic and the attempts are capped per link and address.
 */
export async function unlockSnippetAction(
    token: string,
    password: string
): Promise<{ error?: string }> {
    const snippet = await snippetService.resolveSnippetByToken(token);
    if (!snippet) return { error: "This link is not available." };
    if (!snippetService.snippetUsability(snippet).ok)
        return { error: "This link is no longer available." };

    const limitKey = `snippet-unlock:${snippet.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: "Too many attempts. Please wait a few minutes and try again." };
    }
    if (!(await snippetService.verifySnippetPassword(snippet.passwordHash, password))) {
        return { error: "Incorrect password." };
    }

    await resetRateLimit(limitKey);
    const env = loadEnv();
    const store = await cookies();
    store.set(
        snippetService.snippetUnlockCookie(snippet.id),
        snippetService.signSnippetUnlock(snippet.id, env.POLARIS_AUTH_SECRET),
        {
            httpOnly: true,
            sameSite: "lax",
            secure: env.POLARIS_SECURE_COOKIES,
            path: "/",
            maxAge: 60 * 60 * 12
        }
    );
    return {};
}
