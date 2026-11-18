"use server";

/**
 * The AI provider keys the deployment itself holds.
 *
 * The gate, and nothing else: a key here is spent by anybody the administrator
 * shares it with, so every action establishes an administrator first and then
 * hands the writes the deployment's own rows. The writes are the same ones an
 * account's screen uses, which is what keeps a credential stored here checked
 * exactly as carefully as one somebody brings themselves.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import {
    addCustomProvider,
    listCustomProviders,
    removeCustomProvider,
    type CustomProviderRefusal,
    type CustomProviderView
} from "@/lib/integrations/provider-catalog";
import { instanceScope } from "./scope";
import {
    addKey,
    editKey,
    limitKey,
    removeKey,
    reorderKeys,
    reviveKey,
    toggleKey,
    type KeyActionResult
} from "@/lib/agents/model-key-actions";

const scope = instanceScope;

export async function addInstanceModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return addKey(await scope(), input);
}

export async function updateInstanceModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return editKey(await scope(), input);
}

export async function deleteInstanceModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return removeKey(await scope(), input);
}

export async function reorderInstanceModelKeysAction(input: unknown): Promise<KeyActionResult> {
    return reorderKeys(await scope(), input);
}

export async function toggleInstanceModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return toggleKey(await scope(), input);
}

export async function limitInstanceModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return limitKey(await scope(), input);
}

export async function reviveInstanceModelKeyAction(input: unknown): Promise<KeyActionResult> {
    return reviveKey(await scope(), input);
}

// ---------------------------------------------------------------------------
// Operator-added providers
// ---------------------------------------------------------------------------

/** Why an add or a remove was refused: the dialog words each one. */
export type CustomProviderActionResult =
    | { ok: true; provider: CustomProviderView }
    | { ok: false; reason: CustomProviderRefusal | "failed" };

/** Store an OpenAI- or Anthropic-compatible endpoint as a provider. */
export async function addCustomProviderAction(input: unknown): Promise<CustomProviderActionResult> {
    const admin = await requireAdmin();
    try {
        const result = await addCustomProvider(input, admin.id);
        if (!result.ok) return result;
        const provider = (await listCustomProviders()).find((row) => row.slug === result.slug);
        if (!provider) return { ok: false, reason: "failed" };
        await recordAudit({
            actorId: admin.id,
            action: "integrations.provider.add",
            targetType: "modelProvider",
            targetId: provider.slug,
            metadata: { name: provider.name, wire: provider.wire }
        });
        revalidatePath("/admin/integrations/models");
        return { ok: true, provider };
    } catch (error) {
        console.error("polaris: custom provider not stored", error);
        return { ok: false, reason: "failed" };
    }
}

const removeSchema = z.object({ slug: z.string().trim().min(1).max(80) });

/** Remove an operator-added provider. Its stored keys stay, unusable, until removed. */
export async function removeCustomProviderAction(
    input: unknown
): Promise<{ ok: true } | { ok: false; reason: "invalid" | "failed" }> {
    const admin = await requireAdmin();
    const parsed = removeSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    try {
        if (!(await removeCustomProvider(parsed.data.slug))) return { ok: false, reason: "invalid" };
        await recordAudit({
            actorId: admin.id,
            action: "integrations.provider.remove",
            targetType: "modelProvider",
            targetId: parsed.data.slug
        });
        revalidatePath("/admin/integrations/models");
        return { ok: true };
    } catch (error) {
        console.error("polaris: custom provider not removed", error);
        return { ok: false, reason: "failed" };
    }
}
