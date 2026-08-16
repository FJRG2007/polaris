/**
 * Snippet service: text that can be handed out by link.
 *
 * The bodies are envelope-encrypted at rest under the master key, so a database
 * dump is not a pile of .env files - but Polaris holds the key, which is what
 * lets it highlight, preview and search them. A snippet that must not be
 * readable here is sealed in the sender's browser instead (`clientSealed`), and
 * then everything below moves ciphertext it cannot open.
 *
 * The link half - token, password, expiry, view cap, address rules - is the same
 * as a Drive share's and is enforced through the same guards in lib/link-guards.
 * The raw token exists in the URL only; the row stores its hash, plus an
 * encrypted copy so the owner can be shown the link again.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { sharingBaseUrl } from "@/lib/domain-service";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";
import type { CreateSnippetInput, ShareSnippetInput, UpdateSnippetInput } from "@polaris/core";
import {
    linkUsability,
    signUnlock,
    unlockCookieName,
    verifyUnlock,
    type LinkUsability
} from "@/lib/link-guards";

/** The unlock-cookie namespace snippet links are signed under. */
const SNIPPET_LINK_SCOPE = "snippet";

/** A snippet as the public page needs it. */
export type SnippetRecord = Awaited<ReturnType<typeof resolveSnippetByToken>>;

/** Why a snippet link cannot be served right now, or `ok`. */
export type SnippetUsability = LinkUsability;

/** One file, decrypted, as an owner or a viewer reads it. */
export interface SnippetFileBody {
    id: string;
    name: string;
    language: string;
    body: string;
    size: number;
}

/** Encrypt one file body into the columns the row stores it in. */
function sealBody(body: string) {
    const blob = encryptSecret(body, loadEnv().POLARIS_MASTER_KEY);
    return {
        encryptedBody: blob.ciphertext,
        bodyNonce: blob.nonce,
        bodyKeyId: blob.keyId,
        // The plaintext length, so a listing can size a snippet without opening
        // it. Bytes rather than characters: it is what a download will weigh.
        size: Buffer.byteLength(body, "utf8")
    };
}

