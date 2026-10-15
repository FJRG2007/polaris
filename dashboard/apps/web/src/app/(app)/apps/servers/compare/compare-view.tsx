"use client";

/**
 * Two to four servers read against each other: one chart per metric with a line
 * per server on the same axes, and the latest reading of each in a table.
 *
 * The picker, the range and the table's headings paint at once; only the charts
 * and the readings wait on the answer, and a pick seen before paints from what
 * this tab kept of it while the fresh one is read. The pick and the range are
 * written into the address so the comparison can be shared or reloaded.
 */

import Link from "next/link";
import { Check } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { useEffect, useMemo, useState } from "react";
import {
    Button,
    cn,
    EmptyState,
    MultiSeriesChart,
    SegmentedControl,
    SERIES_COLORS,
    Skeleton,
    type ChartSeries
} from "@polaris/ui";
import { formatMetric } from "../insights/insight-format";
import { COMPARE_MAX } from "@/lib/server-insights/request";
import { useDisplayFormat } from "@/components/display-format";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { InsightMetric } from "@/lib/server-insights/insights";
import { LIVE_INTERVAL_MS, RANGE_ORDER, type MetricPoint, type RangePreset } from "@/lib/metrics-shared";

export interface CompareServer {
    id: string;
    name: string;
}

interface Answer {
    from: number;
    to: number;
    servers: { id: string; points: MetricPoint[] }[];
}

const METRICS: readonly InsightMetric[] = ["cpu", "memory", "disk", "network"];

function share(used: number | null, total: number | null): number | null {
    return used == null || total == null || total <= 0 ? null : (used / total) * 100;
}

/** One metric's value at a point, in the units the charts draw it in. */
export function metricAt(point: MetricPoint, metric: InsightMetric): number | null {
    switch (metric) {
        case "cpu":
            return point.cpuPercent;
        case "memory":
            return share(point.memUsedBytes, point.memTotalBytes);
        case "disk":
            return share(point.diskUsedBytes, point.diskTotalBytes);
        case "network":
            if (point.netRxBytesPerSecond == null && point.netTxBytesPerSecond == null) return null;
            return (point.netRxBytesPerSecond ?? 0) + (point.netTxBytesPerSecond ?? 0);
    }
}

/** The newest reading of a metric in a series, or null when it has none. */
export function latestOf(points: readonly MetricPoint[], metric: InsightMetric): number | null {
    for (let index = points.length - 1; index >= 0; index--) {
        const value = metricAt(points[index]!, metric);
        if (value != null) return value;
    }
    return null;
}

function Swatch({ index }: { index: number }) {
    return (
        <span
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }}
            aria-hidden
        />
    );
}

