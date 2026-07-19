/**
 * File-request service. A file request is the inverse of a share: it hands out a
 * URL that lets people upload into a chosen folder, with or without an account.
 * Because the upload endpoint can be anonymous, every limit (type, size, count,
 * IP, expiry) is a security control enforced here server-side on each upload -
 * the public page never trusts the client to honor its own constraints. The raw
 * token lives only in the URL returned once at creation; the database stores its
 * hash, so a dump yields no working links.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { CreateFileRequestInput } from "@polaris/core";
import { ipAllowed, normalizeRelPath } from "@polaris/core";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";
import { prisma } from "@polaris/db";

/** A file request as needed by the public upload path. */
export type FileRequestRecord = Awaited<ReturnType<typeof resolveFileRequestByToken>>;

/** Why a file request cannot currently accept uploads, or `ok`. */
export type FileRequestUsability =
    | { ok: true }
    | { ok: false; reason: "revoked" | "expired" };

/** Create a file request and return the one-time raw token to embed in the link. */
export async function createFileRequest(
    ownerId: string,
    input: CreateFileRequestInput
): Promise<{ id: string; token: string }> {
    const token = generateToken();
    const request = await prisma.fileRequest.create({
        data: {
            ownerId,
            tokenHash: hashToken(token),
            title: input.title,
            instructions: input.instructions ?? null,
            destinationConnectionId: input.destinationConnectionId,
            destinationPath: normalizeRelPath(input.destinationPath),
            requireLogin: input.requireLogin,
            passwordHash: input.password ? await hashLinkPassword(input.password) : null,
            maxSizeBytes: BigInt(input.maxSizeBytes),
            maxFiles: input.maxFiles ?? null,
            allowedExtensions: JSON.stringify(input.allowedExtensions),
            allowedMimeTypes: JSON.stringify(input.allowedMimeTypes),
            allowedCidrs: JSON.stringify(input.allowedCidrs),
            expiresAt: input.expiresAt ?? null
        },
        select: { id: true }
    });
    return { id: request.id, token };
}

/** Every file request owned by a user, with its destination name, newest first. */
export async function listFileRequestsForOwner(ownerId: string) {
    return prisma.fileRequest.findMany({
        where: { ownerId },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            title: true,
            destinationPath: true,
            requireLogin: true,
            maxFiles: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
            destination: { select: { name: true } },
            _count: { select: { submissions: true } }
        }
    });
}

/** Revoke a file request owned by the user. Idempotent; scoped so IDOR is impossible. */
export async function revokeFileRequest(ownerId: string, requestId: string): Promise<void> {
    await prisma.fileRequest.updateMany({
        where: { id: requestId, ownerId, revokedAt: null },
        data: { revokedAt: new Date() }
    });
}

/** Resolve a file request by its raw token (looked up by hash), or null. */
export async function resolveFileRequestByToken(token: string) {
    return prisma.fileRequest.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
            id: true,
            ownerId: true,
            title: true,
            instructions: true,
            destinationConnectionId: true,
            destinationPath: true,
            requireLogin: true,
            passwordHash: true,
            maxSizeBytes: true,
            maxFiles: true,
            allowedExtensions: true,
            allowedMimeTypes: true,
            allowedCidrs: true,
            expiresAt: true,
            revokedAt: true
        }
    });
}

/** Whether a file request is currently accepting uploads (not revoked or expired). */
export function fileRequestUsability(request: {
    revokedAt: Date | null;
    expiresAt: Date | null;
    now?: Date;
}): FileRequestUsability {
    const now = request.now ?? new Date();
    if (request.revokedAt) return { ok: false, reason: "revoked" };
    if (request.expiresAt && request.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: "expired" };
    }
    return { ok: true };
}

/**
 * Whether a client IP is permitted by a request's IP/CIDR allowlist. An empty or
 * unparseable list means no restriction. Enforced before any upload is accepted.
 */
export function fileRequestIpAllowed(allowedCidrsJson: string, ip: string | undefined): boolean {
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

/** Constant-time PIN/password check. No password set means always open. */
export async function verifyFileRequestPassword(passwordHash: string | null, presented: string): Promise<boolean> {
    if (!passwordHash) return true;
    return verifyLinkPassword(presented, passwordHash);
}

/** Cookie name recording a solved PIN for one drop point. */
export function fileRequestUnlockCookie(requestId: string): string {
    return `polaris_drop_${requestId}`;
}

/** Sign an unlock marker so the "PIN solved" cookie cannot be forged. */
export function signFileRequestUnlock(requestId: string, secret: string): string {
    return createHmac("sha256", secret).update(`drop-unlock:${requestId}`).digest("base64url");
}

/** Constant-time check of an unlock cookie against the expected signature. */
export function verifyFileRequestUnlock(requestId: string, value: string | undefined, secret: string): boolean {
    if (!value) return false;
    const expected = Buffer.from(signFileRequestUnlock(requestId, secret));
    const presented = Buffer.from(value);
    if (expected.length !== presented.length) return false;
    return timingSafeEqual(presented, expected);
}

/** Parse a stored JSON string array back into a string[] (empty on any error). */
export function parseStringArray(json: string): string[] {
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
        return [];
    }
}

/** Count how many files have been submitted to a request (for the maxFiles cap). */
export async function countSubmissions(requestId: string): Promise<number> {
    return prisma.fileRequestSubmission.count({ where: { requestId } });
}

/** Record a stored submission against a request; returns its id. */
export async function recordSubmission(entry: {
    requestId: string;
    submittedByUserId?: string | null;
    ipHash?: string | null;
    fileName: string;
    size: bigint;
    storedPath: string;
}): Promise<{ id: string }> {
    return prisma.fileRequestSubmission.create({
        data: {
            requestId: entry.requestId,
            submittedByUserId: entry.submittedByUserId ?? null,
            ipHash: entry.ipHash ?? null,
            fileName: entry.fileName,
            size: entry.size,
            storedPath: entry.storedPath,
            status: "stored"
        },
        select: { id: true }
    });
}
