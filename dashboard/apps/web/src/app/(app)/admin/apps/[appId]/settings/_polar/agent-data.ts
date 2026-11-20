/**
 * What Polar's deployment-wide agent settings show: the usage limits and the
 * defaults every repository and Code session falls through to. Read for an
 * administrator only.
 */

import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";
import { listUsageLimits } from "@/lib/agents/agent-usage-limits";
import { getPlatformAgentDefaults } from "@/lib/agents/agent-defaults-service";
import { connectedProviders } from "@/lib/agents/model-keys";

export async function polarAgentAdmin() {
    await requireAdmin();
    const [platform, pools, providers, limits] = await Promise.all([
        getPlatformAgentDefaults(),
        prisma.runnerPool.findMany({
            where: { enabled: true },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        }),
        connectedProviders(),
        listUsageLimits()
    ]);
    return { platform, pools, providers, limits };
}
