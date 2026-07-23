"use server";

/**
 * File-request server actions. Creating and revoking a request are metadata
 * mutations, so they live in Server Actions; the anonymous byte-receiving upload
 * path is a public Route Handler. Every action re-resolves the session and
 * re-validates its input with the shared Zod schema before touching the database.
 */

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { loadEnv } from "@polaris/config";
import { sharingBaseUrl } from "@/lib/domain-service";
import { ensureShareReachability } from "@/lib/public-reach";
import { cidrOrIp, createFileRequestSchema, normalizeRelPath, randomDropPointName } from "@polaris/core";
import type { StorageDriver } from "@polaris/storage";
import { requirePermission } from "@/lib/session";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import { getDriverForConnection, SmbShareRequiredError } from "@/lib/storage-service";
import {
    createFileRequest,
    createTemplate,
    deleteSubmissionForOwner,
    deleteTemplate,
    fileRequestUnlockCookie,
    fileRequestUsability,
    listTemplates,
    reopenFileRequest,
    resolveFileRequestByToken,
    revokeFileRequest,
    signFileRequestUnlock,
    updateFileRequest,
    verifyFileRequestPassword
} from "@/lib/file-request-service";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { clientIp, hashForLog } from "@/lib/request-context";
import { recordAudit } from "@/lib/audit-service";

/** The shared base folder every drop point's own folder is grouped under. */
const DROP_POINTS_BASE = "Drop Points";

/** Turn a drop-point title into a safe, readable folder name. */
function folderNameFromTitle(title: string): string {
    const cleaned = title
        .replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned.slice(0, 80) || "Drop point";
}

