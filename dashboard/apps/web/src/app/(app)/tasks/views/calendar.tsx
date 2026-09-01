"use client";

/**
 * The calendar: what is happening, on the day it happens.
 *
 * Three scopes rather than one. A month answers "how loaded is the next few
 * weeks", a week is what people plan against, and a day is the only one that
 * fits a phone and the only one where a 20-minute meeting is legible. The scope
 * is remembered per browser, because it is a way of working rather than a
 * setting of the list.
 *
 * The week begins on whichever day the account chose under Preferences, and the
 * grid is sized to the viewport instead of to a fixed row height: a calendar
 * that leaves half the screen empty is a calendar people scroll past.
 *
 * A task with no dates is not drawn - it is counted underneath - because a
 * calendar that invents a day for undated work lies about the plan. Google
 * Calendar events sit beside the tasks when the account has linked one, marked
 * as theirs and never editable from here.
 */

import * as core from "@polaris/core";
import { StatusIcon } from "../pickers";
import { cn, Button } from "@polaris/ui";
import type { ViewProps } from "./shared";
import * as layout from "./calendar-layout";
import { GoogleMark } from "@/components/brand-icons";
import { commandsFor, TaskMenu } from "./task-actions";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useGoogleCalendarEvents, type GoogleCalendarState } from "@/lib/google-calendar/events-client";

type CalendarScope = layout.CalendarScope;
type CalendarEntry = layout.CalendarEntry;

/** Where the chosen scope is kept, so the calendar opens the way it was left. */
const SCOPE_KEY = "polaris.tasks.calendar.scope";

/** One hour of the day grid, in pixels. Tall enough that a half-hour block still
 *  has room for a name. */
const HOUR_HEIGHT = 48;

/** What a day and a week grid open scrolled to, so the working day is on screen
 *  without anybody dragging the scrollbar first. */
const FIRST_VISIBLE_HOUR = 7;