/** Decrypt one stored file body. */
function openBody(file: {
    encryptedBody: Uint8Array;
    bodyNonce: Uint8Array;
    bodyKeyId: string;
}): string {
    return decryptSecret(
        {
            ciphertext: Buffer.from(file.encryptedBody),
            nonce: Buffer.from(file.bodyNonce),
            keyId: file.bodyKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/** The columns that hold a link token, encrypted so it can be revealed again. */
function sealToken(token: string) {
    const blob = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    return {
        tokenHash: hashToken(token),
        encryptedToken: blob.ciphertext,
        tokenNonce: blob.nonce,
        tokenKeyId: blob.keyId
    };
}

/**
 * Create a snippet. A private one gets no token at all - there is no link to
 * leak - and a shared one returns its raw token once, for the URL.
 */
export async function createSnippet(
    ownerId: string,
    input: CreateSnippetInput
): Promise<{ id: string; token: string | null }> {
    const shared = input.visibility !== "private";
    const token = shared ? generateToken() : null;
    const snippet = await prisma.snippet.create({
        data: {
            ownerId,
            title: input.title?.trim() || defaultTitle(input),
            description: input.description ?? null,
            visibility: input.visibility,
            clientSealed: input.clientSealed,
            ...(token ? sealToken(token) : {}),
            passwordHash: input.password ? await hashLinkPassword(input.password) : null,
            // Burning is a single view by definition; recording it as one keeps
            // the cap the only thing the serving path has to check.
            maxViews: input.burnAfterRead ? 1 : (input.maxViews ?? null),
            burnAfterRead: input.burnAfterRead,
            expiresAt: input.expiresAt ?? null,
            allowedCidrs: JSON.stringify(input.allowedCidrs),
            allowedCountries: JSON.stringify(input.allowedCountries),
            allowedContinents: JSON.stringify(input.allowedContinents),
            files: {
                create: input.files.map((file, index) => ({
                    name: file.name,
                    language: file.language,
                    position: index,
                    ...sealBody(file.body)
                }))
            },
            invites:
                input.visibility === "invite"
                    ? {
                          create: (await resolveAccounts(input.inviteUsers)).map((userId) => ({
                              userId
                          }))
                      }
                    : undefined
        },
        select: { id: true }
    });
    return { id: snippet.id, token };
}

/**
 * Turn the names somebody typed into the accounts they meant.
 *
 * Identities are what a person can type - a username or an address - and ids are
 * what an invite has to hold, because a username can be changed afterwards and
 * the invite must follow the person rather than the string. Anything that
 * matches nobody is dropped rather than refused: a list of five colleagues with
 * one typo in it should invite the four, and the dialog shows who it reached.
 */
async function resolveAccounts(identities: readonly string[]): Promise<string[]> {
    if (identities.length === 0) return [];
    const users = await prisma.user.findMany({
        where: { OR: [{ username: { in: [...identities] } }, { email: { in: [...identities] } }] },
        select: { id: true }
    });
    return users.map((user) => user.id);
}

/** The name a snippet takes when its author did not give it one: the first
 *  file's, which is what they would have typed anyway. */
function defaultTitle(input: CreateSnippetInput): string {
    return input.files[0]?.name ?? "Untitled";
}

/**
 * A user's own snippets, newest first. Submissions that arrived through a drop
 * point are left out: they belong to that drop point's page, and mixing them in
 * would bury what the owner actually wrote.
 */
export async function listSnippetsForOwner(ownerId: string) {
    return prisma.snippet.findMany({
        where: { ownerId, requestId: null },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true,
            title: true,
            description: true,
            visibility: true,
            clientSealed: true,
            burnAfterRead: true,
            maxViews: true,
            viewCount: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
            updatedAt: true,
            encryptedToken: true,
            files: {
                select: { name: true, language: true, size: true },
                orderBy: { position: "asc" }
            }
        }
    });
}

/** Everything one drop point has collected, newest first. */
export async function listSnippetsForRequest(ownerId: string, requestId: string) {
    return prisma.snippet.findMany({
        where: { ownerId, requestId },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            title: true,
            clientSealed: true,
            createdAt: true,
            submittedIpHash: true,
            submittedBy: { select: { id: true, name: true, username: true } },
            files: { select: { name: true, size: true }, orderBy: { position: "asc" } }
        }
    });
}

/** One snippet with its text, for its owner. Null when it is not theirs. */
export async function getSnippetForOwner(ownerId: string, snippetId: string) {
    const snippet = await prisma.snippet.findFirst({
        where: { id: snippetId, ownerId },
        select: {
            id: true,
            title: true,
            description: true,
            visibility: true,
            clientSealed: true,
            burnAfterRead: true,
            maxViews: true,
            viewCount: true,
            expiresAt: true,
            revokedAt: true,
            passwordHash: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true,
            createdAt: true,
            updatedAt: true,
            encryptedToken: true,
            requestId: true,
            files: {
                orderBy: { position: "asc" },
                select: {
                    id: true,
                    name: true,
                    language: true,
                    size: true,
                    encryptedBody: true,
                    bodyNonce: true,
                    bodyKeyId: true
                }
            },
            invites: { select: { userId: true } }
        }
    });
    if (!snippet) return null;
    return { ...snippet, files: snippet.files.map(toFileBody) };
}

/** Decrypt a stored file row into the shape every reader wants. */
function toFileBody(file: {
    id: string;
    name: string;
    language: string;
    size: number;
    encryptedBody: Uint8Array;
    bodyNonce: Uint8Array;
    bodyKeyId: string;
}): SnippetFileBody {
    return {
        id: file.id,
        name: file.name,
        language: file.language,
        size: file.size,
        body: openBody(file)
    };
}

/**
 * Rewrite a snippet's text. The files are replaced rather than diffed: a snippet
 * is small, the editor sends the whole set, and matching them up by name would
 * turn a rename into a delete plus an add anyway.
 */
export async function updateSnippet(
    ownerId: string,
    snippetId: string,
    input: UpdateSnippetInput
): Promise<boolean> {
    const owned = await prisma.snippet.count({ where: { id: snippetId, ownerId } });
    if (owned === 0) return false;
    await prisma.$transaction(async (tx) => {
        if (input.files) {
            await tx.snippetFile.deleteMany({ where: { snippetId } });
            await tx.snippetFile.createMany({
                data: input.files.map((file, index) => ({
                    snippetId,
                    name: file.name,
                    language: file.language,
                    position: index,
                    ...sealBody(file.body)
                }))
            });
        }
        await tx.snippet.update({
            where: { id: snippetId },
            data: {
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
                // Touched even when only the files moved, so the list stays in the
                // order somebody actually worked in.
                updatedAt: new Date()
            }
        });
    });
    return true;
}

/**
 * Change how a snippet is shared, and hand back the link when there is one.
 *
 * Opening a snippet that was private - or re-opening one that was revoked -
 * mints a NEW token rather than reviving the old one. Somebody who was given a
 * link and then had it taken away must not get it back because the owner shared
 * the snippet again with somebody else.
 */
export async function shareSnippet(
    ownerId: string,
    snippetId: string,
    input: ShareSnippetInput
): Promise<{ ok: false } | { ok: true; url: string | null }> {
    const current = await prisma.snippet.findFirst({
        where: { id: snippetId, ownerId },
        select: { visibility: true, tokenHash: true, revokedAt: true }
    });
    if (!current) return { ok: false };

    const visibility = input.visibility ?? current.visibility;
    const shared = visibility !== "private";
    const needsToken = shared && (current.tokenHash === null || current.revokedAt !== null);
    const token = needsToken ? generateToken() : null;

    const data: Record<string, unknown> = { visibility };
    if (token) {
        Object.assign(data, sealToken(token), { revokedAt: null, viewCount: 0 });
    }
    if (!shared) data.revokedAt = new Date();
    if (input.password !== undefined) {
        data.passwordHash = input.password ? await hashLinkPassword(input.password) : null;
    }
    if (input.burnAfterRead !== undefined) {
        data.burnAfterRead = input.burnAfterRead;
        if (input.burnAfterRead) data.maxViews = 1;
    }
    if (input.maxViews !== undefined && !data.maxViews) data.maxViews = input.maxViews;
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;
    if (input.allowedCidrs !== undefined) data.allowedCidrs = JSON.stringify(input.allowedCidrs);
    if (input.allowedCountries !== undefined) {
        data.allowedCountries = JSON.stringify(input.allowedCountries);
    }
    if (input.allowedContinents !== undefined) {
        data.allowedContinents = JSON.stringify(input.allowedContinents);
    }

    // Resolved before the transaction opens: it is a read, and holding one open
    // across it would keep a write lock for the length of a lookup.
    const invited = input.inviteUsers ? await resolveAccounts(input.inviteUsers) : [];

    await prisma.$transaction(async (tx) => {
        await tx.snippet.update({ where: { id: snippetId }, data });
        if (input.inviteUsers !== undefined) {
            await tx.snippetInvite.deleteMany({ where: { snippetId } });
            if (visibility === "invite" && invited.length > 0) {
                await tx.snippetInvite.createMany({
                    data: invited.map((userId) => ({ snippetId, userId }))
                });
            }
        }
    });

    if (!shared) return { ok: true, url: null };
    if (token) return { ok: true, url: `${await sharingBaseUrl()}/p/${token}` };
    return { ok: true, url: await revealSnippetLink(ownerId, snippetId) };
}

/** Decrypt and return the link for a snippet the caller owns, or null. */
export async function revealSnippetLink(
    ownerId: string,
    snippetId: string
): Promise<string | null> {
    const snippet = await prisma.snippet.findFirst({
        where: { id: snippetId, ownerId },
        select: { encryptedToken: true, tokenNonce: true, tokenKeyId: true }
    });
    if (!snippet?.encryptedToken || !snippet.tokenNonce) return null;
    const token = decryptSecret(
        {
            ciphertext: Buffer.from(snippet.encryptedToken),
            nonce: Buffer.from(snippet.tokenNonce),
            keyId: snippet.tokenKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    return `${await sharingBaseUrl()}/p/${token}`;
}

/** Stop serving a snippet's link. Idempotent, and scoped so IDOR is impossible. */
export async function revokeSnippetShare(ownerId: string, snippetId: string): Promise<void> {
    await prisma.snippet.updateMany({
        where: { id: snippetId, ownerId, revokedAt: null },
        data: { revokedAt: new Date(), visibility: "private" }
    });
}

/** Delete a snippet and everything hanging off it. */
export async function deleteSnippet(ownerId: string, snippetId: string): Promise<boolean> {
    const { count } = await prisma.snippet.deleteMany({ where: { id: snippetId, ownerId } });
    return count === 1;
}

/** Resolve a snippet by its raw link token (looked up by hash), or null. */
export async function resolveSnippetByToken(token: string) {
    return prisma.snippet.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
            id: true,
            ownerId: true,
            title: true,
            description: true,
            visibility: true,
            clientSealed: true,
            burnAfterRead: true,
            passwordHash: true,
            maxViews: true,
            viewCount: true,
            expiresAt: true,
            revokedAt: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true,
            createdAt: true,
            invites: { select: { userId: true } }
        }
    });
}

