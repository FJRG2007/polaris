/**
 * File-request service. A file request is the inverse of a share: it hands out a
 * URL that lets people upload into a chosen folder, with or without an account.
 * Because the upload endpoint can be anonymous, every limit (type, size, count,
 * IP, expiry) is a security control enforced here server-side on each upload -
 * the public page never trusts the client to honor its own constraints. The raw
 * token lives only in the URL returned once at creation; the database stores its
 * hash, so a dump yields no working links.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { CreateFileRequestInput } from "@polaris/core";
import {
    ipAllowed,
    normalizeRelPath,
    randomDropPointName,
    userAllowedForRequest
} from "@polaris/core";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { hashLinkPassword, verifyLinkPassword } from "@polaris/core/link-password";
import { prisma } from "@polaris/db";
import { getDriverForConnection } from "@/lib/storage-service";

/** A file request as needed by the public upload path. */
export type FileRequestRecord = Awaited<ReturnType<typeof resolveFileRequestByToken>>;

/** Why a file request cannot currently accept uploads, or `ok`. */
export type FileRequestUsability =
    | { ok: true }
    | { ok: false; reason: "revoked" | "expired" | "scheduled" };

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
            title: input.title?.trim() || randomDropPointName(),
            instructions: input.instructions ?? null,
            destinationConnectionId: input.destinationConnectionId,
            destinationPath: normalizeRelPath(input.destinationPath),
            requireLogin: input.requireLogin,
            passwordHash: input.password ? await hashLinkPassword(input.password) : null,
            maxSizeBytes: BigInt(input.maxSizeBytes),
            minSizeBytes: input.minSizeBytes !== undefined ? BigInt(input.minSizeBytes) : null,
            maxFiles: input.maxFiles ?? null,
            allowedExtensions: JSON.stringify(input.allowedExtensions),
            deniedExtensions: JSON.stringify(input.deniedExtensions),
            allowedMimeTypes: JSON.stringify(input.allowedMimeTypes),
            allowedCidrs: JSON.stringify(input.allowedCidrs),
            allowedCountries: JSON.stringify(input.allowedCountries),
            allowedContinents: JSON.stringify(input.allowedContinents),
            allowedUsers: JSON.stringify(input.allowedUsers),
            startsAt: input.startsAt ?? null,
            allowUploaderDelete: input.allowUploaderDelete,
            uploaderDeleteWindowSeconds: input.uploaderDeleteWindowSeconds ?? null,
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
            minSizeBytes: true,
            maxFiles: true,
            allowedExtensions: true,
            deniedExtensions: true,
            allowedMimeTypes: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true,
            allowedUsers: true,
            startsAt: true,
            allowUploaderDelete: true,
            uploaderDeleteWindowSeconds: true,
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
    /** New minimum, `null` to clear it, or `undefined` to keep the current one. */
    minSizeBytes?: number | null;
    maxFiles?: number | null;
    allowedExtensions?: string[];
    deniedExtensions?: string[];
    allowedMimeTypes?: string[];
    allowedCidrs?: string[];
    allowedCountries?: string[];
    allowedContinents?: string[];
    allowedUsers?: string[];
    /** New start time, `null` to clear it, or `undefined` to keep it. */
    startsAt?: Date | null;
    allowUploaderDelete?: boolean;
    /** New window (seconds), `null` to clear it, or `undefined` to keep it. */
    uploaderDeleteWindowSeconds?: number | null;
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
    if (input.minSizeBytes !== undefined) {
        data.minSizeBytes = input.minSizeBytes === null ? null : BigInt(input.minSizeBytes);
    }
    if (input.maxFiles !== undefined) data.maxFiles = input.maxFiles;
    if (input.allowedExtensions !== undefined)
        data.allowedExtensions = JSON.stringify(input.allowedExtensions);
    if (input.deniedExtensions !== undefined)
        data.deniedExtensions = JSON.stringify(input.deniedExtensions);
    if (input.allowedMimeTypes !== undefined)
        data.allowedMimeTypes = JSON.stringify(input.allowedMimeTypes);
    if (input.allowedCidrs !== undefined) data.allowedCidrs = JSON.stringify(input.allowedCidrs);
    if (input.allowedCountries !== undefined)
        data.allowedCountries = JSON.stringify(input.allowedCountries);
    if (input.allowedContinents !== undefined)
        data.allowedContinents = JSON.stringify(input.allowedContinents);
    if (input.allowedUsers !== undefined) data.allowedUsers = JSON.stringify(input.allowedUsers);
    if (input.startsAt !== undefined) data.startsAt = input.startsAt;
    if (input.allowUploaderDelete !== undefined)
        data.allowUploaderDelete = input.allowUploaderDelete;
    if (input.uploaderDeleteWindowSeconds !== undefined) {
        data.uploaderDeleteWindowSeconds = input.uploaderDeleteWindowSeconds;
    }
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
            startsAt: true,
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
            minSizeBytes: true,
            maxFiles: true,
            allowedExtensions: true,
            deniedExtensions: true,
            allowedMimeTypes: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true,
            allowedUsers: true,
            startsAt: true,
            allowUploaderDelete: true,
            uploaderDeleteWindowSeconds: true,
            expiresAt: true,
            revokedAt: true
        }
    });
}

