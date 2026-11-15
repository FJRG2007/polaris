"use client";

/**
 * Core Web Vitals as the site's visitors experienced them: the 75th percentile
 * of each metric over the window, then per page. Field data from the tracker's
 * `data-vitals` option; the ratings come from `@polaris/core`, so this card and
 * the Stats API can never disagree about what "poor" is.
 */

import { Gauge } from "lucide-react";
import * as core from "@polaris/core";
import { grouped } from "./analytics-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Card, CardBody, CardHeader, CardTitle, cn } from "@polaris/ui";
import { Empty, Failure, Rows, useReport, type PanelProps } from "./analytics-reports";

const BAND_INK: Readonly<Record<core.WebVitalBand, string>> = {
    good: "text-success-ink",
    improve: "text-warning-ink",
    poor: "text-danger-ink",
    unknown: "text-muted-foreground"
};

/** A timing in ms or s, CLS as a score; a metric nobody measured is a dash, never zero. */
export function formatVital(metric: core.WebVital, value: number | null): string {
    if (value === null) return "-";
    if (metric === "cls") return value.toFixed(2);
    return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

export function VitalsCard(props: PanelProps) {
    const t = useTranslations("analytics");
    const { answer, error, loading } = useReport<"vitals">(props, { kind: "vitals" });
    const report = answer?.report ?? null;
    const label = (metric: core.WebVital) => t(`vitals.metric.${metric}`);
    const band = (metric: core.WebVital, value: number | null) => t(`vitals.band.${core.webVitalBand(metric, value)}`);

    return (
        <Card className="min-w-0">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                    <Gauge className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {t("vitals.title")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4 pt-0">
                <Failure message={error} />
                {!report && loading ? (
                    <Rows count={3} />
                ) : report?.unavailable ? (
                    <Empty>{t("vitals.unavailable")}</Empty>
                ) : !report || report.overall.samples === 0 ? (
                    <Empty>{t("vitals.none")}</Empty>
                ) : (
                    <>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                            {core.WEB_VITALS.map((metric) => {
                                const value = report.overall[metric];
                                return (
                                    <div key={metric} className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border p-3">
                                        <span className="truncate text-xs text-muted-foreground" title={t(`vitals.hint.${metric}`)}>
                                            {label(metric)}
                                        </span>
                                        <span className={cn("truncate text-xl font-semibold tabular-nums", BAND_INK[core.webVitalBand(metric, value)])}>
                                            {formatVital(metric, value)}
                                        </span>
                                        <span className="truncate text-xs text-muted-foreground">{band(metric, value)}</span>
                                    </div>
                                );
                            })}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("vitals.samples", { count: grouped(report.overall.samples) })}
                        </p>
                        <div className="min-w-0 overflow-x-auto">
                            <table className="w-full min-w-[36rem] text-sm">
                                <thead>
                                    <tr className="text-start text-xs text-muted-foreground">
                                        <th className="py-1 pe-3 font-medium">{t("vitals.page")}</th>
                                        {(["lcp", "inp", "cls"] as const).map((metric) => (
                                            <th key={metric} className="py-1 pe-3 text-end font-medium">
                                                {label(metric)}
                                            </th>
                                        ))}
                                        <th className="py-1 text-end font-medium">{t("vitals.pageSamples")}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.pages.map((row) => (
                                        <tr key={row.path} className="border-t border-border">
                                            <td className="max-w-0 py-1.5 pe-3">
                                                <span className="block truncate" title={row.path}>
                                                    {row.path}
                                                </span>
                                            </td>
                                            {(["lcp", "inp", "cls"] as const).map((metric) => (
                                                <td
                                                    key={metric}
                                                    className={cn("py-1.5 pe-3 text-end tabular-nums", BAND_INK[core.webVitalBand(metric, row[metric])])}
                                                    title={band(metric, row[metric])}
                                                >
                                                    {formatVital(metric, row[metric])}
                                                </td>
                                            ))}
                                            <td className="py-1.5 text-end tabular-nums text-muted-foreground">{grouped(row.samples)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </CardBody>
        </Card>
    );
}
