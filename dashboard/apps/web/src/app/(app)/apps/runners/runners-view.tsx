"use client";

/**
 * Every runner pool, with what each one is doing right now.
 *
 * A pool card answers three questions in the order they get asked: is it keeping
 * runners up, what has run on it lately, and what is wrong if the answer to the
 * first one is no. The pool's own error is shown on the pool rather than left in a
 * server log, because the thing that fixes it is almost always on the machine.
 *
 * Pausing is offered next to removing, since a machine that needs work on it is a
 * far more common reason to stop a pool than not wanting it any more.
 */

import Link from "next/link";
import { PoolDialog } from "./pool-dialog";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { RunnerJobView, RunnerPoolView } from "@/lib/runners/runner-service";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { deleteRunnerPoolAction, reconcileRunnersAction, updateRunnerPoolAction } from "./actions";
import { Box, FolderOpen, Github, Pause, Play, RefreshCw, Trash2, TriangleAlert } from "lucide-react";

interface ServerOption {
    id: string;
    name: string;
}

export function RunnersView({
    pools,
    servers,
    accessReady,
    accessAdvice
}: {
    pools: RunnerPoolView[];
    servers: ServerOption[];
    accessReady: boolean;
    accessAdvice: string | null;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    function act(run: () => Promise<{ error?: string } | void>) {
        startTransition(async () => {
            const result = await run();
            setError(result?.error ?? null);
            setConfirmId(null);
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-muted-foreground">Runner pools</h2>
                <div className="flex items-center gap-1">
                    {pools.length > 0 ? (
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label="Check the pools now"
                            title="Check the pools now"
                            disabled={pending}
                            onClick={() => act(reconcileRunnersAction)}
                        >
                            <RefreshCw className="size-4" />
                        </Button>
                    ) : null}
                    <PoolDialog servers={servers} disabled={!accessReady || servers.length === 0} />
                </div>
            </div>

            {accessReady ? null : (
                <Notice>
                    {accessAdvice ?? "Connect GitHub before adding runners."}{" "}
                    <Link href="/integrations" className="underline">
                        Open Integrations
                    </Link>
                </Notice>
            )}

            {accessReady && servers.length === 0 ? (
                <Notice>
                    Runners run on a server you have registered.{" "}
                    <Link href="/apps/servers" className="underline">
                        Add one first
                    </Link>
                </Notice>
            ) : null}

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {pools.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                    A pool keeps runners waiting on one of your servers, so a workflow with{" "}
                    <code className="font-mono">runs-on: self-hosted</code> runs there instead of on GitHub&apos;s
                    machines.
                </p>
            ) : (
                pools.map((pool) => (
                    <PoolCard
                        key={pool.id}
                        pool={pool}
                        pending={pending}
                        confirming={confirmId === pool.id}
                        onConfirm={() => setConfirmId(pool.id)}
                        onCancel={() => setConfirmId(null)}
                        onDelete={() => act(() => deleteRunnerPoolAction(pool.id))}
                        onToggle={() => act(() => updateRunnerPoolAction({ id: pool.id, enabled: !pool.enabled }))}
                    />
                ))
            )}
        </div>
    );
}

function PoolCard({
    pool,
    pending,
    confirming,
    onConfirm,
    onCancel,
    onDelete,
    onToggle
}: {
    pool: RunnerPoolView;
    pending: boolean;
    confirming: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    onDelete: () => void;
    onToggle: () => void;
}) {
    const target = pool.targetRepo ? `${pool.targetOwner}/${pool.targetRepo}` : pool.targetOwner;

    return (
        <Card>
            <CardHeader className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <CardTitle className="flex items-center gap-2">
                        {pool.name}
                        {pool.enabled ? null : <Badge variant="neutral">Paused</Badge>}
                    </CardTitle>
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                            <Github className="size-3.5" />
                            {target}
                            {pool.scope === "org" ? " (organization)" : ""}
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
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={pool.enabled ? `Pause ${pool.name}` : `Resume ${pool.name}`}
                                title={pool.enabled ? "Pause" : "Resume"}
                                disabled={pending}
                                onClick={onToggle}
                            >
                                {pool.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
                            </Button>
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Remove ${pool.name}`}
                                title="Remove"
                                disabled={pending}
                                onClick={onConfirm}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </>
                    )}
                </div>
            </CardHeader>

            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-1">
                    {pool.labels.map((label) => (
                        <Badge key={label} variant="neutral">
                            {label}
                        </Badge>
                    ))}
                </div>

                {pool.error ? <Notice>{pool.error}</Notice> : null}

                {pool.jobs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                        {pool.enabled ? "Starting the first runner..." : "Paused, so no runners are waiting."}
                    </p>
                ) : (
                    <ul className="flex flex-col gap-1 text-xs">
                        {pool.jobs.map((job) => (
                            <JobRow key={job.id} job={job} />
                        ))}
                    </ul>
                )}
            </CardBody>
        </Card>
    );
}

const JOB_STATE_LABELS: Record<RunnerJobView["state"], string> = {
    starting: "Starting",
    idle: "Waiting for a job",
    busy: "Running a job",
    finished: "Finished",
    failed: "Never started"
};

function JobRow({ job }: { job: RunnerJobView }) {
    return (
        <li className="flex items-start justify-between gap-3 border-t border-border pt-1 first:border-0 first:pt-0">
            <span className="flex flex-col">
                <span className="font-mono text-muted-foreground">{job.name}</span>
                {job.error ? <span className="text-danger">{job.error}</span> : null}
            </span>
            <Badge variant={job.state === "failed" ? "danger" : job.state === "busy" ? "primary" : "neutral"}>
                {JOB_STATE_LABELS[job.state]}
            </Badge>
        </li>
    );
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
            {children}
        </p>
    );
}
