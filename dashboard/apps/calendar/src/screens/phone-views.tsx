"use client";

/**
 * The two views a phone draws itself rather than through the grid: the
 * schedule, and the month with the tapped day's events under it.
 *
 * The schedule is Google Calendar's phone Schedule: a column of days, the date
 * on the left (today in a filled circle), each event a coloured row in its
 * calendar's colour, and a heading where a new month starts. The month is the
 * one Apple, Proton and Fantastical draw on a phone: a dot per event instead of
 * chips a phone has no room for, and the day picked opened in a list below -
 * pressing the picked day again opens it in the day view.
 *
 * Every row is at least 44 px tall. Tapping an event opens the same card the
 * grid opens; nothing here edits on its own.
 */

import * as time from "./time";
import { useCalendarT } from "./i18n";
import { Skeleton, cn } from "@polaris/ui";
import type { GridItem } from "./grid-events";
import { useMemo, type MouseEvent } from "react";
import type { EventInput } from "@fullcalendar/core";
import { agendaDays, dayDots, type AgendaDay, type AgendaEntry } from "./agenda";

/** Dots a month day shows before the rest are left to its list. */
const MONTH_DOTS = 3;

interface Shared {
    readonly events: EventInput[];
    readonly today: string;
    readonly locale: string;
    readonly hour12: boolean;
    /** No events read yet: their place is drawn as a skeleton. */
    readonly loading: boolean;
    readonly onItemClick: (item: GridItem, id: string, anchor: DOMRect) => void;
}

function useClock(locale: string, hour12: boolean) {
    return useMemo(() => {
        const format = new Intl.DateTimeFormat(locale, {
            hour: "numeric",
            minute: "2-digit",
            hour12,
            timeZone: "UTC"
        });
        // Wall times are read as UTC so no zone can shift them again.
        return (wall: string) => format.format(new Date(`${wall.slice(0, 19)}Z`));
    }, [locale, hour12]);
}

function EntryRow({
    entry,
    clock,
    onItemClick
}: {
    entry: AgendaEntry;
    clock: (wall: string) => string;
    onItemClick: Shared["onItemClick"];
}) {
    const t = useCalendarT();
    const { event } = entry;
    const item = (event.extendedProps as { item?: GridItem } | undefined)?.item;
    const label = (event.extendedProps as { label?: string } | undefined)?.label;
    const when =
        entry.allDay || entry.part === "middle"
            ? t("grid.allDay")
            : entry.part === "first" && entry.start
              ? t("phone.from", { time: clock(entry.start) })
              : entry.part === "last" && entry.end
                ? t("phone.until", { time: clock(entry.end) })
                : entry.start && entry.end
                  ? `${clock(entry.start)} - ${clock(entry.end)}`
                  : entry.start
                    ? clock(entry.start)
                    : "";
    const classes = (event.classNames as string[] | undefined) ?? [];
    return (
        <li>
            <button
                type="button"
                data-event-id={event.id}
                aria-label={label ?? undefined}
                className={cn(
                    "flex min-h-11 w-full min-w-0 flex-col justify-center rounded-md px-3 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    (classes.includes("pc-past") || classes.includes("pc-done")) && "opacity-60"
                )}
                style={{
                    backgroundColor: String(event.backgroundColor ?? ""),
                    color: String(event.textColor ?? ""),
                    boxShadow: `inset 3px 0 0 ${String(event.borderColor ?? "transparent")}`
                }}
                onClick={(click: MouseEvent<HTMLButtonElement>) => {
                    if (item && event.id)
                        onItemClick(item, event.id, click.currentTarget.getBoundingClientRect());
                }}
            >
                <span
                    className={cn(
                        "min-w-0 truncate text-sm font-medium",
                        (classes.includes("pc-cancelled") || classes.includes("pc-done")) &&
                            "line-through"
                    )}
                >
                    {String(event.title ?? "")}
                </span>
                {when ? (
                    <span className="min-w-0 truncate text-xs tabular-nums opacity-80">{when}</span>
                ) : null}
            </button>
        </li>
    );
}

