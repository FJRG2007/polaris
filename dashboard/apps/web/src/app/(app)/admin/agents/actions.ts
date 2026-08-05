"use server";

/**
 * The deployment's Agents defaults. Admin-only: this is what every account's own
 * settings fall through to, so the change is audited like any other platform
 * setting.
 */

import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { agentDefaultsSchema } from "@polaris/core";
import type { PickerModel } from "@/components/model-picker";
import { savePlatformAgentDefaults } from "@/lib/agents/agent-defaults-service";
import { connectedProviders, MODEL_PROVIDERS, providerForModel } from "@/lib/agents/agent-providers";
import { catalogRefreshedAt, listCatalogModels, refreshModelCatalog } from "@/lib/agents/model-catalog";

/** The same list the accounts' own screens get, read through the admin gate.
 *  Kept apart rather than imported from the app's actions so /admin never
 *  borrows a permission it does not have. */
export async function platformModelChoices(): Promise<PickerModel[]> {
    await requireAdmin();
    const providers = await connectedProviders();
    const prefixes = MODEL_PROVIDERS.filter((provider) => providers.includes(provider.slug)).map(
        (provider) => provider.modelPrefix
    );
    if (prefixes.length === 0) return [];
    const models = await listCatalogModels(prefixes);
    return models.map((model) => ({
        slug: model.slug,
        provider: model.provider,
        name: model.name,
        contextTokens: model.contextTokens,
        reasoning: model.reasoning,
        costInput: model.costInput
    }));
}

/**
 * Fetch the model catalogue now.
 *
 * It refreshes itself daily, so this is for the two cases where waiting is the
 * wrong answer: a deployment that has just come online and has an empty
 * catalogue, and a model released today that somebody wants to pick.
 */
export async function refreshModelCatalogAction(): Promise<{ models?: number; at?: string; error?: string }> {
    const admin = await requireAdmin();
    const result = await refreshModelCatalog();
    if (!result.ok) return { error: result.error ?? "The catalogue could not be read." };
    await recordAudit({
        actorId: admin.id,
        action: "agents.catalog.refresh",
        metadata: { models: result.models }
    });
    revalidatePath("/admin/agents");
    return { models: result.models, at: (await catalogRefreshedAt())?.toISOString() };
}

export async function savePlatformAgentDefaultsAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = agentDefaultsSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the settings" };

    // Same refusal as the per-person tiers, and it matters more here: a model
    // whose provider has no stored key would produce runs that start, ask for
    // one and fail, on every repository in the deployment that inherits it.
    if (parsed.data.model) {
        const provider = providerForModel(parsed.data.model);
        if (provider && !(await connectedProviders()).includes(provider.slug)) {
            return { error: `Connect ${provider.name} under Integrations before defaulting to this model.` };
        }
    }

    // A pool from a form is a claim. Unlike the per-person tiers there is no
    // owner to check it against, so it only has to exist and be enabled - which
    // is what stops a deleted pool being left as the deployment's default.
    if (parsed.data.poolId) {
        const pool = await prisma.runnerPool.findFirst({
            where: { id: parsed.data.poolId, enabled: true },
            select: { id: true }
        });
        if (!pool) return { error: "That runner pool no longer exists." };
    }

    await savePlatformAgentDefaults(parsed.data);
    await recordAudit({ actorId: admin.id, action: "admin.agents.defaults.updated" });
    revalidatePath("/admin/agents");
    revalidatePath("/apps/agents/settings");
    return {};
}
