import Link from "next/link";
import { Suspense } from "react";
import { SetupNotice } from "./setup-notice";
import { AgentsOverview } from "./agents-view";
import { Button, PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { listAgentRuns } from "@/lib/agents/agent-run-service";
import { listAgentRepos } from "@/lib/agents/agent-repo-service";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

/**
 * What the agent is doing across every repository it is on.
 *
 * Repositories and runs are database reads, so the screen is on at once. Whether
 * the GitHub App and a model provider are actually connected is a question for
 * the integration store and GitHub, and it only decides a notice - so it streams
 * in behind a boundary rather than holding the page.
 */
export default async function AgentsPage() {
    const user = await requirePermission("agents.read");
    const t = await getTranslations("agents");
    const [repos, runs] = await Promise.all([
        listAgentRepos(user.id),
        listAgentRuns(user.id, { limit: 10 })
    ]);

    return (
        <>
            <PageHeader
                title={t("page.title")}
                description={t("page.description")}
                actions={
                    repos.length > 0 ? (
                        <Button asChild size="sm">
                            <Link href="/apps/agents/repos">{t("overview.repositories")}</Link>
                        </Button>
                    ) : null
                }
            />
            <Suspense fallback={null}>
                <SetupNotice />
            </Suspense>
            <AgentsOverview repos={repos} runs={runs} />
        </>
    );
}
