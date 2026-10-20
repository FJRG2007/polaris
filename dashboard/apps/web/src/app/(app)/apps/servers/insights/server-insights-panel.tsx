"use client";

/**
 * What was unusual on a set of servers lately, and when each one's disk fills.
 *
 * Shared by the Insights screen (every server) and a server's own page (that one
 * alone). The headings paint at once; only the forecast cards and the list wait
 * on the answer, and a revisit paints the last answer this tab kept while the
 * new one is read. The figures come from hourly rollups, so a slow poll is all
 * this needs.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronDown, HardDrive } from "lucide-react";
import {
    Badge,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Skeleton
} from "@polaris/ui";
import { formatBytes } from "@polaris/core";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { formatMetric } from "./insight-format";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    ANOMALY_MIN_HISTORY,
    FORECAST_DEFAULTS,
    type DiskForecast
} from "@/lib/server-insights/stats";
import type { InsightAnomaly, ServerInsight } from "@/lib/server-insights/insights";

/** The rollups behind this change once an hour; five minutes is plenty. */
const REFRESH_MS = 5 * 60_000;

export interface InsightServer {
    id: string;
    name: string;
}

type Answer = (ServerInsight & { id: string })[];

function forecastHeadline(forecast: DiskForecast, t: NamespaceTranslator<"servers">): string {
    switch (forecast.kind) {
        case "insufficient":
            return t("insights.forecast.insufficient", { needed: FORECAST_DEFAULTS.minSpanDays });
        case "full":
            return t("insights.forecast.full");
        case "steady":
            return t("insights.forecast.steady");
        case "filling":
            return forecast.days < 1
                ? t("insights.forecast.soon")
                : t("insights.forecast.filling", { days: Math.round(forecast.days) });
    }
}

function ForecastCard({
    server,
    insight,
    showName
}: {
    server: InsightServer;
    insight: ServerInsight;
    showName: boolean;
}) {
    const t = useTranslations("servers");
    const forecast = insight.forecast;
    const rate = "bytesPerDay" in forecast ? forecast.bytesPerDay : null;
    const used = forecast.usedBytes;
    const total = forecast.totalBytes;
    return (
        <li className="flex min-w-0 flex-col gap-1 rounded-lg bg-muted/40 p-3">
            <div className="flex min-w-0 items-center gap-2">
                <HardDrive className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                {showName ? (
                    <Link
                        href={`/apps/servers/${encodeURIComponent(server.id)}`}
                        className="min-w-0 truncate text-sm font-medium hover:underline"
                        title={server.name}
                    >
                        {server.name}
                    </Link>
                ) : null}
                {insight.diskWarning ? (
                    <Badge
                        variant={forecast.kind === "full" ? "danger" : "warning"}
                        className="ml-auto shrink-0"
                    >
                        {t("insights.forecast.warn")}
                    </Badge>
                ) : null}
            </div>
            <p
                className={
                    forecast.kind === "insufficient" ? "text-xs text-muted-foreground" : "text-sm"
                }
            >
                {forecastHeadline(forecast, t)}
            </p>
            {used != null && total != null ? (
                <p className="text-xs text-muted-foreground">
                    {t("insights.forecast.used", {
                        used: formatBytes(used),
                        total: formatBytes(total)
                    })}
                </p>
            ) : null}
            {rate != null && forecast.kind !== "full" && Math.abs(rate) >= 1 ? (
                <p className="text-xs text-muted-foreground">
                    {rate > 0
                        ? t("insights.forecast.growing", { rate: formatBytes(Math.round(rate)) })
                        : t("insights.forecast.shrinking", {
                              rate: formatBytes(Math.round(-rate))
                          })}
                </p>
            ) : null}
            {"spanDays" in forecast && forecast.kind !== "insufficient" ? (
                <p className="text-xs text-muted-foreground">
                    {t("insights.forecast.basis", {
                        days: Math.max(1, Math.round(forecast.spanDays))
                    })}
                </p>
            ) : null}
        </li>
    );
}