/** Whether a file request is currently accepting uploads (open, started, unexpired). */
export function fileRequestUsability(request: {
    revokedAt: Date | null;
    expiresAt: Date | null;
    startsAt?: Date | null;
    now?: Date;
}): FileRequestUsability {
    const now = request.now ?? new Date();
    if (request.revokedAt) return { ok: false, reason: "revoked" };
    if (request.startsAt && request.startsAt.getTime() > now.getTime()) {
        return { ok: false, reason: "scheduled" };
    }
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
        if (Array.isArray(parsed))
            rules = parsed.filter((value): value is string => typeof value === "string");
    } catch {
        return true;
    }
    if (rules.length === 0) return true;
    if (!ip) return false;
    return ipAllowed(ip, rules);
}

/**
 * Whether a signed-in uploader passes a drop point's per-user allowlist. An empty
 * list is open to anyone; otherwise the caller must be signed in and their email
 * or username must appear in the list. Enforced before any upload is accepted.
 */
export async function fileRequestUserAllowed(
    allowedUsersJson: string,
    userId: string | null
): Promise<boolean> {
    const allowed = parseStringArray(allowedUsersJson);
    if (allowed.length === 0) return true;
    if (!userId) return false;
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, username: true }
    });
    if (!user) return false;
    return userAllowedForRequest(user, allowed);
}

