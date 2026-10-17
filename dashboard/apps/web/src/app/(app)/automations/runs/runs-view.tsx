"use client";

import Link from "next/link";
import { useState } from "react";
import { History, RefreshCw, X } from "lucide-react";
import { cancelRunAction, listRunsAction } from "../actions";
import type { RunFilter, RunRow } from "@/lib/automations/history";
import { Button, EmptyState, SegmentedControl, useToast } from "@polaris/ui";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    LoadFailed,
    RowsSkeleton,
    StatusChip,
    useCachedAction,
    useRunError,
    when
} from "../shared";

export function took(start: string | null, end: string | null): string {
    if (!start || !end) return "";
    const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
    const seconds = Math.round(ms / 1000);
    return ms < 1000
        ? `${ms}ms`
        : seconds < 60
          ? `${seconds}s`
          : seconds < 3600
            ? `${Math.round(seconds / 60)}m`
            : `${Math.round(seconds / 3600)}h`;
}

export function RunsView({ automationId }: { automationId: string | null }) {
    const t = useTranslations("automations");
    const locale = useLocale();
    const toast = useToast();
    const words = useRunError();
    const [filter, setFilter] = useState<RunFilter>("all");
    const [more, setMore] = useState<{ rows: RunRow[]; next: string | null } | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const { data, error, refresh, replace } = useCachedAction(
        `polaris.automations.runs.${automationId ?? "all"}.${filter}`,
        () => listRunsAction(automationId ?? undefined, { filter })
    );
    const rows = [...(data?.rows ?? []), ...(more?.rows ?? [])];
    const next = more ? more.next : (data?.next ?? null);

    const cancel = async (id: string) => {
        const before = data;
        const beforeMore = more;
        const mark = (row: RunRow) =>
            row.id === id ? { ...row, status: "cancelled", canCancel: false } : row;
        replace((current) => ({ ...current, rows: current.rows.map(mark) }));
        setMore((current) => (current ? { ...current, rows: current.rows.map(mark) } : current));
        const answer = await cancelRunAction(id);
        if (!answer.ok) {
            if (before) replace(() => before);
            setMore(beforeMore);
            toast.show({ title: answer.error });
            return;
        }
        toast.show({ title: t("runs.cancelled") });
    };

    const loadMore = async () => {
        if (!next) return;
        setLoadingMore(true);
        const answer = await listRunsAction(automationId ?? undefined, {
            filter,
            cursor: next
        }).catch(() => null);
        setLoadingMore(false);
        if (!answer?.ok) return void toast.show({ title: answer?.error || t("runs.loadFailed") });
        setMore((current) => ({
            rows: [...(current?.rows ?? []), ...answer.rows],
            next: answer.next
        }));
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <SegmentedControl
                    size="sm"
                    value={filter}
                    aria-label={t("runView.filter")}
                    onValueChange={(value) => {
                        setFilter(value);
                        setMore(null);
                    }}
                    options={[
                        { value: "all", label: t("runView.filterAll") },
                        { value: "failed", label: t("runView.filterFailed") },
                        { value: "succeeded", label: t("runView.filterSucceeded") },
                        { value: "active", label: t("runView.filterActive") }
                    ]}
                />
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        setMore(null);
                        void refresh();
                    }}
                >
                    <RefreshCw aria-hidden="true" />
                    {t("runs.refresh")}
                </Button>
            </div>
            {error !== null && !data ? (
                <LoadFailed
                    message={error || t("runs.loadFailed")}
                    onRetry={() => void refresh()}
                />
            ) : !data ? (
                <RowsSkeleton />
            ) : rows.length === 0 ? (
                <EmptyState
                    icon={<History aria-hidden="true" />}
                    title={filter === "all" ? t("runs.empty") : t("runView.emptyFiltered")}
                    description={filter === "all" ? t("runs.emptyHint") : undefined}
                />
            ) : (
                <>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {rows.map((row) => (
                            <li key={row.id} className="flex flex-wrap items-center gap-3 p-3">
                                <div className="min-w-0 flex-1">
                                    <Link
                                        href={`/automations/runs/${row.id}`}
                                        className="block truncate text-sm font-medium hover:underline"
                                        title={`${t("runView.open")}: ${row.automationName}`}
                                    >
                                        {row.automationName}
                                    </Link>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {when(row.startedAt ?? row.queuedAt, locale)}
                                        {row.finishedAt
                                            ? ` - ${t("runView.took", { time: took(row.startedAt ?? row.queuedAt, row.finishedAt) })}`
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
                                        onClick={() => void cancel(row.id)}
                                    >
                                        <X aria-hidden="true" />
                                    </Button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                    {next ? (
                        <div className="flex justify-center">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={loadingMore}
                                onClick={() => void loadMore()}
                            >
                                {t("runView.loadMore")}
                            </Button>
                        </div>
                    ) : null}
                </>
            )}
        </div>
    );
}
