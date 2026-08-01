"use client";

/**
 * Every runner pool, with what each one is doing right now.
 *
 * A pool card answers three questions in the order they get asked: is it keeping
 * runners up, what has run on it lately, and what is wrong if the answer to the
 * first one is no. The pool's own error is shown on the pool rather than left in a
 * server log, because the thing that fixes it is almost always on the machine.
 *
 * A pool serving more than one repository also has to answer "why is nothing
 * happening for mine", so each repository shows what it has waiting, what it has
 * running, and what it has spent - and, when it has spent it all, that as well.
 *
 * Pausing and removing apply immediately and roll back if the server refuses.
 * Both are answers the server already agreed to in principle: a pool the operator
 * can see is one they may pause, so making them watch a round trip to find that
 * out is a delay with nothing on the other side of it.
 */

import { Notice } from "./notice";
import { PoolDialog } from "./pool-dialog";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RunsOnSnippet } from "./runs-on-snippet";
import type { ServerOption } from "./pool-dialog";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { Box, FolderOpen, Github, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import type { RunnerJobView, RunnerPoolView, RunnerTargetView } from "@/lib/runners/runner-service";
import { deleteRunnerPoolAction, reconcileRunnersAction, refreshPoolTargetsAction, updateRunnerPoolAction } from "./actions";

export function RunnersView({
    pools,
    servers,
    accessNotice
}: {
    pools: RunnerPoolView[];
    servers: ServerOption[];
    /** What the GitHub connection is missing, streamed in after the page paints. */
    accessNotice: React.ReactNode;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    // What the operator has already been shown as done. A pool in `removed` is
    // gone from the list; a pool in `paused` is showing the state they asked for.
    // Both are cleared by the refresh that follows a successful action, and rolled
    // back by hand when the server refuses.
    const [removed, setRemoved] = useState<Set<string>>(new Set());
    const [paused, setPaused] = useState<Map<string, boolean>>(new Map());

    function remove(pool: RunnerPoolView) {
        setConfirmId(null);
        setError(null);
        setRemoved((current) => new Set(current).add(pool.id));
        startTransition(async () => {
            const result = await deleteRunnerPoolAction(pool.id);
            if (result.error) {
                setRemoved((current) => {
                    const next = new Set(current);
                    next.delete(pool.id);
                    return next;
                });
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    function toggle(pool: RunnerPoolView) {
        const next = !enabledOf(pool);
        setError(null);
        setPaused((current) => new Map(current).set(pool.id, next));
        startTransition(async () => {
            const result = await updateRunnerPoolAction({ id: pool.id, enabled: next });
            if (result.error) {
                setPaused((current) => {
                    const rolled = new Map(current);
                    rolled.delete(pool.id);
                    return rolled;
                });
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    function refresh(pool: RunnerPoolView) {
        setError(null);
        startTransition(async () => {
            const result = await refreshPoolTargetsAction(pool.id);
            if (result.error) setError(result.error);
            router.refresh();
        });
    }

    const enabledOf = (pool: RunnerPoolView): boolean => paused.get(pool.id) ?? pool.enabled;
    const visible = pools.filter((pool) => !removed.has(pool.id));

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-muted-foreground">Runner pools</h2>
                <div className="flex items-center gap-1">
                    {visible.length > 0 ? (
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Check the pools now"
                            title="Check the pools now"
                            disabled={pending}
                            onClick={() =>
                                startTransition(async () => {
                                    await reconcileRunnersAction();
                                    router.refresh();
                                })
                            }
                        >
                            <RefreshCw className="size-4" />
                        </Button>
                    ) : null}
                    <PoolDialog servers={servers} />
                </div>
            </div>

            {accessNotice}

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {visible.length === 0 ? (
                <div className="flex max-w-lg flex-col gap-2">
                    <p className="text-xs text-muted-foreground">
                        A pool keeps runners waiting on one of your servers, so a job runs there instead of on
                        GitHub&apos;s machines. Each one registers, takes a single job, and disappears - nothing
                        is left on the machine between jobs.
                    </p>
                    <RunsOnSnippet
                        labels={["self-hosted"]}
                        label="Once a pool exists, this is what sends a job to it:"
                    />
                </div>
            ) : (
                visible.map((pool) => (
                    <PoolCard
                        key={pool.id}
                        pool={pool}
                        enabled={enabledOf(pool)}
                        pending={pending}
                        confirming={confirmId === pool.id}
                        onConfirm={() => setConfirmId(pool.id)}
                        onCancel={() => setConfirmId(null)}
                        onDelete={() => remove(pool)}
                        onToggle={() => toggle(pool)}
                        onRefresh={() => refresh(pool)}
                    />
                ))
            )}
        </div>
    );
}

function PoolCard({
    pool,
    enabled,
    pending,
    confirming,
    onConfirm,
    onCancel,
    onDelete,
    onToggle,
    onRefresh
}: {
    pool: RunnerPoolView;
    enabled: boolean;
    pending: boolean;
    confirming: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    onDelete: () => void;
    onToggle: () => void;
    onRefresh: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    // One repository is the pool's whole identity and needs no list; several are
    // worth showing, but not thirty at once.
    const many = pool.targets.length > 1;
    const shown = expanded ? pool.targets : pool.targets.slice(0, 5);

    return (
        <Card>
            <CardHeader className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <CardTitle className="flex items-center gap-2">
                        {pool.name}
                        {enabled ? null : <Badge variant="neutral">Paused</Badge>}
                    </CardTitle>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                            <Github className="size-3.5" />
                            {pool.scopeSummary}
                        </span>
                        <span className="flex items-center gap-1">
                            {pool.isolation === "container" ? (
                                <>
                                    <Box className="size-3.5" /> Contained
                                </>
                            ) : (
                                <>
                                    <FolderOpen className="size-3.5" /> Shares {pool.hostName}
                                </>
                            )}
                        </span>
                        <span>
                            {pool.live} of {pool.maxConcurrent} waiting on {pool.hostName}
                        </span>
                        <LimitsNote pool={pool} />
                    </span>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                    {confirming ? (
                        <>
                            <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
                                Cancel
                            </Button>
                            <Button size="sm" onClick={onDelete} disabled={pending}>
                                Remove
                            </Button>
                        </>
                    ) : (
                        <>
                            {many ? (
                                <Button
                                    size="icon"
                                    variant="ghost"
                                    aria-label={`Re-read what ${pool.name} serves`}
                                    title="Re-read what it serves"
                                    disabled={pending}
                                    onClick={onRefresh}
                                >
                                    <RefreshCw className="size-4" />
                                </Button>
                            ) : null}
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={enabled ? `Pause ${pool.name}` : `Resume ${pool.name}`}
                                title={enabled ? "Pause" : "Resume"}
                                onClick={onToggle}
                            >
                                {enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                            </Button>
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Remove ${pool.name}`}
                                title="Remove"
                                onClick={onConfirm}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </>
                    )}
                </div>
            </CardHeader>

            <CardBody className="flex flex-col gap-3">
                <RunsOnSnippet labels={pool.labels} label="" />

                {pool.error ? <Notice>{pool.error}</Notice> : null}

                {many ? (
                    <ul className="flex flex-col gap-1 text-xs">
                        {shown.map((target) => (
                            <TargetRow key={target.key} target={target} pool={pool} />
                        ))}
                        {pool.targets.length > shown.length ? (
                            <li>
                                <button
                                    type="button"
                                    onClick={() => setExpanded(true)}
                                    className="text-muted-foreground hover:underline"
                                >
                                    Show {pool.targets.length - shown.length} more
                                </button>
                            </li>
                        ) : null}
                    </ul>
                ) : null}

                {pool.jobs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        {enabled ? "Starting the first runner..." : "Paused, so no runners are waiting."}
                    </p>
                ) : (
                    <ul className="flex flex-col gap-1 text-xs">
                        {pool.jobs.map((job) => (
                            <JobRow key={job.id} job={job} showTarget={many} />
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}

/** One line per repository the pool serves: what it has waiting, what it has
 *  running, and what it has spent against the pool's limits. */
function TargetRow({ target, pool }: { target: RunnerTargetView; pool: RunnerPoolView }) {
    const spent: string[] = [];
    if (pool.limits.minutesBudget !== null) {
        spent.push(`${target.minutes}/${pool.limits.minutesBudget} min`);
    } else if (target.minutes > 0) {
        spent.push(`${target.minutes} min`);
    }
    if (pool.limits.jobsPerDay !== null) spent.push(`${target.jobsToday}/${pool.limits.jobsPerDay} today`);

    return (
        <li className="flex items-start justify-between gap-3 border-t border-border pt-1 first:border-0 first:pt-0">
            <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-muted-foreground">{target.key}</span>
                {target.blocked ? <span className="text-danger">{target.blocked}</span> : null}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                {spent.length > 0 ? <span>{spent.join(" - ")}</span> : null}
                {target.queued > 0 ? <Badge variant="warning">{target.queued} queued</Badge> : null}
                {target.live > 0 ? <Badge variant="primary">{target.live} up</Badge> : null}
            </span>
        </li>
    );
}

/** The pool's limits in one phrase, or nothing when it has none. */
function LimitsNote({ pool }: { pool: RunnerPoolView }) {
    const parts: string[] = [];
    if (pool.limits.perTargetConcurrent !== null) parts.push(`${pool.limits.perTargetConcurrent} at once each`);
    if (pool.limits.minutesBudget !== null) {
        parts.push(`${pool.limits.minutesBudget} min a ${pool.limits.minutesWindow}`);
    }
    if (pool.limits.jobsPerDay !== null) parts.push(`${pool.limits.jobsPerDay} jobs a day`);
    if (parts.length === 0) return null;
    return <span>{parts.join(", ")}</span>;
}

const JOB_STATE_LABELS: Record<RunnerJobView["state"], string> = {
    starting: "Starting",
    idle: "Waiting for a job",
    busy: "Running a job",
    finished: "Finished",
    failed: "Never started"
};

function JobRow({ job, showTarget }: { job: RunnerJobView; showTarget: boolean }) {
    return (
        <li className="flex items-start justify-between gap-3 border-t border-border pt-1 first:border-0 first:pt-0">
            <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-muted-foreground">{job.name}</span>
                {showTarget ? <span className="truncate text-muted-foreground">{job.target}</span> : null}
                {job.error ? <span className="text-danger">{job.error}</span> : null}
            </span>
            <Badge variant={job.state === "failed" ? "danger" : job.state === "busy" ? "primary" : "neutral"}>
                {JOB_STATE_LABELS[job.state]}
            </Badge>
        </li>
    );
}
