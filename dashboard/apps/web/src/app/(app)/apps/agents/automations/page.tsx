import { PageHeader } from "@polaris/ui";
import { prisma } from "@polaris/db";
import { requirePermission } from "@/lib/session";
import { AutomationsView } from "./automations-view";
import { listAgentRepos } from "@/lib/agents/agent-repo-service";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AgentAutomationsPage() {
    const user = await requirePermission("agents.read");
    const repos = await listAgentRepos(user.id);
    const t = await getTranslations("agents");
    const rules = await prisma.agentAutomation.findMany({
        where: { repo: { ownerId: user.id } },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            repoId: true,
            trigger: true,
            condition: true,
            mode: true,
            instructions: true,
            enabled: true
        }
    });

    return (
        <>
            <PageHeader
                title={t("pages.automationsTitle")}
                description={t("pages.automations")}
            />
            <AutomationsView
                repos={repos.map((repo) => ({ id: repo.id, name: repo.repoFullName }))}
                rules={rules}
            />
        </>
    );
}
