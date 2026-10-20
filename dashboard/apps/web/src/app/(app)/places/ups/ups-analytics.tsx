"use client";

/**
 * Every UPS side by side: daily energy on one chart, and per UPS what it
 * used and cost, how often the power went, its events and its load. Each
 * name opens that UPS. Shown under the list once there are two or more.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { formatMoney, type UpsAnalyticsAnswer } from "./ups-words";
import { MultiSeriesChart, SegmentedControl, Skeleton } from "@polaris/ui";

const SPANS = { d7: 7, d30: 30, d90: 90, d365: 365 } as const;
type Span = keyof typeof SPANS;

export function UpsAnalytics() {
    const t = useTranslations("servers");
    const [span, setSpan] = useState<Span>("d30");
    const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
    const live = useLiveResource<UpsAnalyticsAnswer>({
        url: `/api/servers/ups/analytics?days=${SPANS[span]}&tz=${encodeURIComponent(tz)}`,
        cacheKey: `ups:analytics:${span}`,
        intervalMs: 120_000,
        select: (body) => body as UpsAnalyticsAnswer
    });
    const answer = live.data;
    const series = useMemo(
        () =>
            answer?.rows.map((row) => ({
                key: row.upsId,
                label: row.name,
                points: answer.daily
                    .filter((one) => one.upsId === row.upsId)
                    .map((one) => ({ t: Date.parse(one.ts), v: one.kwh }))
            })) ?? null,
        [answer]
    );
    const to = Date.now();
    const from = to - SPANS[span] * 86_400_000;

    return (
        <section aria-labelledby="ups-analytics" className="mt-8 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="ups-analytics" className="text-sm font-medium">
                    {t("ups.analytics.title")}
                </h2>
                <SegmentedControl<Span>
                    size="sm"
                    aria-label={t("ups.analytics.title")}
                    value={span}
                    onValueChange={setSpan}
                    options={(Object.keys(SPANS) as Span[]).map((key) => ({
                        value: key,
                        label: t("ups.events.days", { count: SPANS[key] })
                    }))}
                />
            </div>
            {series === null ? (
                <Skeleton className="h-48 w-full" />
            ) : (
                <MultiSeriesChart
                    label={t("ups.analytics.chart")}
                    series={series}
                    from={from}
                    to={to}
                    format={(value) => t("ups.units.kwh", { value: value.toFixed(2) })}
                />
            )}
            {answer === null ? (
                <Skeleton className="h-24 w-full" />
            ) : (
                <div className="overflow-x-auto rounded-md border">
                    <table className="w-full min-w-[36rem] text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2 font-normal">{t("ups.analytics.ups")}</th>
                                <th className="px-3 py-2 text-right font-normal">
                                    {t("ups.energy.kwh")}
                                </th>
                                <th className="px-3 py-2 text-right font-normal">
                                    {t("ups.energy.cost")}
                                </th>
                                <th className="px-3 py-2 text-right font-normal">
                                    {t("ups.analytics.outages")}
                                </th>
                                <th className="px-3 py-2 text-right font-normal">
                                    {t("ups.analytics.events")}
                                </th>
                                <th className="px-3 py-2 text-right font-normal">
                                    {t("ups.analytics.load")}
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {answer.rows.map((row) => (
                                <tr key={row.upsId} className="border-t">
                                    <td className="max-w-48 truncate px-3 py-2">
                                        <Link
                                            href={`/places/ups/${row.upsId}`}
                                            className="hover:underline"
                                            title={row.name}
                                        >
                                            {row.name}
                                        </Link>
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {row.kwh.toFixed(2)}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {row.costs
                                            .filter((one) => one.cost > 0)
                                            .map((one) => formatMoney(one.cost, one.currency))
                                            .join(" + ") || "-"}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {row.outages}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        <Link
                                            href={`/places/ups/${row.upsId}?tab=events`}
                                            className="hover:underline"
                                        >
                                            {row.events}
                                        </Link>
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {row.avgLoad === null
                                            ? "-"
                                            : t("ups.analytics.loadValue", {
                                                  avg: Math.round(row.avgLoad),
                                                  max: Math.round(row.maxLoad ?? row.avgLoad)
                                              })}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
