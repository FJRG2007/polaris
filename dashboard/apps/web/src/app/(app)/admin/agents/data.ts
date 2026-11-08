"use server";

import { prisma } from "@polaris/db";
import { requireAdmin } from "@/lib/session";
import { readPolarPolicy } from "@/lib/polar/access";
import { catalogRefreshedAt } from "@/lib/agents/model-catalog";
import { listUsageLimits } from "@/lib/agents/agent-usage-limits";
import { sharedWorkspaceAllowed } from "@/lib/agents/session-capacity";
import { getPlatformAgentDefaults } from "@/lib/agents/agent-defaults-service";
import { connectedProviders, instanceKeysAreShared } from "@/lib/agents/model-keys";

/** How many groups the access card offers as chips; past that it searches. */
const GROUP_CHIPS = 200;

/** Everything the agent defaults screen shows, asked for after the paint. */
export async function loadAgentsAdminAction() {
    await requireAdmin();
    const [
        platform,
        pools,
        providers,
        catalogModels,
        catalogAt,
        keysShared,
        limits,
        sharedMachine,
        polarPolicy,
        groups
    ] = await Promise.all([
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
        sharedWorkspaceAllowed(),
        readPolarPolicy(),
        prisma.group.findMany({
            select: { id: true, name: true },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            take: GROUP_CHIPS + 1
        })
    ]);
    const [chosenGroups, people] = await Promise.all([
        prisma.group.findMany({
            where: { id: { in: [...polarPolicy.use.groupIds, ...polarPolicy.spend.groupIds] } },
            select: { id: true, name: true }
        }),
        prisma.user.findMany({
            where: { id: { in: [...polarPolicy.use.userIds, ...polarPolicy.spend.userIds] } },
            select: { id: true, name: true }
        })
    ]);
    return {
        platform,
        pools,
        providers,
        catalogModels,
        catalogAt: catalogAt?.toISOString() ?? null,
        keysShared,
        limits,
        sharedMachine,
        polarPolicy,
        groups: groups.slice(0, GROUP_CHIPS),
        moreGroups: groups.length > GROUP_CHIPS,
        chosenGroups,
        people
    };
}
