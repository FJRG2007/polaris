"use client";

import Link from "next/link";
import { History, RefreshCw, X } from "lucide-react";
import { Button, EmptyState, useToast } from "@polaris/ui";
import { cancelRunAction, listRunsAction } from "../actions";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { LoadFailed, RowsSkeleton, StatusChip, useCachedAction, useRunError, when } from "../shared";

function took(start: string | null, end: string | null): string {
    if (!start || !end) return "";
    const seconds = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
    return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
}

export function RunsView({ automationId }: { automationId: string | null }) {
    const t = useTranslations("automations");
    const locale = useLocale();
    const toast = useToast();
    const words = useRunError();
    const { data, error, refresh, replace } = useCachedAction(`polaris.automations.runs.${automationId ?? "all"}`, () => listRunsAction(automationId ?? undefined));

    const cancel = async (id: string) => {
        const before = data;
        replace((current) => ({ ...current, rows: current.rows.map((row) => (row.id === id ? { ...row, status: "cancelled", canCancel: false } : row)) }));
        const answer = await cancelRunAction(id);
        if (!answer.ok) {
            if (before) replace(() => before);
            toast.show({ title: answer.error });
            return;
        }
        toast.show({ title: t("runs.cancelled") });
        void refresh();
    };

    return (
        <div className="space-y-4">
            <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => void refresh()}>
                    <RefreshCw aria-hidden="true" />
                    {t("runs.refresh")}
                </Button>
            </div>
            {error !== null && !data ? (
                <LoadFailed message={error || t("runs.loadFailed")} onRetry={() => void refresh()} />
            ) : !data ? (
                <RowsSkeleton />
            ) : data.rows.length === 0 ? (
                <EmptyState icon={<History aria-hidden="true" />} title={t("runs.empty")} description={t("runs.emptyHint")} />
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {data.rows.map((row) => (
                        <li key={row.id} className="flex flex-wrap items-center gap-3 p-3">
                            <div className="min-w-0 flex-1">
                                <Link href={`/automations/${row.automationId}`} className="block truncate text-sm font-medium hover:underline" title={row.automationName}>
                                    {row.automationName}
                                </Link>
                                <p className="truncate text-xs text-muted-foreground">
                                    {when(row.startedAt ?? row.queuedAt, locale)}
                                    {row.finishedAt ? ` - ${took(row.startedAt, row.finishedAt)}` : ""}
                                    {row.error ? ` - ${words(row.error)}` : ""}
                                    {row.finally === "failed" ? ` - ${t("runs.finallyFailed")}` : ""}
                                </p>
                            </div>
                            <StatusChip status={row.status} />
                            {row.canCancel ? (
                                <Button variant="ghost" size="icon-sm" aria-label={t("runs.cancel")} title={t("runs.cancel")} onClick={() => void cancel(row.id)}>
                                    <X aria-hidden="true" />
                                </Button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
