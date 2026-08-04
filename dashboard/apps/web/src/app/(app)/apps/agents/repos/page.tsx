import { PageHeader } from "@polaris/ui";
import { ReposView } from "./repos-view";
import { requirePermission } from "@/lib/session";
import { listAgentRepos } from "@/lib/agents/agent-repo-service";
import { connectedProviders } from "@/lib/agents/agent-providers";

export const dynamic = "force-dynamic";

export default async function AgentReposPage() {
    const user = await requirePermission("agents.read");
    const [repos, providers] = await Promise.all([listAgentRepos(user.id), connectedProviders()]);

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
