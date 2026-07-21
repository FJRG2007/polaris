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

/** The managed folder a drop point collects into: a dedicated, per-drop-point
 *  subfolder under "Drop Points" on the connection, so Polaris organizes uploads
 *  instead of the operator picking a path. */
function dropPointFolder(title: string): string {
    const safe = title.replace(/[\\/]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
    return `Drop Points/${safe}`;
}

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
            // Polaris manages the destination: a dedicated folder under "Drop Points",
            // not an operator-chosen path.
            destinationPath: normalizeRelPath(dropPointFolder(input.title)),
            requireLogin: input.requireLogin,
            passwordHash: input.password ? await hashLinkPassword(input.password) : null,
            maxSizeBytes: BigInt(input.maxSizeBytes),
            maxFiles: input.maxFiles ?? null,
            allowedExtensions: JSON.stringify(input.allowedExtensions),
            allowedMimeTypes: JSON.stringify(input.allowedMimeTypes),
            allowedCidrs: JSON.stringify(input.allowedCidrs),
            allowedCountries: JSON.stringify(input.allowedCountries),
            allowedContinents: JSON.stringify(input.allowedContinents),
            expiresAt: input.expiresAt ?? null
        },
        select: { id: true }
    });
    return { id: request.id, token };
}

/** One drop point owned by the user, with the full config the detail/edit view needs. */
export async function getFileRequestForOwner(ownerId: string, requestId: string) {
    return prisma.fileRequest.findFirst({
        where: { id: requestId, ownerId },
        select: {
            id: true,
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
            allowedCountries: true,
            allowedContinents: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
            destination: { select: { name: true } },
            _count: { select: { submissions: true } }
        }
    });
}

/** Files collected by one drop point (owner-scoped), newest first. Doubles as its activity log. */
export async function listSubmissionsForRequest(ownerId: string, requestId: string, limit = 200) {
    const owns = await prisma.fileRequest.count({ where: { id: requestId, ownerId } });
    if (owns === 0) return [];
    return prisma.fileRequestSubmission.findMany({
        where: { requestId },
        orderBy: { at: "desc" },
        take: limit,
        select: {
            id: true,
            fileName: true,
            size: true,
            storedPath: true,
            status: true,
            at: true,
            submittedByUserId: true
        }
    });
}

/** Fields a drop point's owner may change after creation. Only defined fields apply. */
export interface UpdateFileRequestInput {
    title?: string;
    instructions?: string | null;
    requireLogin?: boolean;
    /** New PIN, `null` to clear it, or `undefined` to keep the current one. */
    password?: string | null;
    maxSizeBytes?: number;
    maxFiles?: number | null;
    allowedExtensions?: string[];
    allowedMimeTypes?: string[];
    allowedCidrs?: string[];
    allowedCountries?: string[];
    allowedContinents?: string[];
    expiresAt?: Date | null;
}

/** Update a drop point's guardrails/config. Owner-scoped; only the given fields change. */
export async function updateFileRequest(
    ownerId: string,
    requestId: string,
    input: UpdateFileRequestInput
): Promise<void> {
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title;
    if (input.instructions !== undefined) data.instructions = input.instructions;
    if (input.requireLogin !== undefined) data.requireLogin = input.requireLogin;
    if (input.password !== undefined) {
        data.passwordHash = input.password ? await hashLinkPassword(input.password) : null;
    }
    if (input.maxSizeBytes !== undefined) data.maxSizeBytes = BigInt(input.maxSizeBytes);
    if (input.maxFiles !== undefined) data.maxFiles = input.maxFiles;
    if (input.allowedExtensions !== undefined) data.allowedExtensions = JSON.stringify(input.allowedExtensions);
    if (input.allowedMimeTypes !== undefined) data.allowedMimeTypes = JSON.stringify(input.allowedMimeTypes);
    if (input.allowedCidrs !== undefined) data.allowedCidrs = JSON.stringify(input.allowedCidrs);
    if (input.allowedCountries !== undefined) data.allowedCountries = JSON.stringify(input.allowedCountries);
    if (input.allowedContinents !== undefined) data.allowedContinents = JSON.stringify(input.allowedContinents);
    if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt;
    await prisma.fileRequest.updateMany({ where: { id: requestId, ownerId }, data });
}

/**
 * Reopen a closed drop point so it accepts uploads again. Clears the revoked mark
 * and, if the expiry has already elapsed, clears it too so the point is genuinely
 * open (the owner can set a fresh expiry from the edit form). Owner-scoped.
 */
export async function reopenFileRequest(ownerId: string, requestId: string): Promise<void> {
    const request = await prisma.fileRequest.findFirst({
        where: { id: requestId, ownerId },
        select: { expiresAt: true }
    });
    if (!request) return;
    const expired = request.expiresAt !== null && request.expiresAt.getTime() <= Date.now();
    await prisma.fileRequest.updateMany({
        where: { id: requestId, ownerId },
        data: { revokedAt: null, ...(expired ? { expiresAt: null } : {}) }
    });
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
            allowedCountries: true,
            allowedContinents: true,
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
