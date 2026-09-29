"use client";

/**
 * One monitored thing in full: its history at every range, the alarms watching
 * it, and - for a service - the endpoints its project reports to.
 *
 * This is the screen a card opens, so it answers what a card deliberately does
 * not: exact figures, a choosable window, and what happens when a threshold is
 * crossed.
 */

import Link from "next/link";
import { Button, cn } from "@polaris/ui";
import { useMemo, useState } from "react";
import type { AlarmView } from "@/lib/watch-service";
import { ArrowLeft, Bell, ExternalLink } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import { ProjectWebhooks } from "@/components/project-webhooks";
import type { BreakdownMetric } from "@/lib/watch/breakdown-shape";
import { CONSUMPTION_METRICS, MetricsHistory } from "@/components/metrics-history";
import { alarmUnit } from "@/lib/watch/alarm-metrics";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { alarmStateWord, metricWord, thresholdWords, watchText } from "@/lib/watch/words";
import {
    breakdownTitle,
    MetricBreakdownDialog,
    type OpenBreakdown
} from "@/app/(app)/watch/watch-metric-breakdown";

export function WatchSubjectDetail({
    kind,
    id,
    name,
    detail,
    projectId,
    serviceHref,
    alarms,
    breakdowns
}: {
    kind: "server" | "service";
    id: string;
    name: string;
    detail: string;
    /** Set for a service, so its project's webhooks can be shown here too. */
    projectId?: string;
    serviceHref?: string;
    alarms: AlarmView[];
    /** The metrics whose cards may be opened to see what is behind them. Worked
     *  out on the server, because whether there is an answer depends on what is
     *  deployed here and on what the reader is allowed to see of the machine. */
    breakdowns: BreakdownMetric[];
}) {
    const display = useDisplayFormat();
    const t = useTranslations("watch");
    const [tab, setTab] = useState<"metrics" | "alarms" | "webhooks">("metrics");
    const [opened, setOpened] = useState<OpenBreakdown | null>(null);
    const tabs: { id: typeof tab; label: string }[] = [
        { id: "metrics", label: t("subject.metrics") },
        { id: "alarms", label: t("subject.alarms", { count: alarms.length }) },
        ...(projectId ? [{ id: "webhooks" as const, label: t("webhooks.title") }] : [])
    ];

    // A server's series is keyed by host id under a subject of its own; a service
    // reuses the endpoint the Deploy panel already reads.
    const endpoint =
        kind === "server" ? `/api/watch/hosts/${id}/metrics/history` : `/api/deploy/apps/${id}/metrics/history`;
    // The collector's word that there is something new to draw.
    const live =
        kind === "server" ? `/api/watch/hosts/${id}/metrics/stream` : `/api/deploy/apps/${id}/metrics/stream`;

    // The same four charts every consumption screen draws, with a way in under
    // the ones that have something behind them. The window comes from the chart
    // rather than from here, so the panel answers for the range on screen.
    const metrics = useMemo(
        () =>
            CONSUMPTION_METRICS.map((metric) => {
                const offered = breakdowns.find((entry) => entry === metric.key);
                if (!offered) return metric;
                return {
                    ...metric,
                    breakdown: {
                        label: breakdownTitle(t, offered),
                        open: (window: { from: number; to: number }) =>
                            setOpened({ metric: offered, ...window })
                    }
                };
            }),
        [breakdowns, t]
    );

    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <Link
                        href="/watch"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                        <ArrowLeft className="size-3" /> {t("overview.title")}
                    </Link>
                    <h1 title={name} className="mt-1 truncate text-[1.0625rem] font-semibold tracking-tight">
                        {name}
                    </h1>
                    <p title={watchText(t, detail)} className="truncate text-sm text-muted-foreground">
                        {watchText(t, detail)}
                    </p>
                </div>
                {serviceHref && (
                    <Button asChild variant="ghost" size="sm">
                        <Link href={serviceHref}>
                            <ExternalLink className="size-4" /> {t("subject.openInDeploy")}
                        </Link>
                    </Button>
                )}
            </div>

            <div className="flex gap-1 border-b border-border/60">
                {tabs.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        onClick={() => setTab(entry.id)}
                        aria-current={tab === entry.id ? "page" : undefined}
                        className={cn(
                            "-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors",
                            tab === entry.id
                                ? "border-primary font-medium text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {entry.label}
                    </button>
                ))}
            </div>

            {tab === "metrics" && (
                <div className="flex flex-col gap-2">
                    <MetricsHistory endpoint={endpoint} live={live} metrics={metrics} />
                    <p className="text-xs text-muted-foreground">
                        {kind === "server" ? t("subject.serverSource") : t("subject.serviceSource")}
                    </p>
                </div>
            )}

            {tab === "alarms" && (
                <div className="flex flex-col gap-3">
                    {alarms.length === 0 ? (
                        <div className="flex flex-col items-center gap-2 rounded-lg border border-border/60 px-4 py-10 text-center">
                            <Bell className="size-5 text-muted-foreground" />
                            <p className="text-sm text-muted-foreground">{t("subject.noAlarms")}</p>
                            <Button asChild variant="secondary" size="sm">
                                <Link href="/watch/alarms">{t("subject.createAlarm")}</Link>
                            </Button>
                        </div>
                    ) : (
                        <div className="overflow-hidden rounded-md border border-border/60">
                            {alarms.map((alarm) => (
                                <div
                                    key={alarm.id}
                                    className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5 last:border-0"
                                >
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">{alarm.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {t("alarms.line", {
                                                target:
                                                    alarm.threshold != null && alarmUnit(alarm.metric, alarm.targetType)
                                                        ? thresholdWords(t, { ...alarm, threshold: alarm.threshold })
                                                        : metricWord(t, alarm.metric),
                                                summary: alarm.lastEvaluatedAt
                                                    ? t("subject.checked", { time: display.dateTime(alarm.lastEvaluatedAt) })
                                                    : t("subject.notEvaluated")
                                            })}
                                        </p>
                                    </div>
                                    <span
                                        className={cn(
                                            "shrink-0 rounded-full border px-2 py-0.5 text-xs",
                                            alarm.state === "alarm"
                                                ? "border-danger-edge text-danger"
                                                : alarm.state === "ok"
                                                  ? "border-success-edge text-success"
                                                  : "border-border/60 text-muted-foreground"
                                        )}
                                    >
                                        {alarmStateWord(t, alarm.state)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                    <Link href="/watch/alarms" className="text-xs text-primary hover:underline">
                        {t("subject.manage")}
                    </Link>
                </div>
            )}

            {tab === "webhooks" && projectId && <ProjectWebhooks projectId={projectId} />}

            <MetricBreakdownDialog
                subject={{ kind, id }}
                open={opened}
                onClose={() => setOpened(null)}
            />
        </div>
    );
}
