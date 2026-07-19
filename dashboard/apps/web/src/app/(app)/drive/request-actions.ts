"use server";

/**
 * File-request server actions. Creating and revoking a request are metadata
 * mutations, so they live in Server Actions; the anonymous byte-receiving upload
 * path is a public Route Handler. Every action re-resolves the session and
 * re-validates its input with the shared Zod schema before touching the database.
 */

import { revalidatePath } from "next/cache";
import { loadEnv } from "@polaris/config";
import { createFileRequestSchema } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import { createFileRequest, revokeFileRequest } from "@/lib/file-request-service";
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

/** Revoke a file request the caller owns. Owner-scoped, so IDOR is impossible. */
export async function revokeFileRequestAction(requestId: string): Promise<void> {
    const user = await requirePermission("requests.create");
    await revokeFileRequest(user.id, requestId);
    await recordAudit({ actorId: user.id, action: "request.revoke", targetType: "fileRequest", targetId: requestId });
    revalidatePath("/requests");
}
