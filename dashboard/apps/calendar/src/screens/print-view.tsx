"use client";

/**
 * Printing a stretch of the calendar: the days to print, portrait or
 * landscape, as a list of days or as month grids. What is on paper is exactly
 * what is shown under the controls; the controls and the dashboard around it
 * are left off the page.
 */

import * as time from "./time";
import { ColorDot } from "./ui";
import { useCalendarT } from "./i18n";
import { Printer } from "lucide-react";
import { useMemo, useState } from "react";
import { hostUi } from "@polaris/app-host/client";
import * as calendarActions from "../actions/calendars";
import * as preferenceActions from "../actions/preferences";
import { cacheKey, unwrap, useCachedRead } from "./cached-read";
import { Button, cn, Input, SegmentedControl, Skeleton } from "@polaris/ui";
import type { CalendarSummary, OccurrenceView, RangeView } from "../lib/wire";
import { DEFAULT_PREFERENCES, type CalendarPreferences, type CalendarViewName } from "../lib/preferences";

/** More than this is not a printout anybody reads. */
const MOST_DAYS = 93;

type Layout = "list" | "month";
type Orientation = "portrait" | "landscape";

function printCss(orientation: Orientation): string {
    return `
@page { size: A4 ${orientation}; margin: 12mm; }
@media print {
    body * { visibility: hidden !important; }
    .pc-print, .pc-print * { visibility: visible !important; }
    .pc-print { position: absolute; left: 0; top: 0; width: 100%; color: #000; background: #fff; }
    .pc-print .pc-print-day { break-inside: avoid; }
    .pc-print .pc-print-month { break-after: page; }
    .pc-print .pc-print-month:last-child { break-after: auto; }
    .pc-no-print { display: none !important; }
}`;
}

/** The days a printout covers, from what the calendar was showing. */
export function initialSpan(view: CalendarViewName | null, date: string | null, today: string, firstDay: number, customDays: number): time.DayWindow {
    const anchor = date && time.isDayString(date) ? date : today;
    if (!view || view === "year") return { start: time.firstOfMonth(anchor), end: time.addMonths(time.firstOfMonth(anchor), 1) };
    if (view === "month") return { start: time.firstOfMonth(anchor), end: time.addMonths(time.firstOfMonth(anchor), 1) };
    return time.viewWindow(view, anchor, firstDay, customDays);
}

