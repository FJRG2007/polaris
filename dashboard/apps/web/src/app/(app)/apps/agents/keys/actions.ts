"use server";

/**
 * The provider keys one account brought itself.
 *
 * Every action here works on the signed-in person's own row and nobody else's -
 * the provider comes from the form, the account never does. A key is write-only
 * from the moment it is saved: no action reads one back, so a screen cannot leak
 * one and neither can a mistake in one.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { readGatewayConfig } from "@/lib/integrations/registry";
import {
    deleteUserModelKey,
    instanceKeysAreShared,
    isStorableProvider,
    keySourcesFor,
    listUserModelKeys,
    saveUserModelKey,
    type KeySource,
    type UserModelKeyView
} from "@/lib/agents/user-model-keys";

const KEYS_PATH = "/apps/agents/keys";

/** A gateway needs more than a key: an endpoint, a model, and the two limits an
 *  OpenAI-compatible endpoint publishes no catalogue for. */
const gatewayConfigSchema = z.object({
    baseUrl: z.string().trim().url().max(500),
    model: z.string().trim().min(1).max(200),
    context: z.number().int().min(0).max(100_000_000),
    maxOutput: z.number().int().min(0).max(100_000_000)
});

const saveSchema = z.object({
    provider: z.string().trim().min(1).max(60),
    // Providers do not agree on a shape, so this checks that something was
    // pasted rather than what it is. What proves a key works is a run.
    secret: z.string().trim().min(8).max(500),
    config: gatewayConfigSchema.optional()
});

/** What this account has, and what it would fall back to. */
export async function loadModelKeysAction(): Promise<{
    keys: UserModelKeyView[];
    sources: Array<[string, KeySource]>;
    shared: boolean;
}> {
    const user = await requirePermission("agents.read");
    const [keys, sources, shared] = await Promise.all([
        listUserModelKeys(user.id),
        keySourcesFor(user.id),
        instanceKeysAreShared()
    ]);
    return { keys, sources: [...sources.entries()], shared };
}

export async function saveModelKeyAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the key" };
    if (!isStorableProvider(parsed.data.provider)) return { error: "That is not a model provider." };

    await saveUserModelKey(
        user.id,
        parsed.data.provider,
        parsed.data.secret,
        // Through the same reader the deployment's gateway config goes through, so
        // one shape is stored whichever screen wrote it, then widened to the plain
        // object the store keeps.
        parsed.data.config ? { ...readGatewayConfig(parsed.data.config) } : undefined
    );
    // The provider is recorded, never the key or any part of it: an audit row is
    // read by more people than the credential ever should be.
    await recordAudit({
        actorId: user.id,
        action: "agents.key.save",
        targetType: "modelProvider",
        targetId: parsed.data.provider
    });
    revalidatePath(KEYS_PATH);
    return {};
}

export async function deleteModelKeyAction(input: unknown): Promise<{ error?: string }> {
    const user = await requirePermission("agents.manage");
    const parsed = z.object({ provider: z.string().trim().min(1).max(60) }).safeParse(input);
    if (!parsed.success) return { error: "Pick a provider" };

    await deleteUserModelKey(user.id, parsed.data.provider);
    await recordAudit({
        actorId: user.id,
        action: "agents.key.delete",
        targetType: "modelProvider",
        targetId: parsed.data.provider
    });
    revalidatePath(KEYS_PATH);
    return {};
}
