import { Suspense } from "react";
import { PageHeader } from "@polaris/ui";
import { SetupNotice } from "./setup-notice";
import { ReposView } from "./repos-view";
import { requirePermission } from "@/lib/session";
import { providersFor } from "@/lib/agents/model-keys";
import { listAgentRepos } from "@/lib/agents/agent-repo-service";
import { reconcileRepoWorkflowsInBackground } from "@/lib/agents/agent-workflow";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AgentReposPage() {
    const user = await requirePermission("agents.read");
    // Anything whose workflow file never made it into GitHub is put right behind
    // the render, so a repository that looks configured here is configured there
    // too by the next visit. A healthy instance matches nothing and pays one query.
    reconcileRepoWorkflowsInBackground(user.id);

    const [t, repos, providers] = await Promise.all([
        getTranslations("agents"),
        listAgentRepos(user.id),
        providersFor(user.id)
    ]);

    return (
        <>
            <PageHeader
                title={t("overview.repositories")}
                description={t("pages.repos")}
            />
            <div className="flex flex-col gap-4">
                {/* Whether GitHub and a model are connected is a question for
                    the integration store, so it streams in behind the list. */}
                <Suspense fallback={null}>
                    <SetupNotice />
                </Suspense>
                <ReposView repos={repos} providers={providers} />
            </div>
        </>
    );
}