export function PrintView({ view, date }: { view: string | null; date: string | null }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const format = hostUi.displayFormat.useDisplayFormat();
    const preferencesRead = useCachedRead<CalendarPreferences>(cacheKey("preferences"), async () => (await unwrap(() => preferenceActions.loadPreferencesAction(), t("screen.failed"))).preferences);
    const calendarsRead = useCachedRead<CalendarSummary[]>(cacheKey("calendars"), async () => (await unwrap(() => calendarActions.listCalendarsAction(), t("screen.failed"))).calendars);
    const preferences = preferencesRead.data ?? DEFAULT_PREFERENCES;
    const zone = time.displayZone(preferences.timezone, format.preferences.timeZone);
    const firstDay = preferences.firstDay ?? format.weekStartsOn;
    const today = time.todayIn(zone, new Date());
    const known = view && (["day", "week", "month", "year", "list", "days"] as string[]).includes(view) ? (view as CalendarViewName) : null;
    const [span, setSpan] = useState<time.DayWindow>(() => initialSpan(known, date, today, firstDay, preferences.customDays));
    const [layout, setLayout] = useState<Layout>(known === "month" || known === "year" ? "month" : "list");
    const [orientation, setOrientation] = useState<Orientation>(known === "month" || known === "year" ? "landscape" : "portrait");

    const lastDay = time.addDays(span.end, -1);
    const days = time.isDayString(span.start) && time.isDayString(lastDay) ? time.daysBetween(span.start, span.end) : 0;
    const problem = days <= 0 ? t("printPage.badRange") : days > MOST_DAYS ? t("printPage.tooLong", { count: MOST_DAYS }) : null;
    const instants = useMemo(() => (problem ? null : time.windowInstants(span, zone)), [problem, span, zone]);
    const key = instants ? cacheKey("print-range", zone, instants.from.toISOString(), instants.to.toISOString()) : null;
    const rangeRead = useCachedRead<RangeView>(key, async (signal) => {
        if (!instants) throw new Error(t("printPage.badRange"));
        const query = new URLSearchParams({ from: instants.from.toISOString(), to: instants.to.toISOString(), zone, tasks: "0" });
        const response = await fetch(`/api/calendar/range?${query}`, { cache: "no-store", signal });
        if (!response.ok) throw new Error(t("grid.loadFailed"));
        return (await response.json()) as RangeView;
    });

    const calendars = useMemo(() => new Map((calendarsRead.data ?? []).map((calendar) => [calendar.id, calendar])), [calendarsRead.data]);
    const occurrences = useMemo(
        () =>
            (rangeRead.data?.occurrences ?? [])
                .filter((occurrence) => !calendars.get(occurrence.calendarId)?.hidden)
                .filter((occurrence) => preferences.showDeclined || occurrence.myPartstat !== "DECLINED")
                .sort((a, b) => Number(!a.allDay) - Number(!b.allDay) || a.start.localeCompare(b.start)),
        [rangeRead.data, calendars, preferences.showDeclined]
    );
    const byDay = useMemo(() => {
        const map = new Map<string, OccurrenceView[]>();
        for (const occurrence of occurrences) {
            const first = occurrence.allDay && occurrence.startDate ? occurrence.startDate : time.wallOf(occurrence.start, zone).slice(0, 10);
            const last = occurrence.allDay && occurrence.endDate ? time.addDays(occurrence.endDate, -1) : time.wallOf(new Date(new Date(occurrence.end).getTime() - 1), zone).slice(0, 10);
            for (let day = first < span.start ? span.start : first; day <= last && day < span.end; day = time.addDays(day, 1)) map.set(day, [...(map.get(day) ?? []), occurrence]);
        }
        return map;
    }, [occurrences, zone, span]);

    const timeOf = (occurrence: OccurrenceView) => (occurrence.allDay ? t("grid.allDay") : time.formatInstant(occurrence.start, locale, zone, { timeStyle: "short" }));
    const titleOf = (occurrence: OccurrenceView) => (occurrence.busyOnly ? t("screen.busy") : occurrence.summary || t("screen.untitled"));

    const allDays: string[] = [];
    for (let day = span.start; days > 0 && days <= MOST_DAYS && day < span.end; day = time.addDays(day, 1)) allDays.push(day);
    const months = [...new Set(allDays.map((day) => time.firstOfMonth(day)))];

    return (
        <div className="flex flex-col gap-4">
            <style>{printCss(orientation)}</style>
            <div className="pc-no-print flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t("printPage.from")}
                    <Input type="date" className="w-40 tabular-nums" value={span.start} onChange={(event) => setSpan({ ...span, start: event.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t("printPage.to")}
                    <Input type="date" className="w-40 tabular-nums" value={lastDay} onChange={(event) => time.isDayString(event.target.value) && setSpan({ ...span, end: time.addDays(event.target.value, 1) })} />
                </label>
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t("printPage.layout")}
                    <SegmentedControl size="sm" aria-label={t("printPage.layout")} value={layout} onValueChange={setLayout} options={[{ value: "list", label: t("printPage.list") }, { value: "month", label: t("printPage.month") }]} />
                </div>
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t("printPage.orientation")}
                    <SegmentedControl size="sm" aria-label={t("printPage.orientation")} value={orientation} onValueChange={setOrientation} options={[{ value: "portrait", label: t("printPage.portrait") }, { value: "landscape", label: t("printPage.landscape") }]} />
                </div>
                <Button aria-disabled={problem !== null || !rangeRead.data} title={problem ?? undefined} className={cn(problem !== null && "opacity-50")} onClick={() => problem === null && rangeRead.data && window.print()}>
                    <Printer />
                    {t("printPage.print")}
                </Button>
            </div>
            {problem ? (
                <p role="alert" className="pc-no-print text-xs text-danger">
                    {problem}
                </p>
            ) : null}

            <div className="pc-print rounded-lg border border-border bg-card p-4 print:border-0 print:p-0">
                <h2 className="mb-3 text-[0.9375rem] font-semibold tabular-nums">
                    {days > 0 ? new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).formatRange(time.dayDate(span.start), time.dayDate(lastDay)) : ""}
                </h2>
                {rangeRead.error && !rangeRead.data ? (
                    <div role="alert" className="pc-no-print flex items-center gap-2 text-xs">
                        <span>{t("grid.loadFailed")}</span>
                        <Button size="xs" variant="outline" onClick={rangeRead.refresh}>
                            {t("screen.retry")}
                        </Button>
                    </div>
                ) : !rangeRead.data && !problem ? (
                    <div className="flex flex-col gap-2" aria-hidden>
                        {[0, 1, 2, 3].map((index) => (
                            <Skeleton key={index} className="h-8 w-full" />
                        ))}
                    </div>
                ) : layout === "list" ? (
                    <div className="flex flex-col gap-3">
                        {allDays.filter((day) => byDay.has(day)).length === 0 ? <p className="text-xs text-muted-foreground">{t("printPage.nothing")}</p> : null}
                        {allDays
                            .filter((day) => byDay.has(day))
                            .map((day) => (
                                <section key={day} className="pc-print-day">
                                    <h3 className="border-b border-border pb-1 text-xs font-semibold first-letter:uppercase">{time.formatDay(day, locale, { dateStyle: "full" })}</h3>
                                    <ul className="flex flex-col">
                                        {(byDay.get(day) ?? []).map((occurrence) => (
                                            <li key={`${occurrence.objectId}-${occurrence.recurrenceKey}`} className="flex items-baseline gap-3 py-0.5 text-xs">
                                                <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{timeOf(occurrence)}</span>
                                                <ColorDot color={occurrence.color ?? calendars.get(occurrence.calendarId)?.color ?? "#7f7f7f"} className="size-2" />
                                                <span className={cn("min-w-0 flex-1 break-words", occurrence.status === "CANCELLED" && "line-through")}>
                                                    {titleOf(occurrence)}
                                                    {occurrence.location ? <span className="text-muted-foreground"> - {occurrence.location}</span> : null}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                </section>
                            ))}
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        {months.map((month) => (
                            <section key={month} className="pc-print-month">
                                <h3 className="mb-1 text-xs font-semibold first-letter:uppercase">{time.formatDay(month, locale, { month: "long", year: "numeric" })}</h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full min-w-[40rem] table-fixed border-collapse text-[11px]">
                                        <thead>
                                            <tr>
                                                {time.weekdayLabels(locale, firstDay, "short").map((name) => (
                                                    <th key={name} className="border border-border px-1 py-0.5 text-left">
                                                        {name}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {time.monthGrid(month, firstDay).map((week) => (
                                                <tr key={week[0]}>
                                                    {week.map((day) => (
                                                        <td key={day} className={cn("h-20 border border-border p-1 align-top", day.slice(0, 7) !== month.slice(0, 7) && "text-muted-foreground opacity-50")}>
                                                            <div className="tabular-nums">{Number(day.slice(8))}</div>
                                                            {day >= span.start && day < span.end
                                                                ? (byDay.get(day) ?? []).slice(0, 5).map((occurrence) => (
                                                                      <div key={`${occurrence.objectId}-${occurrence.recurrenceKey}`} className={cn("truncate", occurrence.status === "CANCELLED" && "line-through")}>
                                                                          {occurrence.allDay ? "" : `${timeOf(occurrence)} `}
                                                                          {titleOf(occurrence)}
                                                                      </div>
                                                                  ))
                                                                : null}
                                                            {(byDay.get(day)?.length ?? 0) > 5 && day >= span.start && day < span.end ? <div className="text-muted-foreground">{t("grid.more", { count: (byDay.get(day)?.length ?? 0) - 5 })}</div> : null}
                                                        </td>
                                                    ))}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </section>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
