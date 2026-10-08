"use client";

/**
 * The calendar: what is happening, on the day it happens.
 *
 * Several scopes rather than one, the same ones Google Calendar offers and on
 * the same keys. A month answers "how loaded is the next few weeks", a week is
 * what people plan against, four days is a week that still fits a laptop, a day
 * is the only one that fits a phone, a year is where the busy weeks show, and
 * the schedule is the plain list of what comes next. The scope and the "show"
 * switches are remembered per browser, because they are a way of working rather
 * than a setting of the list.
 *
 * The week begins on whichever day the account chose under Preferences, and the
 * grid is sized to the viewport instead of to a fixed row height: a calendar
 * that leaves half the screen empty is a calendar people scroll past. A month
 * cell shows as many lines as its height holds, and only what does not fit is
 * folded into "+N more".
 *
 * A task with no dates is not drawn - it is counted underneath - because a
 * calendar that invents a day for undated work lies about the plan. Google
 * Calendar events sit beside the tasks when the account has linked one, marked
 * as theirs and never editable from here.
 */

import * as core from "@polaris/core";
import { StatusIcon } from "../pickers";
import type { ViewProps } from "./shared";
import * as layout from "./calendar-layout";
import type { TaskRow } from "@/lib/tasks/facts";
import { GoogleMark } from "@/components/brand-icons";
import { commandsFor, TaskMenu } from "./task-actions";
import { useDisplayFormat } from "@/components/display-format";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleCheck, CircleX } from "lucide-react";
import {
    useGoogleCalendarEvents,
    type GoogleCalendarState
} from "@/lib/google-calendar/events-client";
import {
    cn,
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    MenuShortcut
} from "@polaris/ui";

type CalendarScope = layout.CalendarScope;
type CalendarEntry = layout.CalendarEntry;
type CalendarOptions = layout.CalendarOptions;

/** Where the chosen scope is kept, so the calendar opens the way it was left. */
const SCOPE_KEY = "polaris.tasks.calendar.scope";

/** Where the "show" switches are kept, for the same reason. */
const OPTIONS_KEY = "polaris.tasks.calendar.options";

/** One hour of the day grid, in pixels. Tall enough that a half-hour block still
 *  has room for a name. */
const HOUR_HEIGHT = 48;

/** What a day and a week grid open scrolled to, so the working day is on screen
 *  without anybody dragging the scrollbar first. */
const FIRST_VISIBLE_HOUR = 7;

/** The keys that move through time, Google's own: today, next and previous. */
const TODAY_KEY = "t";
const NEXT_KEY = "j";
const PREVIOUS_KEY = "k";

/** Somewhere a key press belongs to what has focus rather than to the calendar:
 *  a field being typed in, an open menu, a dialog over the screen. */
const KEEPS_ITS_KEYS =
    "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

function readOptions(): CalendarOptions {
    try {
        const raw = window.localStorage.getItem(OPTIONS_KEY);
        if (!raw) return layout.DEFAULT_OPTIONS;
        const stored = JSON.parse(raw) as Partial<Record<keyof CalendarOptions, unknown>>;
        const flag = (name: keyof CalendarOptions) =>
            typeof stored[name] === "boolean" ? (stored[name] as boolean) : layout.DEFAULT_OPTIONS[name];
        return {
            showWeekends: flag("showWeekends"),
            showDeclined: flag("showDeclined"),
            showCompleted: flag("showCompleted")
        };
    } catch {
        return layout.DEFAULT_OPTIONS;
    }
}

function remember(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // A blocked store only costs the next visit its remembered view.
    }
}

