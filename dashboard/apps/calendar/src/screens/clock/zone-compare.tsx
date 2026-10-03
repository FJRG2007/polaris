"use client";

/**
 * An event's time in the world clock's cities, under its times in the editor:
 * what it is there, which day, and whether people there are at work, awake or
 * asleep - Outlook's and Google's extra time zones, for every city at once.
 *
 * Drawn only when there is a city to compare with: one saved in the world
 * clock, or the zone the event itself is set in when it is not the reader's.
 */

import * as words from "./words";
import { cn } from "@polaris/ui";
import { useCalendarT } from "../i18n";
import * as cities from "../../lib/clock/cities";
import { hostUi } from "@polaris/app-host/client";
import type { CalendarPreferences } from "../../lib/preferences";

const DOT: Readonly<Record<cities.HourKind, string>> = {
    work: "bg-success",
    edge: "bg-warning",
    off: "bg-foreground-subtle"
};

export function ZoneComparison({
    start,
    end,
    zone,
    eventZone,
    preferences
}: {
    start: Date;
    end: Date;
    /** The reader's zone, which the event's own times are already shown in. */
    zone: string;
    /** The zone the event is set in, when it has one of its own. */
    eventZone: string | null;
    preferences: CalendarPreferences;
}) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const format = hostUi.displayFormat.useDisplayFormat();
    const hour12 = format.preferences.clock === "12h";
    const shown = [
        ...new Set([
            ...(eventZone && eventZone !== zone ? [eventZone] : []),
            ...preferences.worldClock
        ])
    ].filter((entry) => entry !== zone);
    if (shown.length === 0) return null;

    return (
        <div className="flex w-full flex-col gap-1 rounded-md border border-border bg-surface px-3 py-2">
            <p className="truncate text-xs font-medium text-muted-foreground">
                {t("time.compare.title")}
            </p>
            <ul className="flex flex-col gap-0.5">
                {shown.map((cityZone) => {
                    const clock = cities.wallClock(start, cityZone);
                    const kind = cities.hourKind(clock.weekday, clock.minutes);
                    const day = cities.dayDifference(cityZone, zone, start);
                    let range = "";
                    try {
                        range = new Intl.DateTimeFormat(locale, {
                            hour: "numeric",
                            minute: "2-digit",
                            hour12,
                            timeZone: cityZone
                        }).formatRange(start, end);
                    } catch {
                        range = words.instantTimeText(start, locale, cityZone, hour12);
                    }
                    return (
                        <li key={cityZone} className="flex items-center gap-2 text-xs">
                            <span
                                aria-hidden
                                className={cn("size-2 shrink-0 rounded-full", DOT[kind])}
                            />
                            <span className="min-w-0 flex-1 truncate" title={cityZone}>
                                {cities.cityOf(cityZone)}
                            </span>
                            {day !== 0 ? (
                                <span className="text-foreground-subtle">
                                    {words.dayWord(day, t)}
                                </span>
                            ) : null}
                            <span className="tabular-nums">{range}</span>
                            <span className="sr-only">{t(`time.planner.${kind}`)}</span>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
