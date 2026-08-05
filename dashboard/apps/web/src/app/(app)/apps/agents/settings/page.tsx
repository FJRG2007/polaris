import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { SettingsView } from "./settings-view";
import { requirePermission } from "@/lib/session";
import { connectedProviders } from "@/lib/agents/agent-providers";
import { getPlatformAgentDefaults, listAgentDefaults, scopeOf } from "@/lib/agents/agent-defaults-service";

export const dynamic = "force-dynamic";

export default async function AgentSettingsPage() {
    const user = await requirePermission("agents.read");
    const [tiers, repos, pools, providers, platform] = await Promise.all([
        listAgentDefaults(user.id),
        prisma.agentRepo.findMany({ where: { ownerId: user.id }, select: { repoFullName: true } }),
        prisma.runnerPool.findMany({
            where: { ownerId: user.id, enabled: true },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        }),
        connectedProviders(),
        getPlatformAgentDefaults()
    ]);

    // The accounts worth offering a tier for are the ones this person has
    // repositories in. Anything wider would be a list of every organization on
    // GitHub, most of which they will never add.
    const owners = [...new Set(repos.map((repo) => scopeOf(repo.repoFullName)))].filter(Boolean).sort();

    return (
        <>
            <PageHeader
                title="Settings"
                description="What your repositories inherit. Set it once here, narrow it per account, and override it on the repositories that need something different."
            />
            <SettingsView
                tiers={tiers}
                owners={owners}
                pools={pools}
                providers={providers}
                platform={platform}
            />
        </>
    );
}
