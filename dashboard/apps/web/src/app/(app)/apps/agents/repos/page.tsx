import { PageHeader } from "@polaris/ui";
import { ReposView } from "./repos-view";
import { requirePermission } from "@/lib/session";
import { providersFor } from "@/lib/agents/model-keys";
import { listAgentRepos } from "@/lib/agents/agent-repo-service";
import { reconcileRepoWorkflows } from "@/lib/agents/agent-workflow";

export const dynamic = "force-dynamic";

export default async function AgentReposPage() {
    const user = await requirePermission("agents.read");

    // Anything whose workflow file never made it into GitHub is put right before
    // the list is read, so a repository that looks configured here is configured
    // there too. A healthy instance matches nothing and pays one query.
    await reconcileRepoWorkflows(user.id).catch(() => undefined);

    const [repos, providers] = await Promise.all([listAgentRepos(user.id), providersFor(user.id)]);

    return (
        <>
            <PageHeader
                title="Repositories"
                description="Which repositories the agent works in, and where each one's runs happen. Polaris recommends the cheapest option that fits; the choice is yours."
            />
            <ReposView repos={repos} providers={providers} />
        </>
    );
}