/** The files of a snippet, decrypted, for a viewer that has cleared every gate. */
export async function readSnippetFiles(snippetId: string): Promise<SnippetFileBody[]> {
    const files = await prisma.snippetFile.findMany({
        where: { snippetId },
        orderBy: { position: "asc" },
        select: {
            id: true,
            name: true,
            language: true,
            size: true,
            encryptedBody: true,
            bodyNonce: true,
            bodyKeyId: true
        }
    });
    return files.map(toFileBody);
}

/** Whether a snippet link is currently serveable. */
export function snippetUsability(snippet: {
    revokedAt: Date | null;
    expiresAt: Date | null;
    maxViews: number | null;
    viewCount: number;
    now?: Date;
}): SnippetUsability {
    return linkUsability(
        {
            revokedAt: snippet.revokedAt,
            expiresAt: snippet.expiresAt,
            maxUses: snippet.maxViews,
            useCount: snippet.viewCount
        },
        snippet.now ?? new Date()
    );
}

/**
 * Account for one view, enforcing the cap in the same statement so two readers
 * arriving at once can never both get through the last one. Returns whether this
 * request may proceed.
 */
export async function registerSnippetView(snippetId: string): Promise<boolean> {
    const result = await prisma.snippet.updateMany({
        where: {
            id: snippetId,
            revokedAt: null,
            OR: [{ maxViews: null }, { maxViews: { gt: prisma.snippet.fields.viewCount } }]
        },
        data: { viewCount: { increment: 1 } }
    });
    return result.count === 1;
}

