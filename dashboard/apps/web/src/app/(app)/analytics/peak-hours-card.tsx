"use client";

/**
 * When visits start, as a week of hours: one cell per weekday and hour in the
 * reader's own time zone, shaded by how many visits began in it. Raw visits
 * only, so a range past 31 days says so instead of drawing an empty week.
 */

import { useMemo } from "react";
import { Clock } from "lucide-react";
import { grouped } from "./analytics-format";
import { Card, CardBody, CardHeader, CardTitle } from "@polaris/ui";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { Empty, Failure, Rows, useReport, type PanelProps } from "./analytics-reports";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** ISO weekdays, Monday first. */
const DAYS = [1, 2, 3, 4, 5, 6, 7];

function readerTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

export function PeakHoursCard(props: PanelProps) {
    const t = useTranslations("analytics");
    const locale = useLocale();
    const timeZone = useMemo(readerTimeZone, []);
    const { answer, error, loading } = useReport<"peakHours">(props, { kind: "peakHours", timeZone });
    const report = answer?.report ?? null;

    const dayNames = useMemo(() => {
        const format = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
        // 2024-01-01 was a Monday.
        return DAYS.map((day) => format.format(Date.UTC(2024, 0, day)));
    }, [locale]);

    const grid = useMemo(() => {
        const cells = new Map<string, number>();
        for (const cell of report?.cells ?? []) cells.set(`${cell.day}:${cell.hour}`, cell.visitors);
        return cells;
    }, [report]);
    const max = Math.max(1, ...(report?.cells ?? []).map((cell) => cell.visitors));
    const busiest = (report?.cells ?? []).reduce<{ day: number; hour: number; visitors: number } | null>(
        (best, cell) => (!best || cell.visitors > best.visitors ? cell : best),
        null
    );

    return (
        <Card className="min-w-0">
            <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm">
                    <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {t("peak.title")}
                </CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 pt-0">
                <Failure message={error} />
                {!report && loading ? (
                    <Rows count={4} />
                ) : report?.unavailable ? (
                    <Empty>{t("peak.unavailable")}</Empty>
                ) : !report || report.cells.length === 0 ? (
                    <Empty>{t("breakdowns.noVisits")}</Empty>
                ) : (
                    <>
                        {busiest ? (
                            <p className="text-xs text-muted-foreground">
                                {t("peak.busiest", {
                                    day: dayNames[busiest.day - 1] ?? "",
                                    hour: `${String(busiest.hour).padStart(2, "0")}:00`
                                })}
                            </p>
                        ) : null}
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[34rem] border-separate border-spacing-0.5 text-[10px]">
                                <thead>
                                    <tr>
                                        <th className="w-10" />
                                        {HOURS.map((hour) => (
                                            <th key={hour} className="font-normal tabular-nums text-muted-foreground">
                                                {hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {DAYS.map((day) => (
                                        <tr key={day}>
                                            <th className="truncate pe-1 text-start font-normal text-muted-foreground">
                                                {dayNames[day - 1]}
                                            </th>
                                            {HOURS.map((hour) => {
                                                const visitors = grid.get(`${day}:${hour}`) ?? 0;
                                                const label = t("peak.cell", {
                                                    day: dayNames[day - 1] ?? "",
                                                    hour: `${String(hour).padStart(2, "0")}:00`,
                                                    visitors: grouped(visitors)
                                                });
                                                return (
                                                    <td
                                                        key={hour}
                                                        title={label}
                                                        aria-label={label}
                                                        className="h-5 rounded-sm bg-muted"
                                                    >
                                                        {visitors > 0 ? (
                                                            <span
                                                                className="block h-full w-full rounded-sm bg-primary"
                                                                style={{ opacity: 0.15 + 0.85 * (visitors / max) }}
                                                            />
                                                        ) : null}
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className="text-xs text-muted-foreground">{t("peak.zone", { zone: report.timeZone })}</p>
                    </>
                )}
            </CardBody>
        </Card>
    );
}