/** Constant-time PIN/password check. No password set means always open. */
export async function verifyFileRequestPassword(
    passwordHash: string | null,
    presented: string
): Promise<boolean> {
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
export function verifyFileRequestUnlock(
    requestId: string,
    value: string | undefined,
    secret: string
): boolean {
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
        return Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === "string")
            : [];
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

/** One submission's ownership/timing, scoped to its request, or null. */
export async function getSubmission(requestId: string, submissionId: string) {
    return prisma.fileRequestSubmission.findFirst({
        where: { id: submissionId, requestId },
        select: { id: true, submittedByUserId: true, at: true, fileName: true }
    });
}

/**
 * Delete a submission's stored bytes and its record. Scoped to the request so a
 * caller cannot reach another drop point's files. Byte deletion is best-effort
 * (a missing file still clears the record). Returns false if nothing matched.
 */
export async function deleteSubmission(requestId: string, submissionId: string): Promise<boolean> {
    const submission = await prisma.fileRequestSubmission.findFirst({
        where: { id: submissionId, requestId },
        select: {
            id: true,
            storedPath: true,
            request: { select: { destinationConnectionId: true } }
        }
    });
    if (!submission) return false;
    const driver = await getDriverForConnection(submission.request.destinationConnectionId);
    try {
        await driver.delete(normalizeRelPath(submission.storedPath)).catch(() => undefined);
    } finally {
        await driver.dispose();
    }
    await prisma.fileRequestSubmission.delete({ where: { id: submission.id } });
    return true;
}

/** Delete a submission only if the caller owns its drop point. */
export async function deleteSubmissionForOwner(
    ownerId: string,
    requestId: string,
    submissionId: string
): Promise<boolean> {
    const owns = await prisma.fileRequest.count({ where: { id: requestId, ownerId } });
    if (owns === 0) return false;
    return deleteSubmission(requestId, submissionId);
}

/** Sign a per-submission delete token so an anonymous uploader can remove their file. */
export function signSubmissionDelete(submissionId: string, secret: string): string {
    return createHmac("sha256", secret).update(`drop-del:${submissionId}`).digest("base64url");
}

/** Constant-time check of a submission delete token against the expected value. */
export function verifySubmissionDelete(
    submissionId: string,
    value: string | undefined,
    secret: string
): boolean {
    if (!value) return false;
    const expected = Buffer.from(signSubmissionDelete(submissionId, secret));
    const presented = Buffer.from(value);
    if (expected.length !== presented.length) return false;
    return timingSafeEqual(presented, expected);
}

/** Cookie grouping a browser's visits/uploads to one drop point (opaque id). */
export function fileRequestVisitCookie(requestId: string): string {
    return `polaris_dropvisit_${requestId}`;
}

/**
 * Upsert a visitor session: create it on first sight, otherwise bump lastSeenAt
 * (and refresh IP/user when newly known). Powers the owner's Visitors view and
 * the connected-duration figure.
 */
export async function recordVisit(entry: {
    requestId: string;
    visitorKey: string;
    ip?: string | null;
    userId?: string | null;
    userAgent?: string | null;
}): Promise<void> {
    const now = new Date();
    const ipHash = entry.ip
        ? createHash("sha256").update(entry.ip).digest("hex").slice(0, 16)
        : null;
    await prisma.fileRequestVisit.upsert({
        where: {
            requestId_visitorKey: { requestId: entry.requestId, visitorKey: entry.visitorKey }
        },
        create: {
            requestId: entry.requestId,
            visitorKey: entry.visitorKey,
            ip: entry.ip ?? null,
            ipHash,
            userId: entry.userId ?? null,
            userAgent: entry.userAgent ?? null,
            firstSeenAt: now,
            lastSeenAt: now
        },
        update: {
            lastSeenAt: now,
            ...(entry.ip ? { ip: entry.ip, ipHash } : {}),
            ...(entry.userId ? { userId: entry.userId } : {})
        }
    });
}

/** Mark that the given browser session uploaded a file (for the "uploaded?" column). */
export async function bumpVisitUpload(requestId: string, visitorKey: string): Promise<void> {
    await prisma.fileRequestVisit.updateMany({
        where: { requestId, visitorKey },
        data: { uploadCount: { increment: 1 }, lastSeenAt: new Date() }
    });
}

/** Visitor sessions for a drop point (owner-scoped), most-recently-seen first. */
export async function listVisitsForRequest(ownerId: string, requestId: string, limit = 200) {
    const owns = await prisma.fileRequest.count({ where: { id: requestId, ownerId } });
    if (owns === 0) return [];
    return prisma.fileRequestVisit.findMany({
        where: { requestId },
        orderBy: { lastSeenAt: "desc" },
        take: limit,
        select: {
            id: true,
            ip: true,
            userId: true,
            userAgent: true,
            uploadCount: true,
            firstSeenAt: true,
            lastSeenAt: true
        }
    });
}

/** Create a personal drop-point config template; returns its id. */
export async function createTemplate(
    ownerId: string,
    name: string,
    config: string
): Promise<{ id: string }> {
    return prisma.dropPointTemplate.create({
        data: { ownerId, name, config },
        select: { id: true }
    });
}

/** All of a user's saved templates, newest first. */
export async function listTemplates(ownerId: string) {
    return prisma.dropPointTemplate.findMany({
        where: { ownerId },
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, config: true, createdAt: true }
    });
}

/** One of a user's templates by id, or null. */
export async function getTemplate(ownerId: string, id: string) {
    return prisma.dropPointTemplate.findFirst({
        where: { id, ownerId },
        select: { id: true, name: true, config: true }
    });
}

/** Delete a user's template. Owner-scoped and idempotent. */
export async function deleteTemplate(ownerId: string, id: string): Promise<void> {
    await prisma.dropPointTemplate.deleteMany({ where: { id, ownerId } });
}
