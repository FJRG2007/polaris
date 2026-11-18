"use server";

import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";
import { catalogRefreshedAt } from "@/lib/agents/model-catalog";
import { providerIndexState } from "@/lib/integrations/provider-catalog";
import { listUsageLimits } from "@/lib/agents/agent-usage-limits";
import { getPlatformAgentDefaults } from "@/lib/agents/agent-defaults-service";
import { connectedProviders, instanceKeysAreShared } from "@/lib/agents/model-keys";

/** Everything the agent defaults screen shows, asked for after the paint. */
export async function loadAgentsAdminAction() {
    await requireAdmin();
    const [platform, pools, providers, catalogModels, catalogAt, keysShared, limits, providerIndex] =
        await Promise.all([
            getPlatformAgentDefaults(),
            prisma.runnerPool.findMany({
                where: { enabled: true },
                select: { id: true, name: true },
                orderBy: { name: "asc" }
            }),
            connectedProviders(),
            prisma.agentModel.count(),
            catalogRefreshedAt(),
            instanceKeysAreShared(),
            listUsageLimits(),
            providerIndexState()
        ]);
    return {
        platform,
        pools,
        providers,
        catalogModels,
        catalogAt: catalogAt?.toISOString() ?? null,
        providerIndex,
        keysShared,
        limits
    };
}
