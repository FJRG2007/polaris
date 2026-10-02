"use client";

/**
 * The meeting planner: the 24 hours of a chosen day in the reader's zone, and
 * what each of them is in every saved city - green while people there are at
 * work, amber while they are awake but off, grey at night and at the weekend
 * (timeanddate's colours, with the reader's own working hours for their own
 * city). Picking an hour lines it up across the cities and offers to make an
 * event at that time.
 *
 * Every hour is read through each city's zone, so a day with a clock change in
 * it - here or there - shows it as it happens: a 23- or 25-hour day, and an
 * hour that is not there.
 */

import * as words from "./words";
import { useCalendarT } from "../i18n";
import * as engine from "../../engine";
import { useRouter } from "next/navigation";
import { Button, cn, Input } from "@polaris/ui";
import * as cities from "../../lib/clock/cities";
import { hostUi } from "@polaris/app-host/client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CalendarPreferences } from "../../lib/preferences";
import { CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";

const KIND_CLASS: Readonly<Record<cities.HourKind, string>> = {
    work: "bg-success-soft text-success-ink",
    edge: "bg-warning-soft text-warning-ink",
    off: "bg-muted text-muted-foreground"
};

export function MeetingPlanner({
    zone,
    cities: saved,
    hour12,
    workingHours,
    ready
}: {
    zone: string;
    cities: readonly string[];
    hour12: boolean;
    workingHours: CalendarPreferences["workingHours"];
    ready: boolean;
}) {
    const t = useCalendarT();
    const router = useRouter();
    const locale = hostUi.i18nProvider.useLocale();
    const today = cities.wallClock(new Date(), zone).day;
    const [day, setDay] = useState(today);
    const hours = useMemo(() => cities.hoursOfDay(day, zone), [day, zone]);
    const [picked, setPicked] = useState<number | null>(null);
    const nowHour = hours.findIndex((at) => {
        const now = Date.now();
        return now >= at.getTime() && now < at.getTime() + 3_600_000;
    });
    const chosen = picked !== null && picked < hours.length ? picked : nowHour >= 0 ? nowHour : 9;
    const chosenAt = hours[chosen] ?? hours[0]!;
    const rows = [zone, ...saved.filter((entry) => entry !== zone)];
    const grid = useRef<HTMLDivElement>(null);

    // The chosen hour is in view: on a phone the day is wider than the screen,
    // and the hour that matters - now, or the one picked - is not the first.
    useEffect(() => {
        const box = grid.current;
        const cell = box?.querySelector<HTMLElement>(`[data-hour="${chosen}"]`);
        const head = box?.querySelector<HTMLElement>("th");
        if (!box || !cell) return;
        const frame = box.getBoundingClientRect();
        const spot = cell.getBoundingClientRect();
        // The sticky city column covers the left of the scrolling area.
        const from = frame.left + (head?.offsetWidth ?? 0);
        if (spot.left >= from && spot.right <= frame.right) return;
        box.scrollLeft += spot.left + spot.width / 2 - (from + frame.right) / 2;
    }, [chosen, day, ready]);

    const hourLabel = (at: Date, cityZone: string) =>
        new Intl.DateTimeFormat(locale, { hour: "numeric", hour12, timeZone: cityZone }).format(at);

    const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "ArrowRight") {
            event.preventDefault();
            setPicked(Math.min(hours.length - 1, chosen + 1));
        } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            setPicked(Math.max(0, chosen - 1));
        }
    };

    const kindOf = (at: Date, cityZone: string) => {
        const clock = cities.wallClock(at, cityZone);
        return cities.hourKind(clock.weekday, clock.minutes, cityZone === zone ? workingHours : undefined);
    };

    return (
        <section aria-labelledby="calendar-time-planner" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <h2 id="calendar-time-planner" className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">
                    {t("time.planner.title")}
                </h2>
                <div className="flex items-center gap-1">
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("time.planner.previousDay")}
                        title={t("time.planner.previousDay")}
                        onClick={() => setDay(engine.addDays(day, -1))}
                    >
                        <ChevronLeft />
                    </Button>
                    <Input
                        type="date"
                        value={day}
                        aria-label={t("time.planner.day")}
                        onChange={(event) => event.target.value && setDay(event.target.value)}
                        className="h-8 w-40"
                    />
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("time.planner.nextDay")}
                        title={t("time.planner.nextDay")}
                        onClick={() => setDay(engine.addDays(day, 1))}
                    >
                        <ChevronRight />
                    </Button>
                    {day !== today ? (
                        <Button size="sm" variant="ghost" onClick={() => setDay(today)}>
                            {t("time.world.today")}
                        </Button>
                    ) : null}
                </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("time.planner.lead")}</p>

            {!ready ? null : (
                <>
                    <div
                        ref={grid}
                        role="grid"
                        aria-label={t("time.planner.title")}
                        tabIndex={0}
                        onKeyDown={onKey}
                        className="overflow-x-auto overscroll-x-contain rounded-lg border border-border bg-card"
                    >
                        <table className="w-max min-w-full border-collapse text-xs tabular-nums">
                            <tbody>
                                {rows.map((cityZone) => (
                                    <tr key={cityZone} className="border-b border-border last:border-0">
                                        <th
                                            scope="row"
                                            className="sticky left-0 z-10 w-32 max-w-32 bg-card px-2 py-1.5 text-left normal-case tracking-normal"
                                        >
                                            <span className="block truncate text-[0.8125rem] font-medium text-foreground" title={cityZone}>
                                                {cities.cityOf(cityZone)}
                                            </span>
                                            <span className="block truncate font-normal text-foreground-subtle">
                                                {cityZone === zone
                                                    ? t("time.planner.you")
                                                    : words.offsetDifferenceText(cities.offsetBetween(cityZone, zone, chosenAt), t)}
                                            </span>
                                        </th>
                                        {hours.map((at, index) => {
                                            const clock = cities.wallClock(at, cityZone);
                                            const midnight = clock.minutes < 60;
                                            return (
                                                <td key={at.getTime()} className="p-0.5" data-hour={index}>
                                                    <button
                                                        type="button"
                                                        tabIndex={-1}
                                                        aria-pressed={index === chosen}
                                                        aria-label={`${cities.cityOf(cityZone)} ${hourLabel(at, cityZone)}`}
                                                        onClick={() => setPicked(index)}
                                                        className={cn(
                                                            "flex h-9 w-10 flex-col items-center justify-center rounded leading-none",
                                                            KIND_CLASS[kindOf(at, cityZone)],
                                                            index === chosen && "ring-2 ring-primary",
                                                            index === nowHour && "font-semibold"
                                                        )}
                                                    >
                                                        <span>{hourLabel(at, cityZone)}</span>
                                                        {midnight ? (
                                                            <span className="mt-0.5 text-[0.625rem] text-foreground-subtle">
                                                                {new Intl.DateTimeFormat(locale, {
                                                                    day: "numeric",
                                                                    month: "short",
                                                                    timeZone: cityZone
                                                                }).format(at)}
                                                            </span>
                                                        ) : null}
                                                    </button>
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" aria-hidden>
                        <span className="flex items-center gap-1.5">
                            <span className={cn("size-3 rounded-sm", KIND_CLASS.work)} />
                            {t("time.planner.work")}
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className={cn("size-3 rounded-sm", KIND_CLASS.edge)} />
                            {t("time.planner.edge")}
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className={cn("size-3 rounded-sm", KIND_CLASS.off)} />
                            {t("time.planner.off")}
                        </span>
                    </div>

                    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
                        <ul className="flex flex-col gap-1">
                            {rows.map((cityZone) => {
                                const day = cities.dayDifference(cityZone, zone, chosenAt);
                                return (
                                    <li key={cityZone} className="flex items-baseline gap-2 text-[0.8125rem]">
                                        <span className="min-w-0 flex-1 truncate" title={cityZone}>
                                            {cities.cityOf(cityZone)}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {day === 0 ? null : `${words.dayWord(day, t)} · `}
                                            {new Intl.DateTimeFormat(locale, {
                                                weekday: "short",
                                                day: "numeric",
                                                month: "short",
                                                timeZone: cityZone
                                            }).format(chosenAt)}
                                        </span>
                                        <span className="w-20 text-right font-medium tabular-nums">
                                            {words.instantTimeText(chosenAt, locale, cityZone, hour12)}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                        <Button size="sm" className="self-start" onClick={() => router.push(cities.newEventPath(chosenAt))}>
                            <CalendarPlus />
                            {t("time.planner.createEvent")}
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
}