export function CalendarView(props: ViewProps) {
    const { rows, canEdit, onOpen, onQuickCreate } = props;
    const format = useDisplayFormat();
    const locale = useLocale();
    const t = useTranslations("tasksViews");
    const weekStartsOn = format.weekStartsOn;

    const [scope, setScope] = useState<CalendarScope>("month");
    const [offset, setOffset] = useState(0);
    const [selectedDay, setSelectedDay] = useState<string | null>(null);
    const [showGoogle, setShowGoogle] = useState(true);
    const [options, setOptions] = useState<CalendarOptions>(layout.DEFAULT_OPTIONS);

    // The stored scope is read after mount rather than during render: the server
    // has no localStorage, and a first paint that disagreed with it would flash.
    // A phone opens on Day when nothing was stored - a month of 7 columns there
    // is a grid of dots nobody can read.
    useEffect(() => {
        let stored: string | null = null;
        try {
            stored = window.localStorage.getItem(SCOPE_KEY);
        } catch {
            stored = null;
        }
        const known = layout.CALENDAR_SCOPES.find((entry) => entry === stored);
        if (known) setScope(known);
        else if (window.matchMedia("(max-width: 639px)").matches) setScope("day");
        setOptions(readOptions());
    }, []);

    function chooseScope(next: CalendarScope) {
        setScope(next);
        setOffset(0);
        setSelectedDay(null);
        remember(SCOPE_KEY, next);
    }

    function toggleOption(name: keyof CalendarOptions) {
        const next = { ...options, [name]: !options[name] };
        setOptions(next);
        remember(OPTIONS_KEY, JSON.stringify(next));
    }

    const today = useMemo(() => core.startOfDay(new Date()), []);

    /** Open one day on its own - what pressing a day in a year does. */
    function openDay(day: Date) {
        setScope("day");
        setOffset(Math.round((core.startOfDay(day).getTime() - today.getTime()) / 86_400_000));
        setSelectedDay(null);
        remember(SCOPE_KEY, "day");
    }

    // Google Calendar's keys, on this screen only while the calendar is drawn.
    // A modifier means the press is somebody else's shortcut, and a press inside
    // a field, a menu or a dialog belongs to that.
    const keys = useRef({ chooseScope, setOffset });
    keys.current = { chooseScope, setOffset };
    useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            const target = event.target instanceof HTMLElement ? event.target : null;
            if (target && (target.isContentEditable || target.closest(KEEPS_ITS_KEYS))) return;
            const key = event.key.toLowerCase();
            const next = layout.scopeForKey(key);
            if (next) {
                event.preventDefault();
                keys.current.chooseScope(next);
            } else if (key === TODAY_KEY) {
                event.preventDefault();
                keys.current.setOffset(0);
            } else if (key === NEXT_KEY || key === PREVIOUS_KEY) {
                event.preventDefault();
                keys.current.setOffset((current) => current + (key === NEXT_KEY ? 1 : -1));
            }
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    const { days, label, monthShown } = useMemo(
        () => layout.buildRange(scope, offset, weekStartsOn, format, new Date(), locale, options.showWeekends),
        [scope, offset, weekStartsOn, format, locale, options.showWeekends]
    );

    const from = days[0] as Date;
    const to = core.endOfDay(days[days.length - 1] as Date);

    const google = useGoogleCalendarEvents(from, to);
    const undated = useMemo(() => rows.filter((task) => !task.dueDate && !task.startDate), [rows]);

    const entries = useMemo(() => {
        const fromTasks = rows
            .map(layout.taskEntry)
            .filter((entry): entry is CalendarEntry => entry !== null);
        const all = showGoogle ? [...fromTasks, ...google.events.map(layout.googleEntry)] : fromTasks;
        return all.filter((entry) => layout.isShown(entry, options));
    }, [rows, google.events, showGoogle, options]);

    const onDay = (day: Date) => layout.entriesOnDay(entries, day);

    /** Make a task on a day, at an hour when the grid has one. The `date:` prefix
     *  tells the screen this key is a date rather than a group id. */
    const createOn = (day: Date, hour?: number) => {
        if (!canEdit) return;
        const at = new Date(day);
        if (hour !== undefined) at.setHours(hour, 0, 0, 0);
        onQuickCreate(`date:${at.toISOString()}`, t("toolbar.newTask"));
    };

    const unit = scope === "fourDays" || scope === "schedule" ? "period" : scope;
    const previousLabel = t("calendar.previous", { scope: unit });
    const nextLabel = t("calendar.next", { scope: unit });

    return (
        <div className="flex min-w-0 flex-col gap-3">
            <header className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        aria-label={previousLabel}
                        title={`${previousLabel} (${PREVIOUS_KEY.toUpperCase()})`}
                        onClick={() => setOffset(offset - 1)}
                        className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <ChevronLeft className="size-4" />
                    </button>
                    <button
                        type="button"
                        aria-label={nextLabel}
                        title={`${nextLabel} (${NEXT_KEY.toUpperCase()})`}
                        onClick={() => setOffset(offset + 1)}
                        className="rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <ChevronRight className="size-4" />
                    </button>
                </div>
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium sm:text-base">
                    {label}
                </h3>

                {offset !== 0 && (
                    <Button
                        size="sm"
                        variant="ghost"
                        title={`${t("calendar.today")} (${TODAY_KEY.toUpperCase()})`}
                        onClick={() => setOffset(0)}
                    >
                        {t("calendar.today")}
                    </Button>
                )}

                <ScopeMenu
                    scope={scope}
                    options={options}
                    onScope={chooseScope}
                    onToggle={toggleOption}
                />

                <GoogleControl
                    state={google}
                    showing={showGoogle}
                    onToggle={() => setShowGoogle(!showGoogle)}
                />
            </header>

            {scope === "month" ? (
                <MonthGrid
                    days={days}
                    monthShown={monthShown}
                    today={today}
                    weekStartsOn={weekStartsOn}
                    showWeekends={options.showWeekends}
                    selectedDay={selectedDay}
                    onSelectDay={(day) => setSelectedDay(day.toDateString())}
                    onCreate={createOn}
                    onDay={onDay}
                    props={props}
                />
            ) : scope === "year" ? (
                <YearGrid
                    days={days}
                    today={today}
                    weekStartsOn={weekStartsOn}
                    entries={entries}
                    onOpenDay={openDay}
                />
            ) : scope === "schedule" ? (
                <ScheduleList days={days} today={today} onDay={onDay} props={props} />
            ) : (
                <TimeGrid
                    days={days}
                    today={today}
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
                        {t("calendar.undated", { count: undated.length })}
                    </span>
                )}
                {canEdit && scope !== "year" && scope !== "schedule" && (
                    <span>
                        {t("calendar.doubleClick", { scope: scope === "month" ? "month" : "time" })}
                    </span>
                )}
                {google.status === "error" ? (
                    <span className="text-danger">{google.error ?? t("calendar.googleUnreachable")}</span>
                ) : null}
            </div>
        </div>
    );
}

