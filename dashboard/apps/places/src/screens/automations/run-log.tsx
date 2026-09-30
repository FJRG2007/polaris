"use client";

/**
 * What an automation did, newest first: when, why it fired, and how each step
 * went - the page somebody opens when the light did not go off.
 *
 * A run still in progress is read again every few seconds while the tab is in
 * front, so a delay counting down or a step waiting on a door is watched rather
 * than refreshed by hand.
 */

import * as actions from "./actions";
import { usePlacesT } from "../use-places-t";
import { hostUi } from "@polaris/app-host/client";
import * as auto from "../../lib/automation-kinds";
import * as words from "../../lib/automation-words";
import { toneClass } from "../devices/device-panel";
import { ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, EmptyState, Skeleton, cn } from "@polaris/ui";

const { runAction } = hostUi.runAction;
const { useDisplayFormat } = hostUi.displayFormat;
const { RelativeTime } = hostUi.relativeTime;

const LIVE_MS = 5000;

const OUTCOME_TONES: Readonly<Record<auto.StepOutcome, Parameters<typeof toneClass>[0]>> = {
    ok: "success",
    failed: "danger",
    refused: "danger",
    timedOut: "warning",
    waiting: "active",
    skipped: "muted"
};

export function RunLog({
    automation,
    initial,
    lookup,
    automationName,
    refreshKey
}: {
    automation: auto.AutomationView;
    initial: auto.RunView[] | null;
    lookup: words.DeviceLookup;
    automationName: (id: string) => string | undefined;
    /** Changes when something outside asked for a fresh read - Run now. */
    refreshKey: number;
}) {
    const t = usePlacesT();
    const format = useDisplayFormat();
    const [runs, setRuns] = useState<auto.RunView[] | null>(initial);
    const [open, setOpen] = useState<string | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        const result = await runAction(() => actions.automationRunsAction(automation.id), setError);
        setLoading(false);
        if (!result) return;
        if (result.error) {
            setError(result.error);
            return;
        }
        setError("");
        setRuns(result.runs ?? []);
    }, [automation.id]);

    useEffect(() => {
        if (refreshKey > 0) void load();
    }, [refreshKey, load]);

    const active = (runs ?? []).some((run) => !auto.runFinished(run.status));
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => {
            if (document.visibilityState === "visible") void load();
        }, LIVE_MS);
        return () => clearInterval(timer);
    }, [active, load]);

    const stepById = new Map(automation.definition.actions.map((step) => [step.id, step]));

    return (
        <section className="flex flex-col gap-3" aria-labelledby="run-log-title">
            <div className="flex items-center gap-2">
                <h2 id="run-log-title" className="flex-1 text-sm font-medium">
                    {t("automations.log.title")}
                </h2>
                <Button
                    size="sm"
                    variant="ghost"
                    className="size-8 p-0"
                    aria-label={t("automations.log.refresh")}
                    title={t("automations.log.refresh")}
                    disabled={loading}
                    onClick={() => void load()}
                >
                    <RefreshCw className={cn("size-4", loading && "animate-spin")} />
                </Button>
            </div>
            {error && (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    {error}
                </p>
            )}
            {runs === null ? (
                <div className="flex flex-col gap-2" aria-busy="true">
                    <Skeleton className="h-12 w-full" />
                    <Skeleton className="h-12 w-full" />
                </div>
            ) : runs.length === 0 ? (
                <EmptyState title={t("automations.log.emptyTitle")} description={t("automations.log.emptyBody")} />
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {runs.map((run) => {
                        const expanded = open === run.id;
                        const reason = words.reasonText(run.reason, t);
                        return (
                            <li key={run.id} className="flex flex-col">
                                <button
                                    type="button"
                                    aria-expanded={expanded}
                                    onClick={() => setOpen(expanded ? null : run.id)}
                                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left"
                                >
                                    <Badge className={cn("shrink-0", toneClass(words.RUN_TONES[run.status]))}>
                                        {words.runStatusText(run.status, t)}
                                    </Badge>
                                    <span className="min-w-0 flex-1 truncate text-sm">
                                        {words.describeCause(run.cause, lookup, t)}
                                    </span>
                                    <span
                                        className="shrink-0 text-xs tabular-nums text-foreground-subtle"
                                        title={format.dateTime(run.startedAt)}
                                    >
                                        <RelativeTime iso={run.startedAt} />
                                    </span>
                                    <ChevronDown
                                        className={cn(
                                            "size-4 shrink-0 text-muted-foreground transition-transform",
                                            expanded && "rotate-180"
                                        )}
                                    />
                                </button>
                                {expanded && (
                                    <div className="flex flex-col gap-2 border-t border-border bg-surface px-3 py-2">
                                        {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
                                        {run.status === "waiting" && run.dueAt && (
                                            <p className="text-xs text-muted-foreground">
                                                {t("automations.log.resumes", { time: format.dateTime(run.dueAt) })}
                                            </p>
                                        )}
                                        {run.steps.length === 0 ? (
                                            !reason && (
                                                <p className="text-xs text-muted-foreground">
                                                    {t("automations.log.noSteps")}
                                                </p>
                                            )
                                        ) : (
                                            <ol className="flex flex-col gap-1.5">
                                                {run.steps.map((log, index) => {
                                                    const step = stepById.get(log.stepId);
                                                    const note = words.stepNoteText(log, t);
                                                    return (
                                                        <li
                                                            key={`${log.stepId}-${index}`}
                                                            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
                                                        >
                                                            <Badge
                                                                className={cn(
                                                                    "shrink-0",
                                                                    toneClass(OUTCOME_TONES[log.outcome])
                                                                )}
                                                            >
                                                                {words.stepOutcomeText(log.outcome, t)}
                                                            </Badge>
                                                            <span className="min-w-0 flex-1 text-sm">
                                                                {step
                                                                    ? words.describeStep(step, lookup, automationName, t)
                                                                    : t("automations.log.stepGone")}
                                                                {note && (
                                                                    <span
                                                                        className={cn(
                                                                            "block text-xs",
                                                                            log.outcome === "ok"
                                                                                ? "text-muted-foreground"
                                                                                : "text-danger"
                                                                        )}
                                                                    >
                                                                        {note}
                                                                    </span>
                                                                )}
                                                            </span>
                                                            <span className="shrink-0 text-xs tabular-nums text-foreground-subtle">
                                                                {format.time(log.at)}
                                                            </span>
                                                        </li>
                                                    );
                                                })}
                                            </ol>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
