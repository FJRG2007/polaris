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
import { createApiKey, deleteApiKey, revokeApiKey, scopesAvailableTo, updateApiKey } from "@polaris/auth";
import { createApiKeySchema, updateApiKeySchema } from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { requireUser } from "@/lib/session";
import { newDeviceRefusal } from "@/lib/device-grace";

export async function createApiKeyAction(
    input: unknown
): Promise<{ secret?: string; prefix?: string; error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
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

/**
 * Change a key that already exists - everything except the secret.
 *
 * The same scope check as creating one, and for the same reason: a key must
 * never carry more than its owner holds, and an edit is the obvious way to try
 * to give it more. What the dialog offered is not what is trusted.
 */
export async function updateApiKeyAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = updateApiKeySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

    const allowed = new Set(await scopesAvailableTo(user.id, user.isAdmin));
    const scopes = parsed.data.scopes.filter((scope) => allowed.has(scope));
    if (scopes.length === 0) return { error: "You do not hold any of the permissions you picked." };

    await updateApiKey(user.id, { ...parsed.data, scopes });
    await recordAudit({
        actorId: user.id,
        action: "account.api-key.updated",
        targetType: "apiKey",
        targetId: parsed.data.id,
        metadata: { scopes }
    });
    revalidatePath("/account/api-keys");
    return {};
}

export async function revokeApiKeyAction(id: string): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
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
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
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