function AnomalyRow({
    anomaly,
    server,
    showName
}: {
    anomaly: InsightAnomaly;
    server: InsightServer;
    showName: boolean;
}) {
    const t = useTranslations("servers");
    const display = useDisplayFormat();
    const value = formatMetric(anomaly.metric, anomaly.peakValue) ?? "";
    const usual = formatMetric(anomaly.metric, anomaly.baseline) ?? "";
    return (
        <li className="flex min-w-0 flex-col gap-1 py-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <Badge
                    variant={anomaly.severity === "danger" ? "danger" : "warning"}
                    className="shrink-0"
                >
                    {t(
                        anomaly.severity === "danger"
                            ? "insights.anomalies.danger"
                            : "insights.anomalies.warning"
                    )}
                </Badge>
                <span className="text-sm font-medium">
                    {t(`metrics.${anomaly.metric}`)} -{" "}
                    {t(
                        anomaly.direction === "high"
                            ? "insights.anomalies.high"
                            : "insights.anomalies.low"
                    )}
                </span>
                {showName ? (
                    <Link
                        href={`/apps/servers/${encodeURIComponent(server.id)}`}
                        className="min-w-0 truncate text-xs text-muted-foreground hover:underline"
                        title={server.name}
                    >
                        {server.name}
                    </Link>
                ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
                <time dateTime={new Date(anomaly.start).toISOString()}>
                    {display.dateTime(anomaly.start)}
                </time>
                {anomaly.end > anomaly.start
                    ? ` ${t("insights.anomalies.lasted", { time: display.time(anomaly.end) })}`
                    : null}
                {" - "}
                {t("insights.anomalies.value", { value, usual })}
            </p>
        </li>
    );
}

export function ServerInsightsPanel({
    servers,
    initialFilter = null
}: {
    servers: readonly InsightServer[];
    /** A server id to start the list on, from a link into the screen. */
    initialFilter?: string | null;
}) {
    const t = useTranslations("servers");
    const ids = servers.map((server) => server.id).join(",");
    const single = servers.length === 1;
    const [filter, setFilter] = useState<string | null>(
        initialFilter && servers.some((server) => server.id === initialFilter)
            ? initialFilter
            : null
    );
    const { data, error, stale, loading, refresh } = useLiveResource<Answer>({
        url: `/api/servers/insights?ids=${encodeURIComponent(ids)}`,
        cacheKey: `servers.insights.${ids}`,
        intervalMs: REFRESH_MS,
        enabled: servers.length > 0,
        select: (body) => (body as { servers: Answer }).servers
    });

    const byId = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
    const answered = (data ?? []).filter((insight) => byId.has(insight.id));
    const inScope = answered.filter((insight) => filter === null || insight.id === filter);
    // An answer cached before the field existed counts as enough history.
    const tooNew =
        inScope.length > 0 &&
        inScope.every(
            (insight) => (insight.historyHours ?? Number.POSITIVE_INFINITY) <= ANOMALY_MIN_HISTORY
        );
    const anomalies = inScope
        .flatMap((insight) =>
            insight.anomalies.map((anomaly) => ({ anomaly, server: byId.get(insight.id)! }))
        )
        .sort((a, b) => b.anomaly.start - a.anomaly.start);
    const failure = error ?? (data === null ? stale : null);
    const filterName = filter ? byId.get(filter)?.name : null;

    return (
        <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2" aria-labelledby="insights-forecast">
                <h2 id="insights-forecast" className="text-sm font-medium">
                    {t("insights.forecast.heading")}
                </h2>
                {failure ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{t("insights.failed", { reason: failure })}</span>
                        <Button variant="secondary" size="sm" onClick={refresh}>
                            {t("compare.retry")}
                        </Button>
                    </div>
                ) : loading || data === null ? (
                    <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {servers.slice(0, 3).map((server) => (
                            <li key={server.id}>
                                <Skeleton className="h-24 w-full" />
                            </li>
                        ))}
                    </ul>
                ) : (
                    <ul
                        className={
                            single ? "grid gap-2" : "grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
                        }
                    >
                        {answered.map((insight) => (
                            <ForecastCard
                                key={insight.id}
                                server={byId.get(insight.id)!}
                                insight={insight}
                                showName={!single}
                            />
                        ))}
                    </ul>
                )}
            </section>

            <section className="flex flex-col gap-2" aria-labelledby="insights-anomalies">
                <div className="flex flex-wrap items-center gap-2">
                    <h2 id="insights-anomalies" className="text-sm font-medium">
                        {t("insights.anomalies.heading")}
                    </h2>
                    {single ? null : (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="ml-auto max-w-full min-w-0"
                                    aria-label={t("insights.anomalies.filter")}
                                    title={t("insights.anomalies.filter")}
                                >
                                    <span className="min-w-0 truncate">
                                        {filterName ?? t("insights.anomalies.allServers")}
                                    </span>
                                    <ChevronDown className="size-4 shrink-0" aria-hidden />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                align="end"
                                className="max-h-[min(18rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto overscroll-y-contain"
                            >
                                <DropdownMenuItem onSelect={() => setFilter(null)}>
                                    {t("insights.anomalies.allServers")}
                                </DropdownMenuItem>
                                {servers.map((server) => (
                                    <DropdownMenuItem
                                        key={server.id}
                                        onSelect={() => setFilter(server.id)}
                                    >
                                        <span className="min-w-0 truncate" title={server.name}>
                                            {server.name}
                                        </span>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
                <p className="text-xs text-muted-foreground">{t("insights.anomalies.hint")}</p>
                {failure ? null : loading || data === null ? (
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-12 w-full" />
                        <Skeleton className="h-12 w-full" />
                    </div>
                ) : anomalies.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        {tooNew
                            ? t("insights.anomalies.tooNew", { hours: ANOMALY_MIN_HISTORY + 1 })
                            : t("insights.anomalies.none")}
                    </p>
                ) : (
                    <ul className="max-h-[32rem] divide-y divide-border overflow-y-auto overscroll-y-contain">
                        {anomalies.map(({ anomaly, server }) => (
                            <AnomalyRow
                                key={`${server.id}:${anomaly.metric}:${anomaly.start}`}
                                anomaly={anomaly}
                                server={server}
                                showName={!single}
                            />
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
