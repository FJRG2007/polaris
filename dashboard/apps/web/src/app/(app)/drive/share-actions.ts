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
import { createShareSchema } from "@polaris/core";
import { requirePermission } from "@/lib/session";
import {
    createShare,
    resolveShareByToken,
    revokeShare,
    shareUnlockCookie,
    shareUsability,
    signShareUnlock,
    verifySharePassword
} from "@/lib/share-service";
import { recordAudit } from "@/lib/audit-service";

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
    revalidatePath("/shared");
    return { url: `${loadEnv().POLARIS_APP_URL}/s/${token}` };
}

/** Revoke a share the caller owns. Owner-scoped, so it cannot touch others'. */
export async function revokeShareAction(shareId: string): Promise<void> {
    const user = await requirePermission("shares.create");
    await revokeShare(user.id, shareId);
    await recordAudit({ actorId: user.id, action: "share.revoke", targetType: "share", targetId: shareId });
    revalidatePath("/shared");
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
    if (!(await verifySharePassword(share.passwordHash, password))) {
        return { error: "Incorrect password." };
    }
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
