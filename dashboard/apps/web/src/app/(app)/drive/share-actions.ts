"use server";

/**
 * Share server actions. Creating and revoking a share are metadata mutations, so
 * they live in a Server Action; the byte-serving download path is a public Route
 * Handler. Every action re-resolves the session and re-validates its input with
 * the shared Zod schema before touching the database - the client is never the
 * source of truth for what may be shared or on what terms.
 */

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { loadEnv } from "@polaris/config";
import { sharingBaseUrl } from "@/lib/domain-service";
import { ensureShareReachability } from "@/lib/public-reach";
import { createShareSchema, isCidr, isIpAddress } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import {
    createShare,
    listShareAccessLogs,
    resolveShareByToken,
    revealShareLink,
    revokeShare,
    shareUnlockCookie,
    shareUsability,
    signShareUnlock,
    updateShare,
    verifySharePassword
} from "@/lib/share-service";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { clientIp, hashForLog } from "@/lib/request-context";

/** Attempts allowed before a public password gate blocks, and the window. */
const UNLOCK_LIMIT = 10;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

/** Interface a share owner uses to edit an existing link's guardrails. */
export interface UpdateShareInput {
    password?: string | null;
    maxDownloads?: number | null;
    expiresAt?: string | null;
    allowDownload?: boolean;
    allowPreview?: boolean;
    allowUpload?: boolean;
    allowRename?: boolean;
    allowDelete?: boolean;
    allowCreateFolder?: boolean;
    allowedCidrs?: string[];
}

/** One access-log row as shown to the share owner. */
export interface ShareLogRow {
    id: string;
    at: string;
    ip: string | null;
    action: string;
    reason: string | null;
}

/** Create a share and return the absolute link to hand out (once). */
export async function createShareAction(
    input: unknown
): Promise<{ url?: string; error?: string }> {
    const user = await requirePermission("shares.create");
    const parsed = createShareSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid share" };
    const { id, token } = await createShare(user.id, parsed.data);
    await recordAudit({
        actorId: user.id,
        action: "share.create",
        targetType: "share",
        targetId: id,
        metadata: {
            connectionId: parsed.data.connectionId,
            path: parsed.data.path,
            kind: parsed.data.kind,
            hasPassword: Boolean(parsed.data.password),
            allowUpload: parsed.data.allowUpload
        }
    });
    // Behind NAT with no public domain, raise a Cloudflare tunnel so the link works.
    await ensureShareReachability();
    revalidatePath("/drive/shared-links");
    return { url: `${await sharingBaseUrl()}/s/${token}` };
}

/** Reveal a share's link again (owner-only; decrypts the stored token). */
export async function revealShareLinkAction(shareId: string): Promise<{ url?: string; error?: string }> {
    const user = await requirePermission("shares.create");
    const url = await revealShareLink(user.id, shareId);
    if (!url) {
        return { error: "This link cannot be revealed - it predates link recovery. Create a new share instead." };
    }
    return { url };
}

/** Edit an existing share's guardrails (owner-scoped). */
export async function updateShareAction(shareId: string, input: UpdateShareInput): Promise<{ error?: string }> {
    const user = await requirePermission("shares.create");
    const cidrs = (input.allowedCidrs ?? []).map((value) => value.trim()).filter(Boolean);
    const invalid = cidrs.find((value) => !isCidr(value) && !isIpAddress(value));
    if (invalid) return { error: `Invalid IP or range: ${invalid}` };
    await updateShare(user.id, shareId, {
        password: input.password === undefined ? undefined : input.password || null,
        maxDownloads: input.maxDownloads === undefined ? undefined : input.maxDownloads || null,
        expiresAt: input.expiresAt === undefined ? undefined : input.expiresAt ? new Date(input.expiresAt) : null,
        allowDownload: input.allowDownload,
        allowPreview: input.allowPreview,
        allowUpload: input.allowUpload,
        allowRename: input.allowRename,
        allowDelete: input.allowDelete,
        allowCreateFolder: input.allowCreateFolder,
        allowedCidrs: input.allowedCidrs === undefined ? undefined : cidrs
    });
    await recordAudit({ actorId: user.id, action: "share.update", targetType: "share", targetId: shareId });
    revalidatePath("/drive/shared-links");
    return {};
}

/** Fetch the access log for a share the caller owns. */
export async function getShareLogsAction(shareId: string): Promise<{ logs: ShareLogRow[] }> {
    const user = await requirePermission("shares.create");
    const logs = await listShareAccessLogs(user.id, shareId);
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

/** Revoke a share the caller owns. Owner-scoped, so it cannot touch others'. */
export async function revokeShareAction(shareId: string): Promise<void> {
    const user = await requirePermission("shares.create");
    await revokeShare(user.id, shareId);
    await recordAudit({ actorId: user.id, action: "share.revoke", targetType: "share", targetId: shareId });
    revalidatePath("/drive/shared-links");
}

/**
 * Public action: verify a share's link password and, on success, set an
 * unforgeable httpOnly cookie so subsequent page loads and downloads for this
 * share skip the prompt. No session required - the link plus the password is the
 * credential. Returns a generic failure so it cannot be used as an oracle.
 */
export async function unlockShareAction(token: string, password: string): Promise<{ error?: string }> {
    const share = await resolveShareByToken(token);
    if (!share) return { error: "This link is not available." };
    if (!shareUsability(share).ok) return { error: "This link is no longer available." };

    const limitKey = `share-unlock:${share.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, UNLOCK_LIMIT, UNLOCK_WINDOW_MS)).ok) {
        return { error: "Too many attempts. Please wait a few minutes and try again." };
    }

    if (!(await verifySharePassword(share.passwordHash, password))) {
        return { error: "Incorrect password." };
    }
    await resetRateLimit(limitKey);
    const env = loadEnv();
    const store = await cookies();
    store.set(shareUnlockCookie(share.id), signShareUnlock(share.id, env.POLARIS_AUTH_SECRET), {
        httpOnly: true,
        sameSite: "lax",
        secure: env.POLARIS_SECURE_COOKIES,
        path: "/",
        maxAge: 60 * 60 * 12
    });
    return {};
}
