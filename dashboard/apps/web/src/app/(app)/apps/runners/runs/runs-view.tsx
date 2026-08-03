"use client";

/**
 * The run list.
 *
 * A run answers three questions in the order they get asked: what was it, did it
 * run, and if not, why not. The refused ones are the reason this screen exists -
 * somebody is looking at a red check on their pull request and this is the only
 * place that says a machine turned it down and what to change.
 *
 * The filters narrow what is already loaded rather than going back to the server:
 * the list is bounded to a page, everything the filters need is in each row, and
 * a round trip to hide thirty rows would be slower than reading them.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useDisplayFormat } from "@/components/display-format";
import type { RunnerRunView } from "@/lib/runners/runner-runs";
import { outcomeOf, type RunnerRunOutcome } from "@polaris/core";
import { Badge, Button, Card, CardBody, Select, cn } from "@polaris/ui";
import { CircleSlash, ExternalLink, GitBranch, Github, TriangleAlert, User } from "lucide-react";

const OUTCOME_LABELS: Record<RunnerRunOutcome, string> = {
    ran: "Ran",
    running: "Running",
    refused: "Turned down",
    failed: "Never started"
};

const OUTCOME_TONE: Record<RunnerRunOutcome, "neutral" | "primary" | "warning" | "danger"> = {
    ran: "neutral",
    running: "primary",
    refused: "warning",
    failed: "danger"
};

export function RunsView({
    runs,
    pools,
    targets
}: {
    runs: RunnerRunView[];
    pools: Array<{ id: string; name: string }>;
    targets: string[];
}) {
    const [pool, setPool] = useState("all");
    const [target, setTarget] = useState("all");
    const [outcome, setOutcome] = useState("all");

    const shown = useMemo(
        () =>
            runs.filter((run) => {
                if (pool !== "all" && run.poolId !== pool) return false;
                if (target !== "all" && run.target !== target) return false;
                if (outcome !== "all" && outcomeOf(run) !== outcome) return false;
                return true;
            }),
        [runs, pool, target, outcome]
    );

    if (runs.length === 0) {
        return (
            <Card>
                <CardBody className="flex flex-col items-start gap-2">
                    <p className="text-sm">Nothing has run yet.</p>
                    <p className="max-w-lg text-xs text-muted-foreground">
                        A run appears here once one of your pools is handed a job. If a workflow is waiting on GitHub
                        instead, the pool it should land on will say what is stopping it.
                    </p>
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/apps/runners">Open pools</Link>
                    </Button>
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                {pools.length > 1 ? (
                    <Select
                        aria-label="Pool"
                        value={pool}
                        onValueChange={setPool}
                        className="w-44"
                        options={[
                            { value: "all", label: "Every pool" },
                            ...pools.map((entry) => ({ value: entry.id, label: entry.name }))
                        ]}
                    />
                ) : null}
                {targets.length > 1 ? (
                    <Select
                        aria-label="Repository"
                        value={target}
                        onValueChange={setTarget}
                        className="w-60"
                        options={[
                            { value: "all", label: "Every repository" },
                            ...targets.map((entry) => ({ value: entry, label: entry }))
                        ]}
                    />
                ) : null}
                <Select
                    aria-label="Outcome"
                    value={outcome}
                    onValueChange={setOutcome}
                    className="w-44"
                    options={[
                        { value: "all", label: "Every outcome" },
                        { value: "ran", label: "Ran" },
                        { value: "running", label: "Running" },
                        { value: "refused", label: "Turned down" },
                        { value: "failed", label: "Never started" }
                    ]}
                />
                <span className="ml-auto text-xs text-muted-foreground">
                    {shown.length === runs.length
                        ? `${runs.length} ${runs.length === 1 ? "run" : "runs"}`
                        : `${shown.length} of ${runs.length}`}
                </span>
            </div>

            {shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">No run matches those filters.</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {shown.map((run) => (
                        <RunRow key={run.id} run={run} showPool={pools.length > 1} />
                    ))}
                </ul>
            )}
        </div>
    );
}

function RunRow({ run, showPool }: { run: RunnerRunView; showPool: boolean }) {
    const outcome = outcomeOf(run);
    const href = run.runId ? `https://github.com/${run.target}/actions/runs/${run.runId}` : null;

    return (
        <li>
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="flex items-center gap-2 text-sm font-medium">
                                <span className="truncate">{run.workflow ?? "A job that never started"}</span>
                                {run.jobName ? (
                                    <span className="truncate text-xs text-muted-foreground">{run.jobName}</span>
                                ) : null}
                            </span>
                            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                    <Github className="size-3.5" />
                                    {run.target}
                                </span>
                                {run.ref ? (
                                    <span className="flex items-center gap-1">
                                        <GitBranch className="size-3.5" />
                                        {run.ref}
                                    </span>
                                ) : null}
                                {run.actor ? (
                                    <span className="flex items-center gap-1">
                                        <User className="size-3.5" />
                                        {run.actor}
                                    </span>
                                ) : null}
                                {run.event ? <span>{run.event}</span> : null}
                                {showPool ? <span>{run.poolName}</span> : null}
                                <span>on {run.hostName}</span>
                                <Started at={run.startedAt} seconds={run.seconds} />
                            </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <Badge variant={OUTCOME_TONE[outcome]}>{OUTCOME_LABELS[outcome]}</Badge>
                            {href ? (
                                <Button
                                    asChild
                                    size="icon"
                                    variant="ghost"
                                    aria-label="Open this run on GitHub"
                                    title="Open on GitHub"
                                >
                                    <a href={href} target="_blank" rel="noreferrer noopener">
                                        <ExternalLink className="size-4" />
                                    </a>
                                </Button>
                            ) : null}
                        </div>
                    </div>

                    {run.refusedReason ? (
                        <Reason tone="warning" icon={<CircleSlash className="size-3.5" />}>
                            {run.refusedReason}{" "}
                            <Link href="/apps/runners/repos" className="underline">
                                Change what this repository allows
                            </Link>
                        </Reason>
                    ) : null}
                    {run.error ? (
                        <Reason tone="danger" icon={<TriangleAlert className="size-3.5" />}>
                            {run.error}
                        </Reason>
                    ) : null}
                </CardBody>
            </Card>
        </li>
    );
}

/** When it started and how long it held the machine, in the date order and clock
 *  this dashboard was set to rather than the browser's guess at them. */
function Started({ at, seconds }: { at: string; seconds: number | null }) {
    const format = useDisplayFormat();
    return (
        <span>
            {format.dateTime(at)}
            {seconds === null ? "" : ` - ${duration(seconds)}`}
        </span>
    );
}

function duration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function Reason({
    tone,
    icon,
    children
}: {
    tone: "warning" | "danger";
    icon: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <p
            className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
                tone === "warning" ? "border-warning/40 bg-warning/5" : "border-danger/40 bg-danger/5"
            )}
        >
            {icon}
            <span>{children}</span>
        </p>
    );
}
