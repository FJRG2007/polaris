/**
 * Share service. A share exposes one file or folder from a connection to people
 * outside the app - anyone with the link, optionally gated by a password, an
 * expiry, and a download cap. The raw token lives only in the URL we return once
 * at creation; the database stores its hash, so a dump yields no working links.
 * Every limit is enforced here, server-side, on each access - the public pages
 * never trust the client to honor its own constraints.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { CreateShareInput } from "@polaris/core";
import { ipAllowed, normalizeRelPath } from "@polaris/core";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";
import { loadEnv } from "@polaris/config";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { prisma } from "@polaris/db";

/** A share as needed by the public access path. */
export type ShareRecord = Awaited<ReturnType<typeof resolveShareByToken>>;

/** Why a share cannot currently be used, or `ok`. */
export type ShareUsability =
    | { ok: true }
    | { ok: false; reason: "revoked" | "expired" | "exhausted" };

/** Create a share and return the one-time raw token to embed in the link. */
export async function createShare(
    ownerId: string,
    input: CreateShareInput
): Promise<{ id: string; token: string }> {
    const token = generateToken();
    const path = normalizeRelPath(input.path);
    const passwordHash = input.password ? await hashLinkPassword(input.password) : null;
    const tokenBlob = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    const share = await prisma.share.create({
        data: {
            connectionId: input.connectionId,
            path,
            ownerId,
            kind: input.kind,
            tokenHash: hashToken(token),
            encryptedToken: tokenBlob.ciphertext,
            tokenNonce: tokenBlob.nonce,
            tokenKeyId: tokenBlob.keyId,
            passwordHash,
            maxDownloads: input.maxDownloads ?? null,
            expiresAt: input.expiresAt ?? null,
            allowUpload: input.allowUpload,
            allowDownload: input.allowDownload,
            allowPreview: input.allowPreview,
            allowedCidrs: JSON.stringify(input.allowedCidrs),
            invites:
                input.kind === "invite"
                    ? { create: input.inviteUserIds.map((userId) => ({ userId })) }
                    : undefined
        },
        select: { id: true }
    });
    return { id: share.id, token };
}

/** Every share owned by a user, with its connection name, newest first. */
export async function listSharesForOwner(ownerId: string) {
    return prisma.share.findMany({
        where: { ownerId },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            path: true,
            kind: true,
            allowUpload: true,
            allowDownload: true,
            allowPreview: true,
            allowedCidrs: true,
            maxDownloads: true,
            downloadCount: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
            encryptedToken: true,
            connection: { select: { name: true } }
        }
    });
}

/** Decrypt and return the raw link for a share the caller owns, or null. */
export async function revealShareLink(ownerId: string, shareId: string): Promise<string | null> {
    const share = await prisma.share.findFirst({
        where: { id: shareId, ownerId },
        select: { encryptedToken: true, tokenNonce: true, tokenKeyId: true }
    });
    if (!share?.encryptedToken || !share.tokenNonce) return null;
    const token = decryptSecret(
        {
            ciphertext: Buffer.from(share.encryptedToken),
            nonce: Buffer.from(share.tokenNonce),
            keyId: share.tokenKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
    return `${loadEnv().POLARIS_APP_URL}/s/${token}`;
}

/** Update a share's guardrails. Owner-scoped; only the given fields change. */
export async function updateShare(
    ownerId: string,
    shareId: string,
    input: {
        password?: string | null;
        maxDownloads?: number | null;
        expiresAt?: Date | null;
        allowDownload?: boolean;
        allowPreview?: boolean;
        allowUpload?: boolean;
        allowedCidrs?: string[];
    }
): Promise<void> {
    const data: Record<string, unknown> = {};
    if (input.password !== undefined) {
        data.passwordHash = input.password ? await hashLinkPassword(input.password) : null;
    }
    if (input.maxDownloads !== undefined) data.maxDownloads = input.maxDownloads;
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;
    if (input.allowDownload !== undefined) data.allowDownload = input.allowDownload;
    if (input.allowPreview !== undefined) data.allowPreview = input.allowPreview;
    if (input.allowUpload !== undefined) data.allowUpload = input.allowUpload;
    if (input.allowedCidrs !== undefined) data.allowedCidrs = JSON.stringify(input.allowedCidrs);
    await prisma.share.updateMany({ where: { id: shareId, ownerId }, data });
}

/** Access-log entries for a share the caller owns, newest first (owner-visible). */
export async function listShareAccessLogs(ownerId: string, shareId: string) {
    const owns = await prisma.share.count({ where: { id: shareId, ownerId } });
    if (owns === 0) return [];
    return prisma.shareAccessLog.findMany({
        where: { shareId },
        orderBy: { at: "desc" },
        take: 500,
        select: { id: true, at: true, ip: true, action: true, reason: true }
    });
}

/** Revoke a share owned by the user. Idempotent; scoped so IDOR is impossible. */
export async function revokeShare(ownerId: string, shareId: string): Promise<void> {
    await prisma.share.updateMany({
        where: { id: shareId, ownerId, revokedAt: null },
        data: { revokedAt: new Date() }
    });
}

/** Resolve a share by its raw token (looked up by hash), or null. */
export async function resolveShareByToken(token: string) {
    return prisma.share.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
            id: true,
            connectionId: true,
            path: true,
            kind: true,
            passwordHash: true,
            maxDownloads: true,
            downloadCount: true,
            expiresAt: true,
            allowUpload: true,
            allowDownload: true,
            allowPreview: true,
            allowedCidrs: true,
            revokedAt: true,
            connection: { select: { name: true } }
        }
    });
}

