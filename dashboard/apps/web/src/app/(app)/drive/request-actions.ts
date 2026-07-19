"use server";

/**
 * File-request server actions. Creating and revoking a request are metadata
 * mutations, so they live in Server Actions; the anonymous byte-receiving upload
 * path is a public Route Handler. Every action re-resolves the session and
 * re-validates its input with the shared Zod schema before touching the database.
 */

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { loadEnv } from "@polaris/config";
import { createFileRequestSchema } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import {
    createFileRequest,
    fileRequestUnlockCookie,
    fileRequestUsability,
    resolveFileRequestByToken,
    revokeFileRequest,
    signFileRequestUnlock,
    verifyFileRequestPassword
} from "@/lib/file-request-service";
import { rateLimit, resetRateLimit } from "@/lib/rate-limit-service";
import { clientIp, hashForLog } from "@/lib/request-context";
import { recordAudit } from "@/lib/audit-service";

/** Create a file request and return the absolute link to hand out (once). */
export async function createFileRequestAction(input: unknown): Promise<{ url?: string; error?: string }> {
    const user = await requirePermission("requests.create");
    const parsed = createFileRequestSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request" };
    const { id, token } = await createFileRequest(user.id, parsed.data);
    await recordAudit({
        actorId: user.id,
        action: "request.create",
        targetType: "fileRequest",
        targetId: id,
        metadata: {
            destinationConnectionId: parsed.data.destinationConnectionId,
            destinationPath: parsed.data.destinationPath,
            requireLogin: parsed.data.requireLogin
        }
    });
    revalidatePath("/requests");
    return { url: `${loadEnv().POLARIS_APP_URL}/r/${token}` };
}

/**
 * Public action: verify a drop point's PIN and, on success, set an unforgeable
 * httpOnly cookie so the upload page and route skip the prompt. Rate-limited per
 * request + IP to throttle guessing; the failure message is generic.
 */
export async function unlockFileRequestAction(token: string, password: string): Promise<{ error?: string }> {
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
    store.set(fileRequestUnlockCookie(request.id), signFileRequestUnlock(request.id, env.POLARIS_AUTH_SECRET), {
        httpOnly: true,
        sameSite: "lax",
        secure: env.POLARIS_SECURE_COOKIES,
        path: "/",
        maxAge: 60 * 60 * 12
    });
    return {};
}

/** Revoke a file request the caller owns. Owner-scoped, so IDOR is impossible. */
export async function revokeFileRequestAction(requestId: string): Promise<void> {
    const user = await requirePermission("requests.create");
    await revokeFileRequest(user.id, requestId);
    await recordAudit({ actorId: user.id, action: "request.revoke", targetType: "fileRequest", targetId: requestId });
    revalidatePath("/requests");
}