export function CalendarView(props: ViewProps) {
    const { rows, canEdit, onOpen, onQuickCreate } = props;
    const format = useDisplayFormat();
    const weekStartsOn = format.weekStartsOn;

    const [scope, setScope] = useState<CalendarScope>("month");
    const [offset, setOffset] = useState(0);
    const [selectedDay, setSelectedDay] = useState<string | null>(null);
    const [showGoogle, setShowGoogle] = useState(true);

    // The stored scope is read after mount rather than during render: the server
    // has no localStorage, and a first paint that disagreed with it would flash.
    // A phone opens on Day when nothing was stored - a month of 7 columns there
    // is a grid of dots nobody can read.
    useEffect(() => {
        const stored = window.localStorage.getItem(SCOPE_KEY);
        if (stored === "day" || stored === "week" || stored === "month") setScope(stored);
        else if (window.matchMedia("(max-width: 639px)").matches) setScope("day");
    }, []);

    function chooseScope(next: CalendarScope) {
        setScope(next);
        setOffset(0);
        setSelectedDay(null);
        window.localStorage.setItem(SCOPE_KEY, next);
    }

    const today = useMemo(() => core.startOfDay(new Date()), []);
    const { days, label, monthShown } = useMemo(
        () => layout.buildRange(scope, offset, weekStartsOn, format),
        [scope, offset, weekStartsOn, format]
    );

    const from = days[0] as Date;
    const to = core.endOfDay(days[days.length - 1] as Date);

    const google = useGoogleCalendarEvents(from, to);
    const undated = useMemo(() => rows.filter((task) => !task.dueDate && !task.startDate), [rows]);

    const entries = useMemo(() => {
        const fromTasks = rows
            .map(layout.taskEntry)
            .filter((entry): entry is CalendarEntry => entry !== null);
        if (!showGoogle) return fromTasks;
        return [...fromTasks, ...google.events.map(layout.googleEntry)];
    }, [rows, google.events, showGoogle]);

    const onDay = (day: Date) => layout.entriesOnDay(entries, day);

    /** Make a task on a day, at an hour when the grid has one. The `date:` prefix
     *  tells the screen this key is a date rather than a group id. */
    const createOn = (day: Date, hour?: number) => {
        if (!canEdit) return;
        const at = new Date(day);
        if (hour !== undefined) at.setHours(hour, 0, 0, 0);
        onQuickCreate(`date:${at.toISOString()}`, "New task");
    };

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <header className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        aria-label={`Previous ${scope}`}
                        title={`Previous ${scope}`}
                        onClick={() => setOffset(offset - 1)}
                        className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <ChevronLeft className="size-4" />
                    </button>
                    <button
                        type="button"
                        aria-label={`Next ${scope}`}
                        title={`Next ${scope}`}
                        onClick={() => setOffset(offset + 1)}
                        className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <ChevronRight className="size-4" />
                    </button>
                </div>
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium sm:text-base">{label}</h3>

                {offset !== 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setOffset(0)}>
                        Today
                    </Button>
                )}

                <div className="flex rounded-md border border-border p-0.5">
                    {layout.CALENDAR_SCOPES.map((entry) => (
                        <button
                            key={entry}
                            type="button"
                            onClick={() => chooseScope(entry)}
                            aria-pressed={scope === entry}
                            className={cn(
                                "rounded px-2.5 py-1 text-xs transition-colors",
                                scope === entry
                                    ? "bg-muted font-medium text-foreground"
                                    : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {layout.SCOPE_LABELS[entry]}
                        </button>
                    ))}
                </div>

                <GoogleControl state={google} showing={showGoogle} onToggle={() => setShowGoogle(!showGoogle)} />
            </header>

            {scope === "month" ? (
                <MonthGrid
                    days={days}
                    monthShown={monthShown}
                    today={today}
                    weekStartsOn={weekStartsOn}
                    selectedDay={selectedDay}
                    onSelectDay={(day) => setSelectedDay(day.toDateString())}
                    onCreate={createOn}
                    onDay={onDay}
                    props={props}
                />
            ) : (
                <TimeGrid
                    days={days}
                    today={today}
                    scope={scope}
                    onCreate={createOn}
                    onDay={onDay}
                    props={props}
                />
            )}

            {/* A phone has no room for the chips inside a month cell, so the day
                that was tapped is listed underneath instead of being unreadable. */}
            {scope === "month" && selectedDay ? (
                <div className="sm:hidden">
                    <DayList
                        day={new Date(selectedDay)}
                        entries={onDay(new Date(selectedDay))}
                        onOpen={onOpen}
                        format={format}
                    />
                </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {undated.length > 0 && (
                    <span>
                        {undated.length} {undated.length === 1 ? "task has" : "tasks have"} no dates and are not shown
                        here.
                    </span>
                )}
                {canEdit && <span>Double-click {scope === "month" ? "a day" : "an hour"} to add a task there.</span>}
                {google.error ? <span className="text-danger">{google.error}</span> : null}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Month
// ---------------------------------------------------------------------------

function MonthGrid({
    days,
    monthShown,
    today,
    weekStartsOn,
    selectedDay,
    onSelectDay,
    onCreate,
    onDay,
    props
}: {
    days: Date[];
    monthShown: number;
    today: Date;
    weekStartsOn: number;
    selectedDay: string | null;
    onSelectDay: (day: Date) => void;
    onCreate: (day: Date) => void;
    onDay: (day: Date) => CalendarEntry[];
    props: ViewProps;
}) {
    const headings = Array.from({ length: 7 }, (_, index) => (weekStartsOn + index) % 7);

    return (
        // Sized to what is left of the viewport rather than to its contents: the
        // rows share the height, so a month is a month-sized thing on a laptop
        // and on a 32-inch screen. The floor keeps it usable when the window is
        // short instead of squeezing six rows into nothing.
        <div className="flex h-[calc(100dvh-19rem)] min-h-[26rem] flex-col overflow-hidden rounded-lg border border-border">
            <div className="grid grid-cols-7 border-b border-border bg-muted/40">
                {headings.map((index) => (
                    <div key={index} className="px-2 py-1.5 text-center text-[0.6875rem] text-muted-foreground">
                        <span className="hidden sm:inline">{core.WEEKDAY_SHORT_NAMES[index]}</span>
                        <span className="sm:hidden">{(core.WEEKDAY_SHORT_NAMES[index] as string).slice(0, 1)}</span>
                    </div>
                ))}
            </div>
            <div
                className="grid min-h-0 flex-1 grid-cols-7 gap-px overflow-y-auto bg-border"
                style={{ gridAutoRows: "minmax(4.5rem, 1fr)" }}
            >
                {days.map((day) => {
                    const entries = onDay(day);
                    const outside = day.getMonth() !== monthShown;
                    const isToday = core.isSameDay(day, today);
                    const selected = selectedDay === day.toDateString();
                    return (
                        <div
                            key={day.toISOString()}
                            onClick={() => onSelectDay(day)}
                            onDoubleClick={() => onCreate(day)}
                            className={cn(
                                "flex min-w-0 flex-col gap-0.5 bg-card p-1 sm:p-1.5",
                                outside && "bg-muted/20",
                                selected && "ring-1 ring-inset ring-primary/50"
                            )}
                        >
                            <div className="flex items-center justify-between gap-1">
                                {/* The number is the day's own control, so the
                                    cell can be reached from the keyboard rather
                                    than only by pointing at it. */}
                                <button
                                    type="button"
                                    onClick={() => onSelectDay(day)}
                                    aria-label={`${core.WEEKDAY_NAMES[day.getDay()]} ${day.getDate()}`}
                                    aria-pressed={selected}
                                    className={cn(
                                        "rounded text-[0.6875rem]",
                                        isToday
                                            ? "bg-primary px-1.5 font-medium text-primary-foreground"
                                            : outside
                                              ? "px-1 text-muted-foreground/60 hover:bg-muted"
                                              : "px-1 text-muted-foreground hover:bg-muted"
                                    )}
                                >
                                    {day.getDate()}
                                </button>
                                {entries.length > 0 && (
                                    <span className="text-[0.625rem] text-muted-foreground sm:hidden">
                                        {entries.length}
                                    </span>
                                )}
                            </div>

                            {/* Below the phone breakpoint the cell is too narrow
                                for names, so the day carries dots and the strip
                                under the grid says what they are. */}
                            <div className="flex flex-wrap gap-0.5 sm:hidden">
                                {entries.slice(0, 4).map((entry) => (
                                    <span
                                        key={entry.key}
                                        className="size-1.5 rounded-full"
                                        style={{ backgroundColor: entry.color }}
                                    />
                                ))}
                            </div>

                            <ul className="hidden min-h-0 flex-1 flex-col gap-0.5 overflow-hidden sm:flex">
                                {entries.slice(0, 4).map((entry) => (
                                    <EntryChip key={entry.key} entry={entry} props={props} />
                                ))}
                                {entries.length > 4 && (
                                    <li className="px-1 text-[0.625rem] text-muted-foreground">
                                        +{entries.length - 4} more
                                    </li>
                                )}
                            </ul>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Day and week
// ---------------------------------------------------------------------------

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function TimeGrid({
    days,
    today,
    scope,
    onCreate,
    onDay,
    props
}: {
    days: Date[];
    today: Date;
    scope: CalendarScope;
    onCreate: (day: Date, hour: number) => void;
    onDay: (day: Date) => CalendarEntry[];
    props: ViewProps;
}) {
    const format = useDisplayFormat();
    const scroller = useRef<HTMLDivElement>(null);

    // Opens on the working day rather than on midnight, which is where the
    // scrollbar would otherwise leave eight empty hours.
    useEffect(() => {
        if (scroller.current) scroller.current.scrollTop = FIRST_VISIBLE_HOUR * HOUR_HEIGHT;
    }, []);

    const columns = days.map((day) => {
        const entries = onDay(day);
        return {
            day,
            allDay: entries.filter((entry) => entry.allDay),
            timed: layout.laneOut(entries.filter((entry) => !entry.allDay))
        };
    });

    return (
        <div className="flex h-[calc(100dvh-19rem)] min-h-[26rem] flex-col overflow-hidden rounded-lg border border-border">
            <div className={cn("min-w-0", scope === "week" && "overflow-x-auto")}>
                <div className={cn("flex flex-col", scope === "week" && "min-w-[42rem]")}>
                    {/* Column headings and the all-day strip scroll horizontally
                        with the grid below, so a day never drifts off its own
                        column on a narrow screen. */}
                    <div className="flex border-b border-border bg-muted/40">
                        <div className="w-12 shrink-0 sm:w-14" />
                        {columns.map((column) => (
                            <div key={column.day.toISOString()} className="min-w-0 flex-1 px-1 py-1.5 text-center">
                                <div className="text-[0.6875rem] text-muted-foreground">
                                    {core.WEEKDAY_SHORT_NAMES[column.day.getDay()]}
                                </div>
                                <div
                                    className={cn(
                                        "text-sm",
                                        core.isSameDay(column.day, today) && "font-semibold text-primary"
                                    )}
                                >
                                    {column.day.getDate()}
                                </div>
                            </div>
                        ))}
                    </div>

                    {columns.some((column) => column.allDay.length > 0) && (
                        <div className="flex border-b border-border">
                            <div className="w-12 shrink-0 px-1 py-1 text-right text-[0.625rem] text-muted-foreground sm:w-14">
                                All day
                            </div>
                            {columns.map((column) => (
                                <ul
                                    key={column.day.toISOString()}
                                    className="flex min-w-0 flex-1 flex-col gap-0.5 border-l border-border p-1"
                                >
                                    {column.allDay.map((entry) => (
                                        <EntryChip key={entry.key} entry={entry} props={props} />
                                    ))}
                                </ul>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <div ref={scroller} className={cn("min-h-0 flex-1 overflow-y-auto", scope === "week" && "overflow-x-auto")}>
                <div className={cn("flex", scope === "week" && "min-w-[42rem]")}>
                    <div className="w-12 shrink-0 sm:w-14">
                        {HOURS.map((hour) => (
                            <div
                                key={hour}
                                style={{ height: HOUR_HEIGHT }}
                                className="relative pr-1 text-right text-[0.625rem] text-muted-foreground"
                            >
                                <span className="absolute -top-1.5 right-1">{hourLabel(hour, format)}</span>
                            </div>
                        ))}
                    </div>
                    {columns.map((column) => (
                        <div key={column.day.toISOString()} className="relative min-w-0 flex-1 border-l border-border">
                            {HOURS.map((hour) => (
                                <div
                                    key={hour}
                                    style={{ height: HOUR_HEIGHT }}
                                    onDoubleClick={() => onCreate(column.day, hour)}
                                    className="border-b border-border/60"
                                />
                            ))}
                            {core.isSameDay(column.day, today) && <NowLine />}
                            {column.timed.map(({ entry, lane, lanes }) => (
                                <TimedEntry
                                    key={entry.key}
                                    entry={entry}
                                    lane={lane}
                                    lanes={lanes}
                                    props={props}
                                />
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

/** An hour down the side of the grid, written the way the account writes times -
 *  "07:00" or "7 AM" - rather than as a bare number. */
function hourLabel(hour: number, format: core.DisplayFormat): string {
    const at = new Date();
    at.setHours(hour, 0, 0, 0);
    return format.time(at);
}

/** Where the clock is now, drawn across today's column. */
function NowLine() {
    const [minutes, setMinutes] = useState(() => layout.minutesInto(new Date()));
    useEffect(() => {
        const timer = window.setInterval(() => setMinutes(layout.minutesInto(new Date())), 60_000);
        return () => window.clearInterval(timer);
    }, []);
    return (
        <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 z-10 h-px bg-primary"
            style={{ top: (minutes / 60) * HOUR_HEIGHT }}
        />
    );
}

function TimedEntry({
    entry,
    lane,
    lanes,
    props
}: {
    entry: CalendarEntry;
    lane: number;
    lanes: number;
    props: ViewProps;
}) {
    const format = useDisplayFormat();
    const top = (layout.minutesInto(entry.start) / 60) * HOUR_HEIGHT;
    // A task is an instant, so it is drawn half an hour tall: a hairline block is
    // one nobody can hit with a pointer.
    const minutes = entry.end ? Math.max(20, (entry.end.getTime() - entry.start.getTime()) / 60_000) : 30;
    const style: CSSProperties = {
        top,
        height: (minutes / 60) * HOUR_HEIGHT - 2,
        left: `${(lane / lanes) * 100}%`,
        width: `${(1 / lanes) * 100}%`,
        borderLeftColor: entry.color
    };

    const body = (
        <span className="flex flex-col overflow-hidden text-left">
            <span className="truncate text-[0.6875rem] font-medium leading-tight">{entry.title}</span>
            <span className="truncate text-[0.625rem] leading-tight text-muted-foreground">
                {format.time(entry.start)}
                {entry.location ? ` - ${entry.location}` : ""}
            </span>
        </span>
    );

    if (!entry.task) {
        return (
            <a
                href={entry.url ?? "#"}
                target="_blank"
                rel="noreferrer noopener"
                title={`${entry.title} (Google Calendar)`}
                style={style}
                className="absolute z-[5] overflow-hidden rounded border border-l-2 border-border bg-card/95 px-1 py-0.5 transition-colors hover:bg-muted"
            >
                {body}
            </a>
        );
    }

    return (
        <TaskMenu commands={commandsFor(props, entry.task)}>
            <button
                type="button"
                onClick={() => props.onOpen(entry.task?.id as string)}
                title={entry.title}
                style={style}
                className="absolute z-[5] overflow-hidden rounded border border-l-2 border-border bg-card/95 px-1 py-0.5 text-left transition-colors hover:bg-muted"
            >
                {body}
            </button>
        </TaskMenu>
    );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** One line in a month cell or an all-day strip. */
function EntryChip({ entry, props }: { entry: CalendarEntry; props: ViewProps }) {
    if (!entry.task) {
        return (
            <li>
                <a
                    href={entry.url ?? "#"}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={`${entry.title} (Google Calendar)`}
                    className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-[0.6875rem] transition-colors hover:bg-muted"
                >
                    <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: entry.color }} />
                    <span className="truncate">{entry.title}</span>
                </a>
            </li>
        );
    }
    const task = entry.task;
    return (
        <TaskMenu commands={commandsFor(props, task)}>
            <li>
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        props.onOpen(task.id);
                    }}
                    title={task.name}
                    className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[0.6875rem] transition-colors hover:bg-muted"
                >
                    <StatusIcon color={task.statusColor} type={task.statusType} size={12} />
                    <span className="truncate">{task.name}</span>
                </button>
            </li>
        </TaskMenu>
    );
}

/** The tapped day, written out under a month on a phone. */
function DayList({
    day,
    entries,
    onOpen,
    format
}: {
    day: Date;
    entries: CalendarEntry[];
    onOpen: (taskId: string) => void;
    format: core.DisplayFormat;
}) {
    return (
        <div className="rounded-lg border border-border">
            <p className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium">
                {core.WEEKDAY_NAMES[day.getDay()]} {format.date(day)}
            </p>
            {entries.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">Nothing on this day.</p>
            ) : (
                <ul className="divide-y divide-border">
                    {entries.map((entry) => (
                        <li key={entry.key}>
                            <button
                                type="button"
                                onClick={() => (entry.task ? onOpen(entry.task.id) : undefined)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                            >
                                <span
                                    className="size-2 shrink-0 rounded-[2px]"
                                    style={{ backgroundColor: entry.color }}
                                />
                                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {entry.allDay ? "All day" : format.time(entry.start)}
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** Google's own place in the header: connect it, or turn its events off. */
function GoogleControl({
    state,
    showing,
    onToggle
}: {
    state: GoogleCalendarState;
    showing: boolean;
    onToggle: () => void;
}) {
    if (state.status === "unavailable") return null;
    if (state.status === "unlinked" || state.status === "expired") {
        return (
            <Button size="sm" variant="secondary" asChild>
                <a href="/api/connections/google/link">
                    <GoogleMark className="size-4" />
                    {state.status === "expired" ? "Reconnect Google Calendar" : "Connect Google Calendar"}
                </a>
            </Button>
        );
    }
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={showing}
            title={showing ? "Hide Google Calendar events" : "Show Google Calendar events"}
            className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted",
                showing ? "text-foreground" : "text-muted-foreground"
            )}
        >
            <GoogleMark className="size-3.5" />
            {state.status === "loading" ? "Loading..." : `Google (${state.events.length})`}
        </button>
    );
}
