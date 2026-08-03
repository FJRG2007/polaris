import { PageHeader } from "@polaris/ui";
import { ReposView } from "./repos-view";
import { requirePermission } from "@/lib/session";
import { listRunnerRepos } from "@/lib/runners/runner-repo-config";

export const dynamic = "force-dynamic";

/**
 * Every repository the operator's pools serve, and what each one is allowed to
 * make those machines do.
 *
 * The list is stored state - what the scopes last resolved to - so it paints at
 * once. Whether a repository is public is read from GitHub on the reconcile pass
 * rather than here: it is the answer that decides whether a repository is served
 * at all, and a screen that asked for it would be showing something the pass had
 * already acted on.
 */
export default async function RunnerReposPage() {
    const user = await requirePermission("system.manage");
    const pools = await listRunnerRepos(user.id);

    return (
        <>
            <PageHeader
                title="Repositories"
                description="Which repositories can use your machines, for what, and whose code is allowed to."
            />
            <ReposView pools={pools} />
        </>
    );
}
