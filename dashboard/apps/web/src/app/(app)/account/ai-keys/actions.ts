"use server";

/**
 * The AI provider keys one account brought itself.
 *
 * Every action here works on the signed-in person's own rows and nobody else's -
 * the key comes from the form, the account never does, and every write is scoped
 * by owner so an id from somewhere else touches nothing. A key is write-only from
 * the moment it is saved: no action reads one back, so a screen cannot leak one
 * and neither can a mistake in one.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { readGatewayConfig } from "@/lib/integrations/registry";
import { checkProviderKey } from "@/lib/agents/provider-key-check";
import { createModelKeySchema, reorderModelKeysSchema, updateModelKeySchema } from "@polaris/core";
import {
    createUserModelKey,
    deleteUserModelKey,
    isStorableProvider,
    providerOfUserModelKey,
    reorderUserModelKeys,
    updateUserModelKey
} from "@/lib/agents/user-model-keys";

const KEYS_PATH = "/account/ai-keys";

/** What a write reports back. `warning` is the case that is neither: the key was
 *  stored, and the provider could not be asked whether it is any good. */
export interface KeyActionResult {
    error?: string;
    warning?: string;
}

/** A name already used for this provider is the one collision worth a sentence of
 *  its own - every other write conflict here is a bug, not something to explain. */
function duplicateName(caught: unknown): boolean {
    return typeof caught === "object" && caught !== null && (caught as { code?: string }).code === "P2002";
}

export async function addModelKeyAction(input: unknown): Promise<KeyActionResult> {
    const user = await requireUser();
    const parsed = createModelKeySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the key" };
    if (!isStorableProvider(parsed.data.provider)) return { error: "That is not a model provider." };

    // Asked before it is stored: a key the provider refuses outright is a typo,
    // and storing it would turn that into a failed run somebody has to trace.
    const check = await checkProviderKey(parsed.data.provider, parsed.data.secret);
    if (check.state === "rejected") return { error: check.reason };

    try {
        await createUserModelKey(user.id, {
            provider: parsed.data.provider,
            name: parsed.data.name,
            secret: parsed.data.secret,
            // Through the same reader the deployment's gateway config goes
            // through, so one shape is stored whichever screen wrote it, then
            // widened to the plain object the store keeps.
            config: parsed.data.config ? { ...readGatewayConfig(parsed.data.config) } : undefined
        });
    } catch (caught) {
        if (duplicateName(caught)) return { error: "You already have a key by that name for this provider." };
        throw caught;
    }

    // The provider and the name are recorded, never the key or any part of it:
    // an audit row is read by more people than the credential ever should be.
    await recordAudit({
        actorId: user.id,
        action: "account.ai-key.added",
        targetType: "modelProvider",
        targetId: parsed.data.provider,
        metadata: { name: parsed.data.name }
    });
    revalidatePath(KEYS_PATH);
    return check.state === "unverified" ? { warning: check.reason } : {};
}

export async function updateModelKeyAction(input: unknown): Promise<KeyActionResult> {
    const user = await requireUser();
    const parsed = updateModelKeySchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the key" };

    // Only a key that was actually retyped is checked. A rename should not fail
    // because the provider is having a bad morning.
    let warning: string | undefined;
    if (parsed.data.secret !== undefined) {
        const owner = await providerOfUserModelKey(user.id, parsed.data.id);
        if (!owner) return { error: "That key is gone." };
        const check = await checkProviderKey(owner, parsed.data.secret);
        if (check.state === "rejected") return { error: check.reason };
        if (check.state === "unverified") warning = check.reason;
    }

    let changed: boolean;
    try {
        changed = await updateUserModelKey(user.id, parsed.data.id, {
            name: parsed.data.name,
            secret: parsed.data.secret,
            config: parsed.data.config ? { ...readGatewayConfig(parsed.data.config) } : undefined
        });
    } catch (caught) {
        if (duplicateName(caught)) return { error: "You already have a key by that name for this provider." };
        throw caught;
    }
    if (!changed) return { error: "That key is gone." };

    await recordAudit({
        actorId: user.id,
        action: parsed.data.secret === undefined ? "account.ai-key.renamed" : "account.ai-key.replaced",
        targetType: "modelKey",
        targetId: parsed.data.id,
        metadata: { name: parsed.data.name }
    });
    revalidatePath(KEYS_PATH);
    return warning ? { warning } : {};
}

export async function deleteModelKeyAction(input: unknown): Promise<KeyActionResult> {
    const user = await requireUser();
    const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { error: "Pick a key" };

    if (!(await deleteUserModelKey(user.id, parsed.data.id))) return { error: "That key is gone." };
    await recordAudit({
        actorId: user.id,
        action: "account.ai-key.deleted",
        targetType: "modelKey",
        targetId: parsed.data.id
    });
    revalidatePath(KEYS_PATH);
    return {};
}

/** The order to try them in, as the table now reads top to bottom. */
export async function reorderModelKeysAction(input: unknown): Promise<KeyActionResult> {
    const user = await requireUser();
    const parsed = reorderModelKeysSchema.safeParse(input);
    if (!parsed.success) return { error: "Could not read the new order." };

    await reorderUserModelKeys(user.id, parsed.data.ids);
    revalidatePath(KEYS_PATH);
    return {};
}