/** The view picker: every scope on its key, and what the calendar shows. */
function ScopeMenu({
    scope,
    options,
    onScope,
    onToggle
}: {
    scope: CalendarScope;
    options: CalendarOptions;
    onScope: (scope: CalendarScope) => void;
    onToggle: (name: keyof CalendarOptions) => void;
}) {
    const t = useTranslations("tasksViews");
    const switches: { name: keyof CalendarOptions; label: string }[] = [
        { name: "showWeekends", label: t("calendar.showWeekends") },
        { name: "showDeclined", label: t("calendar.showDeclined") },
        { name: "showCompleted", label: t("calendar.showCompleted") }
    ];
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" aria-label={t("calendar.changeView")}>
                    {t(`calendar.scope.${scope}`)}
                    <ChevronDown className="size-3.5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
                {layout.CALENDAR_SCOPES.map((entry) => (
                    <DropdownMenuItem
                        key={entry}
                        onSelect={() => onScope(entry)}
                        className={cn(entry === scope && "font-medium text-primary")}
                    >
                        {t(`calendar.scope.${entry}`)}
                        <MenuShortcut>{layout.SCOPE_KEYS[entry]}</MenuShortcut>
                    </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                {switches.map((entry) => (
                    <DropdownMenuItem
                        key={entry.name}
                        role="menuitemcheckbox"
                        aria-checked={options[entry.name]}
                        // A switch stays open, so turning off two of them is two
                        // presses rather than two trips through the trigger.
                        onSelect={(event) => {
                            event.preventDefault();
                            onToggle(entry.name);
                        }}
                    >
                        <Check className={cn("text-primary", !options[entry.name] && "invisible")} />
                        {entry.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
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
    showWeekends,
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
    showWeekends: boolean;
    selectedDay: string | null;
    onSelectDay: (day: Date) => void;
    onCreate: (day: Date) => void;
    onDay: (day: Date) => CalendarEntry[];
    props: ViewProps;
}) {
    const headings = Array.from({ length: 7 }, (_, index) => (weekStartsOn + index) % 7).filter(
        (index) => showWeekends || (index !== 0 && index !== 6)
    );
    const locale = useLocale();
    const shortNames = core.weekdayNames(locale, "short");
    const longNames = core.weekdayNames(locale, "long");

    // Every cell is the same height - the rows share the grid's - so measuring
    // one list says how many lines each of them holds.
    const [measured, setMeasured] = useState<HTMLUListElement | null>(null);
    const [listHeight, setListHeight] = useState(0);
    useEffect(() => {
        if (!measured || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => setListHeight(measured.clientHeight));
        observer.observe(measured);
        setListHeight(measured.clientHeight);
        return () => observer.disconnect();
    }, [measured]);

    return (
        // Sized to what is left of the viewport rather than to its contents: the
        // rows share the height, so a month is a month-sized thing on a laptop
        // and on a 32-inch screen. The floor keeps it usable when the window is
        // short instead of squeezing six rows into nothing.
        <div className="flex h-[calc(100dvh-19rem)] min-h-[26rem] flex-col overflow-hidden rounded-lg border border-border">
            <div
                className="grid border-b border-border bg-muted/40"
                style={{ gridTemplateColumns: `repeat(${headings.length}, minmax(0, 1fr))` }}
            >
                {headings.map((index) => (
                    <div
                        key={index}
                        className="px-2 py-1.5 text-center text-[0.6875rem] text-muted-foreground"
                    >
                        <span className="hidden sm:inline">{shortNames[index]}</span>
                        <span className="sm:hidden">{(shortNames[index] as string).slice(0, 1)}</span>
                    </div>
                ))}
            </div>
            <div
                className="grid min-h-0 flex-1 gap-px overflow-y-auto overscroll-contain bg-border"
                style={{
                    gridTemplateColumns: `repeat(${headings.length}, minmax(0, 1fr))`,
                    gridAutoRows: "minmax(4.5rem, 1fr)"
                }}
            >
                {days.map((day, position) => {
                    const entries = onDay(day);
                    const outside = day.getMonth() !== monthShown;
                    const isToday = core.isSameDay(day, today);
                    const selected = selectedDay === day.toDateString();
                    const shown = layout.chipsThatFit(listHeight, entries.length);
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
                                    aria-label={`${longNames[day.getDay()]} ${day.getDate()}`}
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
                                        className={cn("size-1.5 rounded-full", entry.settled && "opacity-40")}
                                        style={{ backgroundColor: entry.color }}
                                    />
                                ))}
                            </div>

                            <ul
                                ref={position === 0 ? setMeasured : undefined}
                                className="hidden min-h-0 flex-1 flex-col gap-0.5 overflow-hidden sm:flex"
                            >
                                {entries.slice(0, shown).map((entry) => (
                                    <EntryChip key={entry.key} entry={entry} props={props} />
                                ))}
                                {entries.length > shown && (
                                    <li className="shrink-0">
                                        <MoreEntries
                                            day={day}
                                            hidden={entries.length - shown}
                                            entries={entries}
                                            props={props}
                                        />
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

/** "+N more": the rest of a day that did not fit its cell, one press away. */
function MoreEntries({
    day,
    hidden,
    entries,
    props
}: {
    day: Date;
    hidden: number;
    entries: CalendarEntry[];
    props: ViewProps;
}) {
    const t = useTranslations("tasksViews");
    const format = useDisplayFormat();
    const locale = useLocale();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    className="flex h-5 w-full items-center rounded px-1 text-left text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    {t("calendar.more", { count: hidden })}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto overscroll-contain">
                <DropdownMenuLabel>
                    {core.weekdayNames(locale, "long")[day.getDay()]} {format.date(day)}
                </DropdownMenuLabel>
                {entries.map((entry) =>
                    entry.task ? (
                        <DropdownMenuItem
                            key={entry.key}
                            onSelect={() => props.onOpen(entry.task?.id as string)}
                            className={cn(entry.settled && "opacity-60")}
                        >
                            <TaskMark task={entry.task} />
                            <span className={cn("min-w-0 flex-1 truncate", entry.settled && "line-through")}>
                                {entry.title}
                            </span>
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem key={entry.key} asChild className={cn(entry.settled && "opacity-60")}>
                            <a href={entry.url ?? "#"} target="_blank" rel="noreferrer noopener">
                                <span
                                    className="size-2.5 shrink-0 rounded-[2px]"
                                    style={{ backgroundColor: entry.color }}
                                />
                                <span className={cn("min-w-0 flex-1 truncate", entry.settled && "line-through")}>
                                    {entry.title}
                                </span>
                            </a>
                        </DropdownMenuItem>
                    )
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// ---------------------------------------------------------------------------
// Year
// ---------------------------------------------------------------------------

function YearGrid({
    days,
    today,
    weekStartsOn,
    entries,
    onOpenDay
}: {
    days: Date[];
    today: Date;
    weekStartsOn: number;
    entries: CalendarEntry[];
    onOpenDay: (day: Date) => void;
}) {
    const t = useTranslations("tasksViews");
    const locale = useLocale();
    const year = (days[0] as Date).getFullYear();
    const shortNames = core.weekdayNames(locale, "short");
    const monthName = new Intl.DateTimeFormat(locale, { month: "long" });
    const headings = Array.from({ length: 7 }, (_, index) => (weekStartsOn + index) % 7);

    // How much is on each day of the year, counted once rather than by asking
    // every one of 365 days to search every entry.
    const counts = useMemo(
        () => layout.countByDay(entries, days[0] as Date, days[days.length - 1] as Date),
        [days, entries]
    );

    return (
        <div className="h-[calc(100dvh-19rem)] min-h-[26rem] overflow-y-auto overscroll-contain rounded-lg border border-border p-3">
            <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {Array.from({ length: 12 }, (_, month) => (
                    <section key={month} className="min-w-0">
                        <h4 className="mb-1.5 px-1 text-sm font-medium capitalize">
                            {monthName.format(new Date(year, month, 1))}
                        </h4>
                        <div className="grid grid-cols-7 text-center text-[0.625rem] text-muted-foreground">
                            {headings.map((index) => (
                                <span key={index} className="py-0.5">
                                    {(shortNames[index] as string).slice(0, 1)}
                                </span>
                            ))}
                        </div>
                        {layout.monthWeeks(year, month, weekStartsOn).map((week, row) => (
                            <div key={row} className="grid grid-cols-7">
                                {week.map((day, column) => {
                                    if (!day) return <span key={column} />;
                                    const count = counts.get(day.toDateString()) ?? 0;
                                    const isToday = core.isSameDay(day, today);
                                    return (
                                        <button
                                            key={column}
                                            type="button"
                                            onClick={() => onOpenDay(day)}
                                            title={count > 0 ? t("calendar.dayCount", { count }) : undefined}
                                            className={cn(
                                                "relative mx-auto flex size-7 items-center justify-center rounded-full text-[0.6875rem] transition-colors",
                                                isToday
                                                    ? "bg-primary font-medium text-primary-foreground"
                                                    : count > 0
                                                      ? "font-medium text-foreground hover:bg-muted"
                                                      : "text-muted-foreground hover:bg-muted"
                                            )}
                                        >
                                            {day.getDate()}
                                            {count > 0 && !isToday && (
                                                <span
                                                    aria-hidden
                                                    className="absolute bottom-0.5 size-1 rounded-full bg-primary"
                                                />
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                    </section>
                ))}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

function ScheduleList({
    days,
    today,
    onDay,
    props
}: {
    days: Date[];
    today: Date;
    onDay: (day: Date) => CalendarEntry[];
    props: ViewProps;
}) {
    const t = useTranslations("tasksViews");
    const format = useDisplayFormat();
    const locale = useLocale();
    const shortNames = core.weekdayNames(locale, "short");
    const filled = days
        .map((day) => ({ day, entries: onDay(day) }))
        .filter((entry) => entry.entries.length > 0);

    return (
        <div className="h-[calc(100dvh-19rem)] min-h-[26rem] overflow-y-auto overscroll-contain rounded-lg border border-border">
            {filled.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {t("calendar.scheduleEmpty")}
                </p>
            ) : (
                <ol className="divide-y divide-border">
                    {filled.map(({ day, entries }) => {
                        const isToday = core.isSameDay(day, today);
                        return (
                            <li key={day.toISOString()} className="flex gap-3 px-3 py-2">
                                <div className="flex w-20 shrink-0 items-start gap-1.5 pt-0.5 sm:w-28">
                                    <span
                                        className={cn(
                                            "flex size-7 shrink-0 items-center justify-center rounded-full text-sm",
                                            isToday ? "bg-primary font-medium text-primary-foreground" : "text-foreground"
                                        )}
                                    >
                                        {day.getDate()}
                                    </span>
                                    <span className="truncate pt-1 text-[0.6875rem] uppercase text-muted-foreground">
                                        {shortNames[day.getDay()]}
                                    </span>
                                </div>
                                <ul className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    {entries.map((entry) => (
                                        <ScheduleRow key={entry.key} entry={entry} format={format} props={props} />
                                    ))}
                                </ul>
                            </li>
                        );
                    })}
                </ol>
            )}
        </div>
    );
}

function ScheduleRow({
    entry,
    format,
    props
}: {
    entry: CalendarEntry;
    format: core.DisplayFormat;
    props: ViewProps;
}) {
    const t = useTranslations("tasksViews");
    const when = entry.allDay
        ? t("calendar.allDay")
        : entry.end
          ? `${format.time(entry.start)} - ${format.time(entry.end)}`
          : format.time(entry.start);
    const line = (
        <>
            <span className="w-24 shrink-0 truncate text-xs text-muted-foreground sm:w-32" title={when}>{when}</span>
            <span className={cn("min-w-0 flex-1 truncate", entry.settled && "line-through")}>
                {entry.title}
            </span>
            {entry.location ? (
                <span className="hidden max-w-[12rem] shrink truncate text-xs text-muted-foreground md:inline">
                    {entry.location}
                </span>
            ) : null}
        </>
    );
    const rowClass =
        "flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded px-1.5 text-left text-sm transition-colors hover:bg-muted";

    if (!entry.task) {
        return (
            <li className={cn("flex items-center gap-1.5", entry.settled && "opacity-60")}>
                <span
                    className="ml-0.5 size-2.5 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: entry.color }}
                />
                <a
                    href={entry.url ?? "#"}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={t("calendar.googleEvent", { title: entry.title })}
                    className={rowClass}
                >
                    {line}
                </a>
            </li>
        );
    }
    const task = entry.task;
    return (
        <TaskMenu commands={commandsFor(props, task)}>
            <li className={cn("flex items-center gap-1.5", entry.settled && "opacity-60")}>
                <TaskCheck task={task} props={props} />
                <button type="button" onClick={() => props.onOpen(task.id)} title={task.name} className={rowClass}>
                    {line}
                </button>
            </li>
        </TaskMenu>
    );
}

// ---------------------------------------------------------------------------
// Day, four days and week
// ---------------------------------------------------------------------------

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function TimeGrid({
    days,
    today,
    onCreate,
    onDay,
    props
}: {
    days: Date[];
    today: Date;
    onCreate: (day: Date, hour: number) => void;
    onDay: (day: Date) => CalendarEntry[];
    props: ViewProps;
}) {
    const format = useDisplayFormat();
    const locale = useLocale();
    const t = useTranslations("tasksViews");
    const shortNames = core.weekdayNames(locale, "short");
    const scroller = useRef<HTMLDivElement>(null);
    // Five or more columns get a floor and scroll sideways on a phone rather
    // than squeezing each day to a sliver.
    const wide = days.length >= 5;

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
            <div className={cn("min-w-0", wide && "overflow-x-auto")}>
                <div className={cn("flex flex-col", wide && "min-w-[42rem]")}>
                    {/* Column headings and the all-day strip scroll horizontally
                        with the grid below, so a day never drifts off its own
                        column on a narrow screen. */}
                    <div className="flex border-b border-border bg-muted/40">
                        <div className="w-12 shrink-0 sm:w-14" />
                        {columns.map((column) => (
                            <div
                                key={column.day.toISOString()}
                                className="min-w-0 flex-1 px-1 py-1.5 text-center"
                            >
                                <div className="text-[0.6875rem] text-muted-foreground">
                                    {shortNames[column.day.getDay()]}
                                </div>
                                <div
                                    className={cn(
                                        "text-sm",
                                        core.isSameDay(column.day, today) &&
                                            "font-semibold text-primary"
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
                                {t("calendar.allDay")}
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

            <div
                ref={scroller}
                className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", wide && "overflow-x-auto")}
            >
                <div className={cn("flex", wide && "min-w-[42rem]")}>
                    <div className="w-12 shrink-0 sm:w-14">
                        {HOURS.map((hour) => (
                            <div
                                key={hour}
                                style={{ height: HOUR_HEIGHT }}
                                className="relative pr-1 text-right text-[0.625rem] text-muted-foreground"
                            >
                                <span className="absolute -top-1.5 right-1">
                                    {hourLabel(hour, format)}
                                </span>
                            </div>
                        ))}
                    </div>
                    {columns.map((column) => (
                        <div
                            key={column.day.toISOString()}
                            className="relative min-w-0 flex-1 border-l border-border"
                        >
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
    const t = useTranslations("tasksViews");
    const top = (layout.minutesInto(entry.start) / 60) * HOUR_HEIGHT;
    // A task is an instant, so it is drawn half an hour tall: a hairline block is
    // one nobody can hit with a pointer.
    const minutes = entry.end
        ? Math.max(20, (entry.end.getTime() - entry.start.getTime()) / 60_000)
        : 30;
    const style: CSSProperties = {
        top,
        height: (minutes / 60) * HOUR_HEIGHT - 2,
        left: `${(lane / lanes) * 100}%`,
        width: `${(1 / lanes) * 100}%`,
        borderLeftColor: entry.color
    };
    const box = cn(
        "absolute z-[5] overflow-hidden rounded border border-l-2 border-border bg-card/95 px-1 py-0.5",
        entry.settled && "opacity-60"
    );

    const body = (
        <span className="flex min-w-0 flex-col overflow-hidden text-left">
            <span
                className={cn(
                    "shrink-0 truncate text-[0.6875rem] font-medium leading-tight",
                    entry.settled && "line-through"
                )}
            >
                {entry.title}
            </span>
            <span className="shrink-0 truncate text-[0.625rem] leading-tight text-muted-foreground">
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
                title={t("calendar.googleEvent", { title: entry.title })}
                style={style}
                className={cn(box, "transition-colors hover:bg-muted")}
            >
                {body}
            </a>
        );
    }

    const task = entry.task;
    return (
        <TaskMenu commands={commandsFor(props, task)}>
            <div style={style} className={cn(box, "flex items-start gap-1")}>
                <TaskCheck task={task} props={props} />
                <button
                    type="button"
                    onClick={() => props.onOpen(task.id)}
                    title={entry.title}
                    className="flex min-w-0 flex-1 self-stretch rounded-sm text-left transition-colors hover:bg-muted"
                >
                    {body}
                </button>
            </div>
        </TaskMenu>
    );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * A task's mark: a check once it is done, a cross once it was closed, and the
 * status's own shape before that. The finished ones are drawn in the faded
 * foreground rather than the status colour, so a done task reads as a tick at
 * any size instead of as a coloured dot.
 */
function TaskMark({ task }: { task: TaskRow }) {
    if (task.statusType === "done") return <CircleCheck className="size-3.5 shrink-0 text-muted-foreground" />;
    if (task.statusType === "closed") return <CircleX className="size-3.5 shrink-0 text-muted-foreground" />;
    return <StatusIcon color={task.statusColor} type={task.statusType} size={14} />;
}

/** The mark, as the button that ticks the task off - or puts it back - when
 *  this screen may and knows which status that is. */
function TaskCheck({ task, props }: { task: TaskRow; props: ViewProps }) {
    const t = useTranslations("tasksViews");
    const target = props.canEdit ? layout.completionTarget(task, props.context.statuses) : null;
    if (!target) return <TaskMark task={task} />;
    const label = core.isFinishedStatus(task.statusType) ? t("calendar.markOpen") : t("calendar.markDone");
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={(event) => {
                event.stopPropagation();
                props.onEdit(task, { statusId: target });
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            className="shrink-0 rounded-full transition-opacity hover:opacity-70"
        >
            <TaskMark task={task} />
        </button>
    );
}

/** One line in a month cell or an all-day strip - exactly `CHIP_HEIGHT` tall,
 *  which is what lets a month cell work out how many of them it holds. */
function EntryChip({ entry, props }: { entry: CalendarEntry; props: ViewProps }) {
    const t = useTranslations("tasksViews");
    const title = (
        <span className={cn("min-w-0 truncate", entry.settled && "line-through")}>{entry.title}</span>
    );
    if (!entry.task) {
        return (
            <li className="shrink-0">
                <a
                    href={entry.url ?? "#"}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={t("calendar.googleEvent", { title: entry.title })}
                    style={{ height: layout.CHIP_HEIGHT }}
                    className={cn(
                        "flex w-full items-center gap-1 rounded px-1 text-[0.6875rem] transition-colors hover:bg-muted",
                        entry.settled && "opacity-60"
                    )}
                >
                    <span
                        className="size-2 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: entry.color }}
                    />
                    {title}
                </a>
            </li>
        );
    }
    const task = entry.task;
    return (
        <TaskMenu commands={commandsFor(props, task)}>
            <li
                style={{ height: layout.CHIP_HEIGHT }}
                className={cn(
                    "flex shrink-0 items-center gap-1 rounded px-1 transition-colors hover:bg-muted",
                    entry.settled && "opacity-60"
                )}
            >
                <TaskCheck task={task} props={props} />
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        props.onOpen(task.id);
                    }}
                    title={task.name}
                    className="flex h-full min-w-0 flex-1 items-center text-left text-[0.6875rem]"
                >
                    {title}
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
    const locale = useLocale();
    const t = useTranslations("tasksViews");
    return (
        <div className="rounded-lg border border-border">
            <p className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs font-medium">
                {core.weekdayNames(locale, "long")[day.getDay()]} {format.date(day)}
            </p>
            {entries.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">{t("calendar.nothingToday")}</p>
            ) : (
                <ul className="divide-y divide-border">
                    {entries.map((entry) => (
                        <li key={entry.key} className={cn(entry.settled && "opacity-60")}>
                            <button
                                type="button"
                                onClick={() => (entry.task ? onOpen(entry.task.id) : undefined)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                            >
                                {entry.task ? (
                                    <TaskMark task={entry.task} />
                                ) : (
                                    <span
                                        className="size-2 shrink-0 rounded-[2px]"
                                        style={{ backgroundColor: entry.color }}
                                    />
                                )}
                                <span className={cn("min-w-0 flex-1 truncate", entry.settled && "line-through")}>
                                    {entry.title}
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {entry.allDay ? t("calendar.allDay") : format.time(entry.start)}
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
    const t = useTranslations("tasksViews");
    if (state.status === "unavailable") return null;
    if (state.status === "unlinked" || state.status === "expired") {
        return (
            <Button size="sm" variant="secondary" asChild>
                <a href="/api/connections/google/link">
                    <GoogleMark className="size-4" />
                    {state.status === "expired" ? t("calendar.reconnectGoogle") : t("calendar.connectGoogle")}
                </a>
            </Button>
        );
    }
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={showing}
            title={showing ? t("calendar.hideGoogle") : t("calendar.showGoogle")}
            className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted",
                showing ? "text-foreground" : "text-muted-foreground"
            )}
        >
            <GoogleMark className="size-3.5" />
            {state.status === "loading" ? t("calendar.loading") : t("calendar.googleCount", { count: state.events.length })}
        </button>
    );
}
