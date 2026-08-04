"use client";

import Link from "next/link";
import { RunState } from "./run-state";
import type { AgentRunView } from "@/lib/agents/agent-run-service";
import type { AgentRepoView } from "@/lib/agents/agent-repo-service";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { AGENT_EXECUTION_LABELS, AGENT_RUN_STATE_LABELS, AGENT_TRIGGER_LABELS } from "@polaris/core";

/**
 * The overview: which repositories are on, and what has happened lately.
 *
 * Both lists are links rather than text. A repository name here is the thing
 * somebody wants to open next, and a run is the thing they want the log of.
 */
export function AgentsOverview({ repos, runs }: { repos: AgentRepoView[]; runs: AgentRunView[] }) {
    if (repos.length === 0) return <Empty />;

    return (
        <div className="grid gap-4 lg:grid-cols-2">
            <Card>
                <CardHeader>
                    <CardTitle>Repositories</CardTitle>
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
                                    <Badge variant="neutral">Off</Badge>
                                ) : (
                                    <Badge variant="neutral">{AGENT_EXECUTION_LABELS[repo.execution]}</Badge>
                                )}
                                {repo.error ? (
                                    <span title={repo.error} className="text-xs text-red-400">
                                        Problem
                                    </span>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                </CardBody>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle>Recent runs</CardTitle>
                </CardHeader>
                <CardBody className="p-0">
                    {runs.length === 0 ? (
                        <p className="px-4 py-6 text-sm text-muted-foreground">
                            Nothing has run yet. Mention the app in an issue or a pull request, or start a run from a
                            repository.
                        </p>
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
                                            {AGENT_TRIGGER_LABELS[run.trigger]}
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
    return (
        <Card>
            <CardBody className="flex flex-col items-start gap-3 py-10">
                <p className="text-sm text-muted-foreground">
                    No repository has an agent on it yet. Pick one, choose where its runs should happen, and mention the
                    app in an issue to try it.
                </p>
                <Button asChild size="sm">
                    <Link href="/apps/agents/setup">Set up</Link>
                </Button>
            </CardBody>
        </Card>
    );
}

/** Kept here so the label map has one importer per surface rather than three. */
export { AGENT_RUN_STATE_LABELS };
