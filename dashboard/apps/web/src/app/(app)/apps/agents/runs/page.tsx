import { PageHeader } from "@polaris/ui";
import { RunsView } from "./runs-view";
import { requirePermission } from "@/lib/session";
import { listAgentRepos } from "@/lib/agents/agent-repo-service";
import { listAgentRuns } from "@/lib/agents/agent-run-service";

export const dynamic = "force-dynamic";

export default async function AgentRunsPage() {
    const user = await requirePermission("agents.read");
    const [runs, repos] = await Promise.all([listAgentRuns(user.id, { limit: 100 }), listAgentRepos(user.id)]);

    return (
        <>
            <PageHeader
                title="Runs"
                description="Every time an agent ran, what started it, and how it ended."
            />
            <RunsView runs={runs} repos={repos.filter((repo) => repo.enabled).map((repo) => repo.repoFullName)} />
        </>
    );
}
