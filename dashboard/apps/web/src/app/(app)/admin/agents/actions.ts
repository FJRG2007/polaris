"use server";

/**
 * The deployment's Agents defaults. Admin-only: this is what every account's own
 * settings fall through to, so the change is audited like any other platform
 * setting.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { agentDefaultsSchema, LIMIT_METRICS, LIMIT_PERIODS, LIMIT_SUBJECTS } from "@polaris/core";
import type { PickerModel } from "@/components/model-picker";
import { setInstanceKeysShared } from "@/lib/agents/user-model-keys";
import { savePlatformAgentDefaults } from "@/lib/agents/agent-defaults-service";
import { connectedProviders, MODEL_PROVIDERS, providerForModel } from "@/lib/agents/agent-providers";
import { catalogRefreshedAt, listCatalogModels, refreshModelCatalog } from "@/lib/agents/model-catalog";
import { deleteUsageLimit, saveUsageLimit } from "@/lib/agents/agent-usage-limits";

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
 * Whether an account with no provider key of its own may run on the
 * deployment's.
 *
 * A decision rather than an assumption: with it on, everybody's runs are billed
 * to the administrator's provider accounts, which is the right answer for a
 * deployment that bought the keys for exactly that and the wrong one for a
 * deployment where each person brings their own. On is the default because it is
 * what every deployment did before there was a choice.
 */
export async function setInstanceKeySharingAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ shared: z.boolean() }).safeParse(input);
    if (!parsed.success) return { error: "Pick a setting" };

    await setInstanceKeysShared(parsed.data.shared);
    await recordAudit({
        actorId: admin.id,
        action: "agents.keys.share",
        metadata: { shared: parsed.data.shared }
    });
    revalidatePath("/admin/agents");
    return {};
}

const limitSchema = z.object({
    subjectType: z.enum(LIMIT_SUBJECTS),
    // Empty only for `everyone`, which is the deployment-wide floor and names
    // nothing. The refine below is what stops a half-filled form storing a rule
    // that matches nobody.
    subjectId: z.string().trim().max(200).default(""),
    metric: z.enum(LIMIT_METRICS),
    period: z.enum(LIMIT_PERIODS),
    // Zero is a real answer - it stops the subject running at all - so the floor
    // is zero rather than one.
    amount: z.number().int().min(0).max(1_000_000_000)
}).refine((value) => value.subjectType === "everyone" || value.subjectId.length > 0, {
    message: "Say who or what the limit is for",
    path: ["subjectId"]
});

export async function saveUsageLimitAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = limitSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the limit" };

    await saveUsageLimit(parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "agents.limit.save",
        targetType: parsed.data.subjectType,
        targetId: parsed.data.subjectId || "everyone",
        metadata: { metric: parsed.data.metric, period: parsed.data.period, amount: parsed.data.amount }
    });
    revalidatePath("/admin/agents");
    return {};
}

export async function deleteUsageLimitAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ id: z.string().uuid() }).safeParse(input);
    if (!parsed.success) return { error: "Pick a limit" };

    await deleteUsageLimit(parsed.data.id);
    await recordAudit({ actorId: admin.id, action: "agents.limit.delete", targetId: parsed.data.id });
    revalidatePath("/admin/agents");
    return {};
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
    if (!result.ok) return { error: result.error ?? "The catalog could not be read." };
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
