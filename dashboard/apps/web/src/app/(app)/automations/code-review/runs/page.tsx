import { PageHeader } from "@polaris/ui";
import { RunsView } from "./runs-view";
import { readAgentPause } from "@/lib/agents/agent-pause";
import { requirePermission, sessionCan } from "@/lib/session";
import { listAgentRepos } from "@/lib/agents/agent-repo-service";
import { listAgentRuns } from "@/lib/agents/agent-run-service";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AgentRunsPage() {
    const user = await requirePermission("agents.read");
    const t = await getTranslations("agents");
    const [runs, repos, pause, canManage] = await Promise.all([
        listAgentRuns(user.id, { limit: 100 }),
        listAgentRepos(user.id),
        readAgentPause(user.id),
        sessionCan(user, "agents.manage")
    ]);

    return (
        <>
            <PageHeader title={t("pages.runsTitle")} description={t("pages.runs")} />
            <RunsView
                runs={runs}
                repos={repos.filter((repo) => repo.enabled).map((repo) => repo.repoFullName)}
                pause={pause}
                canManage={canManage}
            />
        </>
    );
}