export function CompareView({
    servers,
    initialIds,
    initialRange
}: {
    servers: readonly CompareServer[];
    initialIds: readonly string[];
    initialRange: RangePreset;
}) {
    const t = useTranslations("servers");
    const display = useDisplayFormat();
    const [ids, setIds] = useState<string[]>([...initialIds]);
    const [range, setRange] = useState<RangePreset>(initialRange);
    const byId = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
    const ready = ids.length >= 2;
    const query = ids.join(",");

    useEffect(() => {
        const url = new URL(window.location.href);
        url.searchParams.set("ids", query);
        url.searchParams.set("range", range);
        window.history.replaceState(window.history.state, "", url);
    }, [query, range]);

    const { data, error, stale, loading, refresh } = useLiveResource<Answer>({
        url: `/api/servers/compare?ids=${encodeURIComponent(query)}&range=${range}`,
        cacheKey: `servers.compare.${query}.${range}`,
        intervalMs: LIVE_INTERVAL_MS[range],
        enabled: ready,
        select: (body) => body as Answer
    });

    if (servers.length < 2) {
        return (
            <EmptyState
                title={t("compare.onlyOne")}
                action={
                    <Button asChild variant="secondary" size="sm">
                        <Link href="/apps/servers">{t("list.heading")}</Link>
                    </Button>
                }
            />
        );
    }

    function toggle(id: string) {
        setIds((current) =>
            current.includes(id)
                ? current.filter((one) => one !== id)
                : current.length >= COMPARE_MAX
                  ? current
                  : [...current, id]
        );
    }

    // Only an answer for exactly this pick is drawn: a kept answer for another
    // one would put lines under the wrong names.
    const answer = data && data.servers.map((one) => one.id).join(",") === query ? data : null;
    const failure = error ?? (answer === null ? stale : null);
    const full = ids.length >= COMPARE_MAX;
    const formatTime = (at: number) =>
        answer && answer.to - answer.from > 36 * 3_600_000 ? `${display.date(at)} ${display.time(at)}` : display.time(at);

    return (
        <div className="flex flex-col gap-5">
            <section className="flex flex-col gap-2" aria-labelledby="compare-pick">
                <div className="flex flex-wrap items-baseline gap-x-2">
                    <h2 id="compare-pick" className="text-sm font-medium">
                        {t("compare.pick")}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                        {t("compare.picked", { count: ids.length, max: COMPARE_MAX })}
                    </span>
                </div>
                <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto overscroll-y-contain">
                    {servers.map((server) => {
                        const index = ids.indexOf(server.id);
                        const on = index >= 0;
                        const blocked = !on && full;
                        return (
                            <button
                                key={server.id}
                                type="button"
                                aria-pressed={on}
                                aria-disabled={blocked}
                                title={blocked ? t("compare.maxReached", { max: COMPARE_MAX }) : server.name}
                                onClick={() => (blocked ? undefined : toggle(server.id))}
                                className={cn(
                                    "flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                                    on
                                        ? "border-primary/40 bg-primary/10 text-foreground"
                                        : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                                    blocked && "cursor-not-allowed opacity-50 hover:bg-transparent"
                                )}
                            >
                                {on ? <Swatch index={index} /> : null}
                                <span className="min-w-0 truncate" title={server.name}>{server.name}</span>
                                {on ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
                            </button>
                        );
                    })}
                </div>
                {full ? (
                    <p className="text-xs text-muted-foreground">{t("compare.maxReached", { max: COMPARE_MAX })}</p>
                ) : null}
            </section>

            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("compare.range")}</span>
                <SegmentedControl
                    size="sm"
                    value={range}
                    onValueChange={setRange}
                    aria-label={t("compare.range")}
                    options={RANGE_ORDER.map((preset) => ({ value: preset, label: preset }))}
                />
            </div>

            {!ready ? (
                <p className="text-sm text-muted-foreground">{t("compare.needTwo")}</p>
            ) : failure ? (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>{t("compare.failed", { reason: failure })}</span>
                    <Button variant="secondary" size="sm" onClick={refresh}>
                        {t("compare.retry")}
                    </Button>
                </div>
            ) : (
                <>
                    <section className="flex flex-col gap-2" aria-labelledby="compare-now">
                        <h2 id="compare-now" className="text-sm font-medium">
                            {t("compare.now")}
                        </h2>
                        <div className="overflow-x-auto overscroll-x-contain">
                            <table className="w-full min-w-[22rem] text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-muted-foreground">
                                        <th scope="col" className="py-1.5 pr-3 font-medium">
                                            {t("compare.server")}
                                        </th>
                                        {METRICS.map((metric) => (
                                            <th key={metric} scope="col" className="py-1.5 pr-3 text-right font-medium">
                                                {t(`metrics.${metric}`)}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {ids.map((id, index) => {
                                        const server = byId.get(id);
                                        const points = answer?.servers.find((one) => one.id === id)?.points ?? null;
                                        return (
                                            <tr key={id}>
                                                <th scope="row" className="max-w-[10rem] py-2 pr-3 text-left font-normal">
                                                    <Link
                                                        href={`/apps/servers/${encodeURIComponent(id)}`}
                                                        className="flex min-w-0 items-center gap-1.5 hover:underline"
                                                        title={server?.name}
                                                    >
                                                        <Swatch index={index} />
                                                        <span className="min-w-0 truncate">{server?.name ?? id}</span>
                                                    </Link>
                                                </th>
                                                {METRICS.map((metric) => (
                                                    <td key={metric} className="py-2 pr-3 text-right tabular-nums">
                                                        {points === null ? (
                                                            loading ? (
                                                                <Skeleton className="ml-auto h-4 w-12" />
                                                            ) : null
                                                        ) : (
                                                            (formatMetric(metric, latestOf(points, metric)) ?? (
                                                                <span className="text-xs text-muted-foreground">
                                                                    {t("compare.noReading")}
                                                                </span>
                                                            ))
                                                        )}
                                                    </td>
                                                ))}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </section>

                    <div className="grid gap-4 lg:grid-cols-2">
                        {METRICS.map((metric) => {
                            const series: ChartSeries[] = answer
                                ? ids.map((id) => ({
                                      key: id,
                                      label: byId.get(id)?.name ?? id,
                                      points: (answer.servers.find((one) => one.id === id)?.points ?? []).map(
                                          (point) => ({ t: point.t, v: metricAt(point, metric) })
                                      )
                                  }))
                                : [];
                            return (
                                <section key={metric} className="min-w-0" aria-label={t(`metrics.${metric}`)}>
                                    {answer ? (
                                        <MultiSeriesChart
                                            series={series}
                                            from={answer.from}
                                            to={answer.to}
                                            max={metric === "network" ? undefined : 100}
                                            format={(value) =>
                                                metric === "network"
                                                    ? `${formatBytes(Math.round(value))}/s`
                                                    : `${Math.round(value)}%`
                                            }
                                            formatTime={formatTime}
                                            label={t(`metrics.${metric}`)}
                                        />
                                    ) : (
                                        // The chart's own frame and title, so the heading is
                                        // there before the history and does not move after.
                                        <div className="rounded-lg border border-border/60 p-3">
                                            <span className="text-sm font-medium">{t(`metrics.${metric}`)}</span>
                                            <Skeleton className="mt-2 h-[132px] w-full" />
                                        </div>
                                    )}
                                </section>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
}
