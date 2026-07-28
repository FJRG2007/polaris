"use server";

/**
 * API key actions. A key is a credential, so creation is the only path that ever
 * returns a secret and it does so exactly once - nothing here can read an
 * existing key back.
 *
 * Scopes are re-checked against what the caller actually holds: the dialog only
 * offers permissions the user has, but the server is what enforces that a key
 * cannot be minted with more reach than its owner.
 */

import { revalidatePath } from "next/cache";
import { createApiKey, deleteApiKey, revokeApiKey, scopesAvailableTo } from "@polaris/auth";
import { createApiKeySchema } from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { requireUser } from "@/lib/session";

export async function createApiKeyAction(
    input: unknown
): Promise<{ secret?: string; prefix?: string; error?: string }> {
    const user = await requireUser();
    const parsed = createApiKeySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

    const allowed = new Set(await scopesAvailableTo(user.id, user.isAdmin));
    const scopes = parsed.data.scopes.filter((scope) => allowed.has(scope));
    if (scopes.length === 0) return { error: "You do not hold any of the permissions you picked." };

    const created = await createApiKey(user.id, { ...parsed.data, scopes });
    await recordAudit({
        actorId: user.id,
        action: "account.api-key.created",
        targetType: "apiKey",
        targetId: created.id,
        metadata: { scopes }
    });
    revalidatePath("/account/api-keys");
    return { secret: created.secret, prefix: created.prefix };
}

export async function revokeApiKeyAction(id: string): Promise<{ error?: string }> {
    const user = await requireUser();
    await revokeApiKey(user.id, String(id));
    await recordAudit({
        actorId: user.id,
        action: "account.api-key.revoked",
        targetType: "apiKey",
        targetId: String(id)
    });
    revalidatePath("/account/api-keys");
    return {};
}

export async function deleteApiKeyAction(id: string): Promise<{ error?: string }> {
    const user = await requireUser();
    await deleteApiKey(user.id, String(id));
    await recordAudit({
        actorId: user.id,
        action: "account.api-key.deleted",
        targetType: "apiKey",
        targetId: String(id)
    });
    revalidatePath("/account/api-keys");
    return {};
}
