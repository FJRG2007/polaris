"use client";

import Link from "next/link";
import { Bot } from "lucide-react";
import { RunState } from "./run-state";
import type { AgentRunView } from "@/lib/agents/agent-run-service";
import type { AgentRepoView } from "@/lib/agents/agent-repo-service";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState } from "@polaris/ui";
import { AGENT_RUN_STATE_LABELS } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { agentWord } from "@/lib/agents/words";

/**
 * The overview: which repositories are on, and what has happened lately.
 *
 * Both lists are links rather than text. A repository name here is the thing
 * somebody wants to open next, and a run is the thing they want the log of.
 */
export function AgentsOverview({ repos, runs }: { repos: AgentRepoView[]; runs: AgentRunView[] }) {
    const t = useTranslations("agents");
    if (repos.length === 0) return <Empty />;

    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <Card>
                <CardHeader>
                    <CardTitle>{t("overview.repositories")}</CardTitle>
                </CardHeader>
                <CardBody className="p-0">
                    <ul className="divide-y divide-white/5">
                        {repos.map((repo) => (
                            <li key={repo.id} className="flex items-center gap-3 px-4 py-3">
                                <Link
                                    href={`/apps/agents/repos?repo=${encodeURIComponent(repo.repoFullName)}`}
                                    className="min-w-0 flex-1 truncate text-sm hover:underline"
                                >
                                    {repo.repoFullName}
                                </Link>
                                {!repo.enabled ? (
                                    <Badge variant="neutral">{t("overview.off")}</Badge>
                                ) : (
                                    <Badge variant="neutral">{agentWord(t, "execution", repo.execution)}</Badge>
                                )}
                                {repo.error ? (
                                    <span title={repo.error} className="text-xs text-danger">
                                        {t("overview.problem")}
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>{t("overview.recentRuns")}</CardTitle>
                </CardHeader>
                <CardBody className="p-0">
                    {runs.length === 0 ? (
                        <p className="px-4 py-6 text-sm text-muted-foreground">{t("overview.noRuns")}</p>
                    ) : (
                        <ul className="divide-y divide-white/5">
                            {runs.map((run) => (
                                <li key={run.id} className="flex items-center gap-3 px-4 py-3">
                                    <Link
                                        href={`/apps/agents/runs?run=${run.id}`}
                                        className="min-w-0 flex-1 truncate text-sm hover:underline"
                                    >
                                        <span className="truncate">{run.repoFullName}</span>
                                        <span className="ml-2 text-xs text-muted-foreground">
                                            {agentWord(t, "trigger", run.trigger)}
                                        </span>
                                    </Link>
                                    <RunState state={run.state} />
                                </li>
                            ))}
                        </ul>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}

function Empty() {
    const t = useTranslations("agents");
    return (
        <EmptyState
            icon={<Bot />}
            title={t("overview.emptyTitle")}
            description={t("overview.emptyHint")}
            action={
                <Button asChild size="sm">
                    <Link href="/apps/agents/setup">{t("overview.setUp")}</Link>
                </Button>
            }
        />
    );
}

/** Kept here so the label map has one importer per surface rather than three. */
export { AGENT_RUN_STATE_LABELS };
