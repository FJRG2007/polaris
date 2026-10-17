"use client";

import Link from "next/link";
import { useState } from "react";
import type { RunRow, RunStepRow } from "@/lib/automations/service";
import { Button, EmptyState, Skeleton, useToast } from "@polaris/ui";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { ChevronDown, ChevronRight, History, RefreshCw, X } from "lucide-react";
import { cancelRunAction, listRunsAction, listRunStepsAction } from "../actions";
import {
    LoadFailed,
    nodeTitle,
    RowsSkeleton,
    StatusChip,
    useCachedAction,
    useRunError,
    when
} from "../shared";

function took(start: string | null, end: string | null): string {
    if (!start || !end) return "";
    const seconds = Math.max(
        0,
        Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000)
    );
    return seconds < 60
        ? `${seconds}s`
        : seconds < 3600
          ? `${Math.round(seconds / 60)}m`
          : `${Math.round(seconds / 3600)}h`;
}

/** A step's own status, drawn with the run chip that means the same thing. */
const STEP_AS_RUN: Record<string, string> = {
    ok: "succeeded",
    ready: "queued",
    interrupted: "stopped"
};

export function RunsView({ automationId }: { automationId: string | null }) {
    const t = useTranslations("automations");
    const locale = useLocale();
    const toast = useToast();
    const words = useRunError();
    const { data, error, refresh, replace } = useCachedAction(
        `polaris.automations.runs.${automationId ?? "all"}`,
        () => listRunsAction(automationId ?? undefined)
    );
    const [older, setOlder] = useState<{ rows: RunRow[]; next: string | null } | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

    const rows = data ? [...data.rows, ...(older?.rows ?? [])] : [];
    const next = older ? older.next : (data?.next ?? null);

    const reload = () => {
        setOlder(null);
        void refresh();
    };

    const loadMore = async () => {
        if (!next) return;
        setLoadingMore(true);
        const answer = await listRunsAction(automationId ?? undefined, next).catch(() => null);
        setLoadingMore(false);
        if (!answer?.ok) return void toast.show({ title: answer?.error || t("runs.loadFailed") });
        setOlder((current) => ({
            rows: [...(current?.rows ?? []), ...answer.rows],
            next: answer.next
        }));
    };

    const markCancelled = (id: string, cancelled: boolean, before?: RunRow) => {
        const change = (row: RunRow) =>
            row.id !== id
                ? row
                : cancelled
                  ? { ...row, status: "cancelled", canCancel: false }
                  : (before ?? row);
        replace((current) => ({ ...current, rows: current.rows.map(change) }));
        setOlder((current) => (current ? { ...current, rows: current.rows.map(change) } : current));
    };

    const cancel = async (row: RunRow) => {
        markCancelled(row.id, true);
        const answer = await cancelRunAction(row.id);
        if (!answer.ok) {
            markCancelled(row.id, false, row);
            toast.show({ title: answer.error });
            return;
        }
        toast.show({ title: t("runs.cancelled") });
        reload();
    };

    const toggle = (id: string) =>
        setOpen((current) => {
            const copy = new Set(current);
            if (!copy.delete(id)) copy.add(id);
            return copy;
        });

    return (
        <div className="space-y-4">
            <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={reload}>
                    <RefreshCw aria-hidden="true" />
                    {t("runs.refresh")}
                </Button>
            </div>
            {error !== null && !data ? (
                <LoadFailed message={error || t("runs.loadFailed")} onRetry={reload} />
            ) : !data ? (
                <RowsSkeleton />
            ) : rows.length === 0 ? (
                <EmptyState
                    icon={<History aria-hidden="true" />}
                    title={t("runs.empty")}
                    description={t("runs.emptyHint")}
                />
            ) : (
                <>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {rows.map((row) => {
                            const expanded = open.has(row.id);
                            return (
                                <li key={row.id} className="p-3">
                                    <div className="flex flex-wrap items-center gap-3">
                                        <Button
                                            variant="ghost"
                                            size="icon-sm"
                                            aria-expanded={expanded}
                                            aria-label={
                                                expanded ? t("runs.hideSteps") : t("runs.showSteps")
                                            }
                                            title={
                                                expanded ? t("runs.hideSteps") : t("runs.showSteps")
                                            }
                                            onClick={() => toggle(row.id)}
                                        >
                                            {expanded ? (
                                                <ChevronDown aria-hidden="true" />
                                            ) : (
                                                <ChevronRight aria-hidden="true" />
                                            )}
                                        </Button>
                                        <div className="min-w-0 flex-1">
                                            <Link
                                                href={`/automations/${row.automationId}`}
                                                className="block truncate text-sm font-medium hover:underline"
                                                title={row.automationName}
                                            >
                                                {row.automationName}
                                            </Link>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {when(row.startedAt ?? row.queuedAt, locale)}
                                                {row.finishedAt
                                                    ? ` - ${took(row.startedAt, row.finishedAt)}`
                                                    : ""}
                                                {row.error ? ` - ${words(row.error)}` : ""}
                                                {row.finally === "failed"
                                                    ? ` - ${t("runs.finallyFailed")}`
                                                    : ""}
                                            </p>
                                        </div>
                                        <StatusChip status={row.status} />
                                        {row.canCancel ? (
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label={t("runs.cancel")}
                                                title={t("runs.cancel")}
                                                onClick={() => void cancel(row)}
                                            >
                                                <X aria-hidden="true" />
                                            </Button>
                                        ) : null}
                                    </div>
                                    {expanded ? <RunSteps runId={row.id} /> : null}
                                </li>
                            );
                        })}
                    </ul>
                    {next ? (
                        <div className="flex justify-center">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={loadingMore}
                                onClick={() => void loadMore()}
                            >
                                {t("runs.loadMore")}
                            </Button>
                        </div>
                    ) : null}
                </>
            )}
        </div>
    );
}