function DayEntries({
    day,
    clock,
    onItemClick
}: {
    day: AgendaDay;
    clock: (wall: string) => string;
    onItemClick: Shared["onItemClick"];
}) {
    const t = useCalendarT();
    if (day.entries.length === 0)
        return (
            <p className="flex min-h-11 items-center px-3 text-sm text-muted-foreground">
                {t("grid.noEvents")}
            </p>
        );
    return (
        <ul className="flex min-w-0 flex-col gap-1.5">
            {day.entries.map((entry) => (
                <EntryRow
                    key={`${String(entry.event.id)}-${entry.part ?? ""}`}
                    entry={entry}
                    clock={clock}
                    onItemClick={onItemClick}
                />
            ))}
        </ul>
    );
}

function ListSkeleton({ rows }: { rows: number }) {
    return (
        <div className="flex flex-col gap-3 p-3" aria-hidden>
            {Array.from({ length: rows }, (_, index) => (
                <div key={index} className="flex gap-3">
                    <Skeleton className="size-10 shrink-0 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <Skeleton className="h-11 w-full" />
                        {index % 2 === 0 ? <Skeleton className="h-11 w-4/5" /> : null}
                    </div>
                </div>
            ))}
        </div>
    );
}

/** The schedule: the window's days with something on them, and today. */
export function PhoneSchedule({ window, ...shared }: Shared & { window: time.DayWindow }) {
    const t = useCalendarT();
    const clock = useClock(shared.locale, shared.hour12);
    const days = useMemo(
        () => agendaDays(shared.events, window, shared.today),
        [shared.events, window, shared.today]
    );
    if (shared.loading)
        return (
            <div role="status" aria-label={t("grid.loading")} className="h-full overflow-hidden">
                <ListSkeleton rows={6} />
            </div>
        );
    return (
        <div className="h-full overflow-y-auto overscroll-contain pb-24" data-phone-view="list">
            {days.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {t("phone.emptyRange")}
                </p>
            ) : (
                <ol className="flex flex-col">
                    {days.map((day, index) => {
                        const month = day.day.slice(0, 7);
                        const newMonth = index === 0 || days[index - 1]?.day.slice(0, 7) !== month;
                        const isToday = day.day === shared.today;
                        return (
                            <li key={day.day} className="flex flex-col">
                                {newMonth ? (
                                    <h2 className="sticky top-0 z-10 border-b border-border bg-card px-4 py-2 text-sm font-semibold first-letter:uppercase">
                                        {time.formatDay(day.day, shared.locale, {
                                            month: "long",
                                            year: "numeric"
                                        })}
                                    </h2>
                                ) : null}
                                <div
                                    className="flex gap-3 px-3 py-2"
                                    aria-current={isToday ? "date" : undefined}
                                >
                                    <div
                                        className="flex w-11 shrink-0 flex-col items-center pt-0.5"
                                        aria-label={time.formatDay(day.day, shared.locale, {
                                            dateStyle: "full"
                                        })}
                                    >
                                        <span
                                            className={cn(
                                                "text-[11px] font-medium uppercase",
                                                isToday ? "text-primary" : "text-muted-foreground"
                                            )}
                                            aria-hidden
                                        >
                                            {time.formatDay(day.day, shared.locale, {
                                                weekday: "short"
                                            })}
                                        </span>
                                        <span
                                            className={cn(
                                                "flex size-8 items-center justify-center rounded-full text-base font-semibold tabular-nums",
                                                isToday && "bg-primary text-primary-foreground"
                                            )}
                                            aria-hidden
                                        >
                                            {Number(day.day.slice(8, 10))}
                                        </span>
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <DayEntries
                                            day={day}
                                            clock={clock}
                                            onItemClick={shared.onItemClick}
                                        />
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ol>
            )}
        </div>
    );
}

/** The month as dots, and the day picked listed below it. */
export function PhoneMonth({
    anchor,
    firstDay,
    onPick,
    onOpenDay,
    ...shared
}: Shared & {
    anchor: string;
    firstDay: number;
    onPick: (day: string) => void;
    onOpenDay: (day: string) => void;
}) {
    const t = useCalendarT();
    const clock = useClock(shared.locale, shared.hour12);
    const monthStart = time.firstOfMonth(anchor);
    // Only the weeks the month reaches, as the grid draws it.
    const weeks = useMemo(
        () =>
            time
                .monthGrid(monthStart, firstDay)
                .filter((week) => week.some((day) => time.firstOfMonth(day) === monthStart)),
        [monthStart, firstDay]
    );
    const window = useMemo(
        () => ({
            start: weeks[0]?.[0] ?? monthStart,
            end: time.addDays(weeks.at(-1)?.[6] ?? monthStart, 1)
        }),
        [weeks, monthStart]
    );
    const byDay = useMemo(
        () => new Map(agendaDays(shared.events, window, shared.today).map((day) => [day.day, day])),
        [shared.events, window, shared.today]
    );
    const weekdays = useMemo(
        () => time.weekdayLabels(shared.locale, firstDay, "narrow"),
        [shared.locale, firstDay]
    );
    const picked = byDay.get(anchor) ?? { day: anchor, entries: [] };
    return (
        <div className="flex h-full min-h-0 flex-col" data-phone-view="month">
            <div className="shrink-0 border-b border-border px-1 pb-1">
                <div className="grid grid-cols-7" aria-hidden>
                    {weekdays.map((name, index) => (
                        <span
                            key={index}
                            className="py-1 text-center text-[11px] font-medium text-muted-foreground"
                        >
                            {name}
                        </span>
                    ))}
                </div>
                <div
                    role="grid"
                    aria-label={time.formatDay(anchor, shared.locale, {
                        month: "long",
                        year: "numeric"
                    })}
                >
                    {weeks.map((week) => (
                        <div role="row" key={week[0]} className="grid grid-cols-7">
                            {week.map((day) => {
                                const inMonth = time.firstOfMonth(day) === monthStart;
                                const dots = shared.loading
                                    ? []
                                    : dayDots(byDay.get(day), MONTH_DOTS);
                                const count = byDay.get(day)?.entries.length ?? 0;
                                const chosen = day === anchor;
                                const isToday = day === shared.today;
                                return (
                                    <button
                                        key={day}
                                        type="button"
                                        role="gridcell"
                                        aria-selected={chosen}
                                        aria-current={isToday ? "date" : undefined}
                                        aria-label={t("phone.dayCell", {
                                            day: time.formatDay(day, shared.locale, {
                                                dateStyle: "full"
                                            }),
                                            count
                                        })}
                                        data-day={day}
                                        className={cn(
                                            "flex min-h-12 flex-col items-center justify-start gap-1 rounded-md pt-1 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            !inMonth && "text-foreground-subtle",
                                            chosen && !isToday && "bg-primary/10"
                                        )}
                                        onClick={() => (chosen ? onOpenDay(day) : onPick(day))}
                                    >
                                        <span
                                            className={cn(
                                                "flex size-7 items-center justify-center rounded-full text-sm tabular-nums",
                                                isToday &&
                                                    "bg-primary font-semibold text-primary-foreground",
                                                chosen && !isToday && "font-semibold text-primary"
                                            )}
                                        >
                                            {Number(day.slice(8, 10))}
                                        </span>
                                        <span
                                            className="flex h-1.5 items-center gap-0.5"
                                            aria-hidden
                                        >
                                            {dots.map((color, index) => (
                                                <span
                                                    key={index}
                                                    className="size-1.5 rounded-full"
                                                    style={{ backgroundColor: color }}
                                                />
                                            ))}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-24">
                <h2 className="px-4 pb-1 pt-3 text-sm font-semibold first-letter:uppercase">
                    {time.formatDay(anchor, shared.locale, {
                        weekday: "long",
                        day: "numeric",
                        month: "long"
                    })}
                </h2>
                {shared.loading ? (
                    <ListSkeleton rows={2} />
                ) : (
                    <div className="px-3 pb-3">
                        <DayEntries day={picked} clock={clock} onItemClick={shared.onItemClick} />
                    </div>
                )}
            </div>
        </div>
    );
}
