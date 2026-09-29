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
import { useTranslations } from "@/components/i18n/i18n-provider";
import { runnerText } from "@/lib/runners/words";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

const OUTCOMES: readonly RunnerRunOutcome[] = ["ran", "running", "refused", "failed"];

function outcomeLabel(t: NamespaceTranslator<"runners">, outcome: RunnerRunOutcome): string {
    return t(`runs.outcomes.${outcome}` as NamespaceKey<"runners">);
}

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
    const t = useTranslations("runners");
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
                    <p className="text-sm">{t("runs.none")}</p>
                    <p className="max-w-lg text-xs text-muted-foreground">{t("runs.noneHint")}</p>
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/apps/runners">{t("runs.openPools")}</Link>
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
                        aria-label={t("runs.pool")}
                        value={pool}
                        onValueChange={setPool}
                        className="w-44"
                        options={[
                            { value: "all", label: t("runs.everyPool") },
                            ...pools.map((entry) => ({ value: entry.id, label: entry.name }))
                        ]}
                    />
                ) : null}
                {targets.length > 1 ? (
                    <Select
                        aria-label={t("runs.repository")}
                        value={target}
                        onValueChange={setTarget}
                        className="w-60"
                        options={[
                            { value: "all", label: t("runs.everyRepository") },
                            ...targets.map((entry) => ({ value: entry, label: entry }))
                        ]}
                    />
                ) : null}
                <Select
                    aria-label={t("runs.outcome")}
                    value={outcome}
                    onValueChange={setOutcome}
                    className="w-44"
                    options={[
                        { value: "all", label: t("runs.everyOutcome") },
                        ...OUTCOMES.map((entry) => ({ value: entry, label: outcomeLabel(t, entry) }))
                    ]}
                />
                <span className="ml-auto text-xs text-muted-foreground">
                    {shown.length === runs.length
                        ? t("runs.count", { count: runs.length })
                        : t("runs.countOf", { shown: shown.length, total: runs.length })}
                </span>
            </div>

            {shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("runs.noMatch")}</p>
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
    const t = useTranslations("runners");
    const outcome = outcomeOf(run);
    const href = run.runId ? `https://github.com/${run.target}/actions/runs/${run.runId}` : null;

    return (
        <li>
            <Card>
                <CardBody className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-col gap-1">
                            <span className="flex items-center gap-2 text-sm font-medium">
                                <span className="truncate">{run.workflow ?? t("runs.neverStarted")}</span>
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
                                <span>{t("runs.onHost", { host: run.hostName })}</span>
                                <Started at={run.startedAt} seconds={run.seconds} />
                            </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <Badge variant={OUTCOME_TONE[outcome]}>{outcomeLabel(t, outcome)}</Badge>
                            {href ? (
                                <Button
                                    asChild
                                    size="icon"
                                    variant="ghost"
                                    aria-label={t("runs.openRun")}
                                    title={t("runs.openOnGithub")}
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
                            {runnerText(t, run.refusedReason)}{" "}
                            <Link href="/apps/runners/repos" className="underline">
                                {t("runs.changeAllowed")}
                            </Link>
                        </Reason>
                    ) : null}
                    {run.error ? (
                        <Reason tone="danger" icon={<TriangleAlert className="size-3.5" />}>
                            {runnerText(t, run.error)}
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
                tone === "warning" ? "border-warning-edge bg-warning-soft" : "border-danger-edge bg-danger-soft"
            )}
        >
            {icon}
            <span>{children}</span>
        </p>
    );
}