/**
 * Whether a client IP is permitted by a share's IP/CIDR allowlist. An empty or
 * unparseable rule list means no restriction (anyone with the link). Enforced on
 * every public access before any bytes or listing are served.
 */
export function shareIpAllowed(allowedCidrsJson: string, ip: string | undefined): boolean {
    let rules: string[] = [];
    try {
        const parsed = JSON.parse(allowedCidrsJson);
        if (Array.isArray(parsed)) rules = parsed.filter((value): value is string => typeof value === "string");
    } catch {
        return true;
    }
    if (rules.length === 0) return true;
    if (!ip) return false;
    return ipAllowed(ip, rules);
}

/** Whether a share is currently serveable (not revoked, expired, or exhausted). */
export function shareUsability(share: {
    revokedAt: Date | null;
    expiresAt: Date | null;
    maxDownloads: number | null;
    downloadCount: number;
    now?: Date;
}): ShareUsability {
    const now = share.now ?? new Date();
    if (share.revokedAt) return { ok: false, reason: "revoked" };
    if (share.expiresAt && share.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
    if (share.maxDownloads !== null && share.downloadCount >= share.maxDownloads) {
        return { ok: false, reason: "exhausted" };
    }
    return { ok: true };
}

/** Constant-time password check for a share. No password set means always open. */
export async function verifySharePassword(passwordHash: string | null, presented: string): Promise<boolean> {
    if (!passwordHash) return true;
    return verifyLinkPassword(presented, passwordHash);
}

/**
 * Atomically account for one download, enforcing the cap in the same statement so
 * concurrent requests can never exceed maxDownloads. Returns true if this request
 * is allowed to proceed. Shares with no cap just increment the counter.
 */
export async function registerDownload(shareId: string): Promise<boolean> {
    const result = await prisma.share.updateMany({
        where: {
            id: shareId,
            revokedAt: null,
            OR: [{ maxDownloads: null }, { maxDownloads: { gt: prisma.share.fields.downloadCount } }]
        },
        data: { downloadCount: { increment: 1 } }
    });
    return result.count === 1;
}

/** Append an access-log entry for a share. Never throws; logging must not block. */
export async function logShareAccess(entry: {
    shareId: string;
    action: string;
    reason?: string;
    ip?: string;
    ipHash?: string;
    userAgentHash?: string;
}): Promise<void> {
    try {
        await prisma.shareAccessLog.create({
            data: {
                shareId: entry.shareId,
                action: entry.action,
                reason: entry.reason,
                ip: entry.ip,
                ipHash: entry.ipHash,
                userAgentHash: entry.userAgentHash
            }
        });
    } catch {
        // Swallow: an access-log failure must not break the download path.
    }
}

/** Cookie name that records a solved password for one share. */
export function shareUnlockCookie(shareId: string): string {
    return `polaris_share_${shareId}`;
}

/**
 * Sign an unlock marker for a share with the app secret so the "password solved"
 * cookie cannot be forged: only the server, holding POLARIS_AUTH_SECRET, can mint
 * a value the download path will accept.
 */
export function signShareUnlock(shareId: string, secret: string): string {
    return createHmac("sha256", secret).update(`unlock:${shareId}`).digest("base64url");
}

/** Constant-time check of an unlock cookie value against the expected signature. */
export function verifyShareUnlock(shareId: string, value: string | undefined, secret: string): boolean {
    if (!value) return false;
    const expected = Buffer.from(signShareUnlock(shareId, secret));
    const presented = Buffer.from(value);
    if (expected.length !== presented.length) return false;
    return timingSafeEqual(presented, expected);
}

/**
 * Resolve a requested path against a share's root. A file share serves exactly
 * its path; a folder share serves any descendant. Returns the normalized absolute
 * (connection-relative) path, or null if the request escapes the shared subtree.
 */
export function resolveWithinShare(sharePath: string, requested: string | null): string | null {
    const root = normalizeRelPath(sharePath);
    if (!requested) return root;
    const target = normalizeRelPath(requested);
    if (target === root) return target;
    if (root === "" || target.startsWith(`${root}/`)) return target;
    return null;
}
