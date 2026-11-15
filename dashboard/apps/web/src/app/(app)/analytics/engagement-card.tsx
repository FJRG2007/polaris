"use client";

/**
 * How far down each page people scrolled and how long they stayed on it, from
 * the tracker's leave beat. Raw views only, so a range past 31 days says so
 * instead of showing an empty table.
 */

import { grouped } from "./analytics-format";
import { MousePointerClick } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { Empty, Failure, Rows, useReport, type PanelProps } from "./analytics-reports";

/** "1m 05s" or "42s" for a duration in milliseconds. */
export function pageTime(ms: number | null): string {
    if (ms === null) return "-";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function EngagementCard(props: PanelProps) {
    const t = useTranslations("analytics");
    const { answer, error, loading } = useReport<"engagement">(props, { kind: "engagement" });
    const report = answer?.report ?? null;

    return (
        <Card className="min-w-0">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                    <MousePointerClick className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {t("engagement.title")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 pt-0">
                <Failure message={error} />
                {!report && loading ? (
                    <Rows count={4} />
                ) : report?.unavailable ? (
                    <Empty>{t("engagement.unavailable")}</Empty>
                ) : !report || report.pages.length === 0 ? (
                    <Empty>{t("engagement.empty")}</Empty>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[32rem] text-sm">
                            <thead className="text-start text-xs text-muted-foreground">
                                <tr>
                                    <th className="py-1 pe-3 font-medium">{t("engagement.page")}</th>
                                    <th className="py-1 pe-3 text-end font-medium">{t("engagement.scroll")}</th>
                                    <th className="py-1 pe-3 text-end font-medium">{t("engagement.deep")}</th>
                                    <th className="py-1 pe-3 text-end font-medium">{t("engagement.time")}</th>
                                    <th className="py-1 text-end font-medium">{t("engagement.views")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {report.pages.map((row) => (
                                    <tr key={row.path} className="border-t border-border/60">
                                        <td className="max-w-0 py-1.5 pe-3">
                                            <span className="block truncate font-mono text-xs" title={row.path}>
                                                {row.path}
                                            </span>
                                        </td>
                                        <td className="py-1.5 pe-3 text-end tabular-nums">
                                            {row.avgScroll === null ? "-" : `${row.avgScroll}%`}
                                        </td>
                                        <td className="py-1.5 pe-3 text-end tabular-nums">
                                            {row.deepShare === null ? "-" : `${Math.round(row.deepShare * 100)}%`}
                                        </td>
                                        <td className="py-1.5 pe-3 text-end tabular-nums">{pageTime(row.avgEngagedMs)}</td>
                                        <td className="py-1.5 text-end tabular-nums">{grouped(row.measured)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </CardBody>
        </Card>
    );
}