/** Whether a path exists on a driver (stat succeeds). */
async function pathExists(driver: StorageDriver, path: string): Promise<boolean> {
    try {
        await driver.stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Create the drop point's own folder under a shared "Drop Points" base on the
 * destination connection, and return its normalized path. Every drop point
 * collects into its own folder, so uploads never mix and are easy to find. The
 * chosen destination acts as the parent; a name collision gets a numeric suffix.
 */
async function prepareDropPointFolder(
    userId: string,
    connectionId: string,
    parentPath: string,
    title: string
): Promise<string> {
    const parent = normalizeRelPath(parentPath);
    await authorizeDrive(userId, connectionId, parent, "write");
    const base = normalizeRelPath(parent ? `${parent}/${DROP_POINTS_BASE}` : DROP_POINTS_BASE);
    const driver = await getDriverForConnection(connectionId);
    try {
        try {
            await driver.mkdir(base);
        } catch {
            // The base folder already exists (or the backend creates parents
            // implicitly); either way it is ready to hold the drop-point folder.
        }
        const wanted = folderNameFromTitle(title);
        let name = wanted;
        for (
            let index = 2;
            index < 1000 && (await pathExists(driver, normalizeRelPath(`${base}/${name}`)));
            index++
        ) {
            name = `${wanted} (${index})`;
        }
        const finalPath = normalizeRelPath(`${base}/${name}`);
        await driver.mkdir(finalPath);
        return finalPath;
    } finally {
        await driver.dispose();
    }
}

/** Create a file request and return the absolute link to hand out (once). */
export async function createFileRequestAction(
    input: unknown
): Promise<{ url?: string; error?: string }> {
    const user = await requirePermission("requests.create");
    const parsed = createFileRequestSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request" };

    // A blank title gets a generated name; resolve it once so the drop point's
    // folder and its stored title match.
    const title = (parsed.data.title ?? "").trim() || randomDropPointName();

    // Give the drop point its own folder under a shared "Drop Points" base on the
    // destination, so uploads are organized per drop point rather than mixed in.
    let destinationPath: string;
    try {
        destinationPath = await prepareDropPointFolder(
            user.id,
            parsed.data.destinationConnectionId,
            parsed.data.destinationPath,
            title
        );
    } catch (caught) {
        if (caught instanceof DriveAccessError)
            return { error: "You cannot collect uploads into that folder" };
        if (caught instanceof DriveLockedError) return { error: "That folder is locked" };
        if (caught instanceof SmbShareRequiredError)
            return { error: "Set up the connection's share first" };
        return {
            error:
                caught instanceof Error ? caught.message : "Could not prepare the drop-point folder"
        };
    }

    const { id, token } = await createFileRequest(user.id, {
        ...parsed.data,
        title,
        destinationPath
    });
    await recordAudit({
        actorId: user.id,
        action: "request.create",
        targetType: "fileRequest",
        targetId: id,
        metadata: {
            destinationConnectionId: parsed.data.destinationConnectionId,
            destinationPath,
            requireLogin: parsed.data.requireLogin
        }
    });
    // Behind NAT with no public domain, raise a Cloudflare tunnel so the link works.
    await ensureShareReachability();
    revalidatePath("/drive/drop-points");
    return { url: `${await sharingBaseUrl()}/r/${token}` };
}

/** Validated shape of an edit to a drop point's guardrails (owner-only). */
const updateDropPointSchema = z.object({
    title: z.string().trim().min(1).max(200).optional(),
    instructions: z.string().trim().max(2000).nullable().optional(),
    requireLogin: z.boolean().optional(),
    password: z.string().nullable().optional(),
    maxSizeBytes: z.number().int().positive().optional(),
    minSizeBytes: z.number().int().nonnegative().nullable().optional(),
    maxFiles: z.number().int().positive().nullable().optional(),
    allowedExtensions: z.array(z.string().trim().toLowerCase()).optional(),
    deniedExtensions: z.array(z.string().trim().toLowerCase()).optional(),
    allowedMimeTypes: z.array(z.string().trim()).optional(),
    allowedCidrs: z.array(cidrOrIp).optional(),
    allowedCountries: z
        .array(
            z
                .string()
                .trim()
                .toUpperCase()
                .regex(/^[A-Z]{2}$/)
        )
        .optional(),
    allowedContinents: z
        .array(
            z
                .string()
                .trim()
                .toUpperCase()
                .regex(/^[A-Z]{2}$/)
        )
        .optional(),
    allowedUsers: z
        .array(z.string().trim().toLowerCase())
        .transform((values) =>
            Array.from(new Set(values.map((value) => value.replace(/^@+/, "")).filter(Boolean)))
        )
        .optional(),
    startsAt: z.string().nullable().optional(),
    allowUploaderDelete: z.boolean().optional(),
    uploaderDeleteWindowSeconds: z.number().int().nonnegative().nullable().optional(),
    expiresAt: z.string().nullable().optional()
})
    .refine(
        (value) =>
            value.minSizeBytes == null ||
            value.maxSizeBytes === undefined ||
            value.minSizeBytes <= value.maxSizeBytes,
        { message: "Minimum size cannot exceed the maximum size", path: ["minSizeBytes"] }
    )
    .refine(
        (value) =>
            !value.startsAt ||
            !value.expiresAt ||
            new Date(value.startsAt) < new Date(value.expiresAt),
        { message: "Start time must be before the expiry time", path: ["startsAt"] }
    );

/** Update a drop point's limits/config. Owner-scoped; destination folder stays fixed. */
export async function updateFileRequestAction(
    requestId: string,
    input: unknown
): Promise<{ error?: string }> {
    const user = await requirePermission("requests.create");
    const parsed = updateDropPointSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid changes" };

    const { expiresAt, startsAt, ...rest } = parsed.data;
    await updateFileRequest(user.id, requestId, {
        ...rest,
        // A date string sets the time, `null` clears it, `undefined` leaves it.
        startsAt: startsAt === undefined ? undefined : startsAt ? new Date(startsAt) : null,
        expiresAt: expiresAt === undefined ? undefined : expiresAt ? new Date(expiresAt) : null
    });
    await recordAudit({
        actorId: user.id,
        action: "request.update",
        targetType: "fileRequest",
        targetId: requestId
    });
    revalidatePath("/drive/drop-points");
    revalidatePath(`/drive/drop-points/${requestId}`);
    return {};
}

/** Reopen a closed drop point the caller owns so it accepts uploads again. Owner-scoped. */
export async function reopenFileRequestAction(requestId: string): Promise<void> {
    const user = await requirePermission("requests.create");
    await reopenFileRequest(user.id, requestId);
    await recordAudit({
        actorId: user.id,
        action: "request.reopen",
        targetType: "fileRequest",
        targetId: requestId
    });
    revalidatePath("/drive/drop-points");
    revalidatePath(`/drive/drop-points/${requestId}`);
}

/**
 * Public action: verify a drop point's PIN and, on success, set an unforgeable
 * httpOnly cookie so the upload page and route skip the prompt. Rate-limited per
 * request + IP to throttle guessing; the failure message is generic.
 */
export async function unlockFileRequestAction(
    token: string,
    password: string
): Promise<{ error?: string }> {
    const request = await resolveFileRequestByToken(token);
    if (!request) return { error: "This link is not available." };
    if (!fileRequestUsability(request).ok) return { error: "This link is no longer available." };

    const limitKey = `drop-unlock:${request.id}:${hashForLog(await clientIp()) ?? "unknown"}`;
    if (!(await rateLimit(limitKey, 10, 15 * 60 * 1000)).ok) {
        return { error: "Too many attempts. Please wait a few minutes and try again." };
    }

    if (!(await verifyFileRequestPassword(request.passwordHash, password))) {
        return { error: "Incorrect PIN." };
    }
    await resetRateLimit(limitKey);

    const env = loadEnv();
    const store = await cookies();
    store.set(
        fileRequestUnlockCookie(request.id),
        signFileRequestUnlock(request.id, env.POLARIS_AUTH_SECRET),
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

/** Revoke a file request the caller owns. Owner-scoped, so IDOR is impossible. */
export async function revokeFileRequestAction(requestId: string): Promise<void> {
    const user = await requirePermission("requests.create");
    await revokeFileRequest(user.id, requestId);
    await recordAudit({
        actorId: user.id,
        action: "request.revoke",
        targetType: "fileRequest",
        targetId: requestId
    });
    revalidatePath("/drive/drop-points");
    revalidatePath(`/drive/drop-points/${requestId}`);
}

/** Delete a collected file. Owner-scoped: only the drop point's owner may call it. */
export async function deleteSubmissionAction(
    requestId: string,
    submissionId: string
): Promise<{ error?: string }> {
    const user = await requirePermission("requests.create");
    const ok = await deleteSubmissionForOwner(user.id, requestId, submissionId);
    if (!ok) return { error: "That file no longer exists." };
    await recordAudit({
        actorId: user.id,
        action: "request.submission.delete",
        targetType: "fileRequest",
        targetId: requestId,
        metadata: { submissionId }
    });
    revalidatePath(`/drive/drop-points/${requestId}`);
    return {};
}

/** Fields a drop-point config template may carry (guardrails only; no destination). */
const templateConfigSchema = z
    .object({
        instructions: z.string().optional(),
        allowedExtensions: z.array(z.string()).optional(),
        deniedExtensions: z.array(z.string()).optional(),
        allowedMimeTypes: z.array(z.string()).optional(),
        minSizeBytes: z.number().int().nonnegative().optional(),
        maxSizeBytes: z.number().int().positive().optional(),
        maxFiles: z.number().int().positive().optional(),
        requireLogin: z.boolean().optional(),
        allowedUsers: z.array(z.string()).optional(),
        allowedCidrs: z.array(cidrOrIp).optional(),
        allowedCountries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).optional(),
        allowedContinents: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).optional(),
        allowUploaderDelete: z.boolean().optional(),
        uploaderDeleteWindowSeconds: z.number().int().nonnegative().nullable().optional()
    })
    .strip();

/** Save a reusable drop-point config template for the caller. */
export async function saveDropPointTemplateAction(
    name: string,
    config: unknown
): Promise<{ id?: string; error?: string }> {
    const user = await requirePermission("requests.create");
    const trimmed = name.trim();
    if (!trimmed) return { error: "Name the template." };
    const parsed = templateConfigSchema.safeParse(config);
    if (!parsed.success) return { error: "That template config is invalid." };
    const { id } = await createTemplate(
        user.id,
        trimmed.slice(0, 120),
        JSON.stringify(parsed.data)
    );
    revalidatePath("/drive/drop-points");
    return { id };
}

/** List the caller's saved templates (config is a JSON string of guardrails). */
export async function listDropPointTemplatesAction(): Promise<
    { id: string; name: string; config: string; createdAt: string }[]
> {
    const user = await requirePermission("requests.create");
    const rows = await listTemplates(user.id);
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        config: row.config,
        createdAt: row.createdAt.toISOString()
    }));
}

/** Delete one of the caller's templates. Owner-scoped and idempotent. */
export async function deleteDropPointTemplateAction(id: string): Promise<void> {
    const user = await requirePermission("requests.create");
    await deleteTemplate(user.id, id);
    revalidatePath("/drive/drop-points");
}
