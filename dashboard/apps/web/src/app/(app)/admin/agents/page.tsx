/**
 * Agent defaults admin (/admin/agents): what every account's own Agents settings
 * fall through to, and what a repository nobody has configured starts from.
 */

import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { PlatformDefaultsView } from "./platform-defaults-view";
import { connectedProviders } from "@/lib/agents/agent-providers";
import { getPlatformAgentDefaults } from "@/lib/agents/agent-defaults-service";

export const dynamic = "force-dynamic";

export default async function AgentDefaultsAdminPage() {
    await requireAdmin();
    const [platform, pools, providers] = await Promise.all([
        getPlatformAgentDefaults(),
        // Every pool on the deployment, not one person's: a default here applies
        // to everybody.
        prisma.runnerPool.findMany({
            where: { enabled: true },
            select: { id: true, name: true },
            orderBy: { name: "asc" }
        }),
        connectedProviders()
    ]);

    return (
        // Narrow page: centre the column in the content area, header included, so
        // the form does not sit against the rail with the width beside it empty.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Agent defaults"
                description="What agent runs do across the whole deployment. Each account can narrow it under Apps > Agents, and a repository can override it again."
            />
            <PlatformDefaultsView platform={platform} pools={pools} providers={providers} />
        </div>
    );
}