function RunSteps({ runId }: { runId: string }) {
    const t = useTranslations("automations");
    const locale = useLocale();
    const words = useRunError();
    const { data, error, refresh } = useCachedAction(`polaris.automations.run.${runId}`, () =>
        listRunStepsAction(runId)
    );

    if (error !== null && !data)
        return (
            <div className="mt-3">
                <LoadFailed
                    message={error || t("runs.stepsFailed")}
                    onRetry={() => void refresh()}
                />
            </div>
        );
    if (!data)
        return (
            <div className="mt-3 space-y-2" aria-hidden="true">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
            </div>
        );
    if (data.steps.length === 0)
        return <p className="mt-3 text-xs text-muted-foreground">{t("runs.noSteps")}</p>;
    return (
        <ol className="mt-3 space-y-2">
            {data.steps.map((step) => (
                <StepRow
                    key={step.id}
                    step={step}
                    canSeeData={data.canSeeData}
                    locale={locale}
                    words={words}
                />
            ))}
        </ol>
    );
}

function StepRow({
    step,
    canSeeData,
    locale,
    words
}: {
    step: RunStepRow;
    canSeeData: boolean;
    locale: string;
    words: (code: string | null) => string | null;
}) {
    const t = useTranslations("automations");
    const [showData, setShowData] = useState(false);
    const hasData = canSeeData && (step.input !== null || step.output !== null);
    return (
        <li className="rounded-md bg-muted/40 p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                        {step.type ? nodeTitle(t, step.type) : step.nodeId}
                        {step.lane === "finally" ? (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                                {t("editor.always")}
                            </span>
                        ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                        {when(step.startedAt, locale)}
                        {step.finishedAt ? ` - ${took(step.startedAt, step.finishedAt)}` : ""}
                        {step.error ? ` - ${words(step.error)}` : ""}
                    </p>
                </div>
                <StatusChip status={STEP_AS_RUN[step.status] ?? step.status} />
                {hasData ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={showData}
                        onClick={() => setShowData((value) => !value)}
                    >
                        {showData ? t("runs.hideData") : t("runs.showData")}
                    </Button>
                ) : null}
            </div>
            {showData ? (
                <div className="mt-2 grid min-w-0 gap-2 md:grid-cols-2">
                    <StepData label={t("runs.input")} value={step.input} />
                    <StepData label={t("runs.output")} value={step.output} />
                </div>
            ) : null}
        </li>
    );
}

function StepData({ label, value }: { label: string; value: unknown }) {
    const text = value === null ? "" : JSON.stringify(value, null, 2);
    return (
        <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <pre className="max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap break-all rounded bg-background p-2 text-xs">
                {text || "-"}
            </pre>
        </div>
    );
}
