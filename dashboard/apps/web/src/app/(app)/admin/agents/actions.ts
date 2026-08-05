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
import { savePlatformAgentDefaults } from "@/lib/agents/agent-defaults-service";
import { connectedProviders, providerForModel } from "@/lib/agents/agent-providers";

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