/**
 * Destroy the text of a burn-after-reading snippet, keeping the row so its owner
 * can see that it was collected and when. The bodies are deleted rather than
 * blanked: a one-time secret that survives in a backup taken tomorrow was not
 * one-time.
 */
export async function burnSnippet(snippetId: string): Promise<void> {
    await prisma.$transaction([
        prisma.snippetFile.deleteMany({ where: { snippetId } }),
        prisma.snippet.update({
            where: { id: snippetId },
            data: {
                revokedAt: new Date(),
                encryptedToken: null,
                tokenNonce: null,
                tokenKeyId: null
            }
        })
    ]);
}

/** Constant-time password check. No password set means the link is open. */
export async function verifySnippetPassword(
    passwordHash: string | null,
    presented: string
): Promise<boolean> {
    if (!passwordHash) return true;
    return verifyLinkPassword(presented, passwordHash);
}

/** Cookie name recording a solved password for one snippet. */
export function snippetUnlockCookie(snippetId: string): string {
    return unlockCookieName(SNIPPET_LINK_SCOPE, snippetId);
}

/** Sign an unlock marker so the "password solved" cookie cannot be forged. */
export function signSnippetUnlock(snippetId: string, secret: string): string {
    return signUnlock(SNIPPET_LINK_SCOPE, snippetId, secret);
}

/** Constant-time check of an unlock cookie against its expected signature. */
export function verifySnippetUnlock(
    snippetId: string,
    value: string | undefined,
    secret: string
): boolean {
    return verifyUnlock(SNIPPET_LINK_SCOPE, snippetId, value, secret);
}

/** Append an access-log entry. Never throws; logging must not block a read. */
export async function logSnippetAccess(entry: {
    snippetId: string;
    action: string;
    reason?: string;
    ip?: string;
    ipHash?: string;
    userAgentHash?: string;
}): Promise<void> {
    try {
        await prisma.snippetAccessLog.create({ data: entry });
    } catch {
        // Swallow: a log failure must not break the page it was recording.
    }
}

/** The access log of a snippet the caller owns, newest first. */
export async function listSnippetAccessLogs(ownerId: string, snippetId: string) {
    const owned = await prisma.snippet.count({ where: { id: snippetId, ownerId } });
    if (owned === 0) return [];
    return prisma.snippetAccessLog.findMany({
        where: { snippetId },
        orderBy: { at: "desc" },
        take: 500,
        select: { id: true, at: true, ip: true, action: true, reason: true }
    });
}
