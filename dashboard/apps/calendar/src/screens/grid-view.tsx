/**
 * The grid itself: FullCalendar, loaded only when the calendar is first drawn
 * so it is not in any page's first JavaScript.
 *
 * It runs in UTC and is handed wall times of the display zone (see time.ts), so
 * named zones need no plugin and the browser's own zone never leaks in. Views,
 * dates and the header are the screen's; this only draws the window it is told
 * to and reports what was pressed, dragged or selected - with the instants it
 * means, never the grid's own dates.
 *
 * The selection is the screen's too: a range stays highlighted for as long as
 * `selection` names it (while its new-event card or its menu is open), and goes
 * when that is cleared. Every event carries `data-event-id` and every day cell
 * and day column is a keyboard stop, which is what the grid's menu reads.
 *
 * Where the reader is in time is drawn the way Google draws it: today's date in
 * a filled circle wherever a day is named, a red line across today at the
 * current minute (with the time on the axis, as Apple and Outlook show it),
 * the days and hours already gone dimmed, the weekend a shade off the week,
 * and the first of a month named in the month grid. A time grid opens scrolled
 * to now when today is on it.
 */

import * as time from "./time";
import { GRID_CSS } from "./grid-css";
import listPlugin from "@fullcalendar/list";
import { KEYBOARD_CELLS } from "./grid-target";
import { measureMonth, monthLimits, type MonthEvents, type MonthRoom } from "./month-rows";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import timeGridPlugin from "@fullcalendar/timegrid";
import multiMonthPlugin from "@fullcalendar/multimonth";
import interactionPlugin from "@fullcalendar/interaction";
import { elapsedToday, type GridItem } from "./grid-events";
import { TaskMark } from "./task-card";
import type { TaskItemView } from "../lib/wire";
import type { CalendarViewName } from "../lib/preferences";
import type { EventReceiveArg, EventResizeDoneArg } from "@fullcalendar/interaction";
import type {
    DateSelectArg,
    DayCellContentArg,
    DayHeaderContentArg,
    EventApi,
    EventClickArg,
    EventDropArg,
    EventInput
} from "@fullcalendar/core";

export const FC_VIEWS: Record<CalendarViewName, string> = {
    day: "timeGridDay",
    week: "timeGridWeek",
    days: "timeGridDays",
    month: "dayGridMonth",
    year: "multiMonthYear",
    list: "listRange"
};

/** A time or a day the grid handed back, read in the display zone. */
export interface GridMoment {
    /** The instant (midnight in the display zone for a day). */
    readonly at: Date;
    /** The day it falls on. */
    readonly day: string;
    readonly allDay: boolean;
}

/** A range of the grid, as the screen holds it while it is highlighted. */
export interface GridRange {
    readonly start: GridMoment;
    readonly end: GridMoment;
}

export interface GridChange {
    readonly item: GridItem;
    readonly startDeltaMs: number;
    readonly endDeltaMs: number;
    /** Put it back where it was: the change was refused or cancelled. */
    readonly revert: () => void;
}

export interface GridViewProps {
    readonly view: CalendarViewName;
    readonly anchor: string;
    readonly customDays: number;
    readonly zone: string;
    readonly secondaryZone: string | null;
    readonly locale: string;
    readonly hour12: boolean;
    readonly firstDay: number;
    readonly showWeekends: boolean;
    readonly showWeekNumbers: boolean;
    /** The current moment; the line across today follows it. */
    readonly now: Date;
    /** Dim the days and hours already gone. */
    readonly dimPast: boolean;
    /** Changed to scroll a time grid to now (on "Today"). */
    readonly scrollToNowSignal: number;
    readonly slotMinutes: number;
    readonly dayStart: string;
    /** Events per day in the month: as many as fit, all (0), or at most a number. */
    readonly eventLimit: MonthEvents;
    readonly businessHours: { daysOfWeek: number[]; startTime: string; endTime: string }[];
    readonly events: EventInput[];
    readonly selectedId: string | null;
    /** The range to keep highlighted; null clears it. */
    readonly selection: GridRange | null;
    readonly words: {
        readonly allDay: string;
        readonly noEvents: string;
        readonly week: string;
        readonly more: (count: number) => string;
        readonly secondaryZone: string;
        /** A day cell's name for the keyboard, e.g. "Friday, 2 October 2026". */
        readonly day: (day: string) => string;
    };
    /** A range was selected. False: it was not taken (the long press that
     *  opened the menu ends in one), and the highlight goes back to `selection`. */
    readonly onSelectRange: (range: GridRange, anchor: DOMRect | null) => boolean;
    readonly onItemClick: (item: GridItem, id: string, anchor: DOMRect) => void;
    /** A task's round mark was pressed: tick it off, or back. */
    readonly onTaskToggle: (task: TaskItemView) => void;
    readonly onItemFocus: (id: string) => void;
    readonly onChange: (change: GridChange) => void;
    readonly onTaskDrop: (taskId: string, at: GridMoment) => void;
    readonly onOpenDay: (day: string, view: CalendarViewName) => void;
}

/** Events the all-day row of a day or week keeps above "+N more" when the
 *  month's setting is "as many as fit". */
const ALL_DAY_LINES = 4;

function moment(date: Date, allDay: boolean, zone: string): GridMoment {
    const day = time.gridDay(date);
    return { at: allDay ? time.dayStart(day, zone) : time.gridInstant(date, zone), day, allDay };
}

/** How far an edge moved, as the instants it names. An all-day edge moves by
 *  whole days, which the server applies as days rather than hours. */
function edgeDelta(before: Date | null, after: Date | null, allDay: boolean, zone: string): number {
    if (!before || !after) return 0;
    if (allDay) return time.daysBetween(time.gridDay(before), time.gridDay(after)) * 86_400_000;
    return time.gridInstant(after, zone).getTime() - time.gridInstant(before, zone).getTime();
}

function itemOf(event: EventApi): GridItem {
    return (event.extendedProps as { item: GridItem }).item;
}

/**
 * Make the day cells reachable by keyboard: each is focusable and named, and
 * one of them - the anchor's, else the first - is the grid's single tab stop.
 * Moving between them with the arrows is the menu wrapper's (`grid-menu.tsx`).
 */
function markCells(root: HTMLElement | null, anchor: string, name: (day: string) => string): void {
    if (!root) return;
    const cells = [...root.querySelectorAll<HTMLElement>(KEYBOARD_CELLS)];
    if (cells.length === 0) return;
    for (const cell of cells) {
        const day = cell.getAttribute("data-date") ?? "";
        cell.tabIndex = -1;
        if (!cell.hasAttribute("aria-label")) cell.setAttribute("aria-label", name(day));
    }
    const stop = cells.find((cell) => cell.getAttribute("data-date") === anchor) ?? cells[0]!;
    stop.tabIndex = 0;
}

/** Name the display zone in a time grid's empty top-left corner, as Google
 *  does; a corner holding the week number keeps it. */
function markZone(root: HTMLElement | null, label: string): void {
    if (!root) return;
    for (const corner of root.querySelectorAll<HTMLElement>(
        ".fc-col-header .fc-timegrid-axis-frame"
    ))
        corner.setAttribute("data-zone", label);
}

/** Whether two ranges are the same, so a highlight is not drawn twice. */
function sameRange(a: GridRange | null, b: GridRange | null): boolean {
    if (!a || !b) return a === b;
    return (
        a.start.allDay === b.start.allDay &&
        a.start.at.getTime() === b.start.at.getTime() &&
        a.end.at.getTime() === b.end.at.getTime()
    );
}

/** The views drawn as a time grid, where now is a line and the past is hours. */
const TIME_GRIDS: readonly CalendarViewName[] = ["day", "week", "days"];

export default function GridView(props: GridViewProps) {
    const calendar = useRef<FullCalendar>(null);
    const root = useRef<HTMLDivElement>(null);
    const fcView = FC_VIEWS[props.view];
    const propsRef = useRef(props);
    propsRef.current = props;
    /** What the grid itself has highlighted, so the screen's range is drawn once. */
    const drawn = useRef<GridRange | null>(null);
    /** Set while the range is drawn from here, so FullCalendar's own report of
     *  that selection is not taken for somebody selecting. */
    const drawing = useRef(false);

    /** Draw a range as the selection, without it counting as one being made. */
    const redraw = (range: GridRange | null) => {
        const api = calendar.current?.getApi();
        if (!api || sameRange(drawn.current, range)) return;
        drawn.current = range;
        if (!range) {
            api.unselect();
            return;
        }
        const zone = propsRef.current.zone;
        const toGrid = (moment: GridMoment) =>
            moment.allDay ? moment.day : new Date(`${time.wallOf(moment.at, zone).slice(0, 19)}Z`);
        drawing.current = true;
        try {
            api.select({
                start: toGrid(range.start),
                end: toGrid(range.end),
                allDay: range.start.allDay
            });
        } finally {
            drawing.current = false;
        }
    };

    // The highlight follows the screen's range.
    useEffect(() => {
        redraw(props.selection);
        // `redraw` reads everything else through refs.
    }, [props.selection]);

    useEffect(() => {
        const api = calendar.current?.getApi();
        if (!api) return;
        if (api.view.type !== fcView) api.changeView(fcView, props.anchor);
        else api.gotoDate(props.anchor);
    }, [fcView, props.anchor, props.customDays]);

    const timeGrid = TIME_GRIDS.includes(props.view);
    const today = time.todayIn(props.zone, props.now);
    const shown = time.viewWindow(props.view, props.anchor, props.firstDay, props.customDays);
    const todayShown = timeGrid && today >= shown.start && today < shown.end;
    /** Where a time grid opens: at now when today is on it, else the day's start. */
    const openingScroll = useRef(
        todayShown ? time.nowScrollTime(props.now, props.zone) : `${props.dayStart}:00`
    );

    // "Today" brings the line back into view, once the dates have moved there.
    useEffect(() => {
        if (props.scrollToNowSignal === 0) return;
        const frame = requestAnimationFrame(() => {
            const current = propsRef.current;
            if (!TIME_GRIDS.includes(current.view)) return;
            calendar.current?.getApi().scrollToTime(time.nowScrollTime(new Date(), current.zone));
        });
        return () => cancelAnimationFrame(frame);
    }, [props.scrollToNowSignal]);

    // The corner follows a change of zone, which moves no dates.
    const zoneLabel = time.zoneOffsetLabel(props.zone, props.now, props.locale);
    useEffect(() => {
        const frame = requestAnimationFrame(() => markZone(root.current, zoneLabel));
        return () => cancelAnimationFrame(frame);
    }, [zoneLabel, fcView]);

    const weekend = useMemo(() => new Set(time.weekendDays(props.locale)), [props.locale]);
    const dayClasses = (date: Date): string[] =>
        weekend.has(date.getUTCDay()) ? ["pc-weekend"] : [];
    const dayFormat = useMemo(
        () => ({
            weekday: new Intl.DateTimeFormat(props.locale, { weekday: "short", timeZone: "UTC" }),
            number: new Intl.DateTimeFormat(props.locale, { day: "numeric", timeZone: "UTC" }),
            monthDay: new Intl.DateTimeFormat(props.locale, {
                day: "numeric",
                month: "short",
                timeZone: "UTC"
            })
        }),
        [props.locale]
    );

    const views = useMemo(
        () => ({
            // Only the weeks of the month, as Google draws it: five most months,
            // each taller for it. (The range read is still six weeks.)
            dayGridMonth: { fixedWeekCount: false },
            timeGridDays: { type: "timeGrid", duration: { days: props.customDays } },
            listRange: { type: "list", duration: { days: time.LIST_DAYS } }
        }),
        [props.customDays]
    );

    const hourFormat = useMemo(
        () =>
            new Intl.DateTimeFormat(props.locale, {
                hour: "numeric",
                minute: "2-digit",
                hour12: props.hour12,
                timeZone: "UTC"
            }),
        [props.locale, props.hour12]
    );
    const secondary =
        props.secondaryZone && props.secondaryZone !== props.zone ? props.secondaryZone : null;
    const nowWall = time.wallOf(props.now, props.zone);
    const events = useMemo(() => {
        const drawn = props.events.map((event) =>
            event.id === props.selectedId
                ? {
                      ...event,
                      classNames: [...((event.classNames as string[]) ?? []), "pc-selected"]
                  }
                : event
        );
        return props.dimPast && todayShown ? [...drawn, elapsedToday(today, nowWall)] : drawn;
    }, [props.events, props.selectedId, props.dimPast, todayShown, today, nowWall]);

    // Every week of the month the same height (see month-rows.ts): read again
    // once the events are drawn, when the limit or the window changes, and when
    // the grid is resized.
    const month = props.view === "month";
    const [room, setRoom] = useState<MonthRoom | null>(null);
    useEffect(() => {
        const element = root.current;
        if (!month || !element) return;
        let outer = 0;
        let inner = 0;
        const read = () => {
            cancelAnimationFrame(outer);
            cancelAnimationFrame(inner);
            // Two frames: FullCalendar places the events after it has measured them.
            outer = requestAnimationFrame(() => {
                inner = requestAnimationFrame(() => {
                    const next = measureMonth(element);
                    if (!next) return;
                    setRoom((current) =>
                        current?.fit === next.fit &&
                        current.rows === next.rows &&
                        current.tallest === next.tallest
                            ? current
                            : next
                    );
                });
            });
        };
        read();
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read);
        observer?.observe(element);
        return () => {
            cancelAnimationFrame(outer);
            cancelAnimationFrame(inner);
            observer?.disconnect();
        };
    }, [month, events, props.eventLimit, props.anchor, props.showWeekends, room?.fit, room?.rows]);
    // Only with no limit: a limit is already capped to what an equal share holds.
    const weekFloor =
        month && room && props.eventLimit === 0
            ? ({ "--pc-week-min": `${room.tallest}px` } as CSSProperties)
            : undefined;

    return (
        <div
            ref={root}
            className={`pc-grid h-full min-h-0${props.dimPast ? " pc-dim-past" : ""}`}
            style={weekFloor}
        >
            <style>{GRID_CSS}</style>
            <FullCalendar
                ref={calendar}
                plugins={[
                    dayGridPlugin,
                    timeGridPlugin,
                    listPlugin,
                    multiMonthPlugin,
                    interactionPlugin
                ]}
                initialView={fcView}
                initialDate={props.anchor}
                views={views}
                timeZone="UTC"
                now={() => time.wallOf(new Date(), propsRef.current.zone)}
                locale={{
                    code: props.locale,
                    allDayText: props.words.allDay,
                    noEventsText: props.words.noEvents,
                    weekText: props.words.week,
                    weekTextLong: props.words.week,
                    moreLinkText: props.words.more,
                    buttonText: {}
                }}
                firstDay={props.firstDay}
                headerToolbar={false}
                height="100%"
                weekends={props.showWeekends}
                weekNumbers={props.showWeekNumbers}
                navLinks
                navLinkDayClick={(date: Date) =>
                    propsRef.current.onOpenDay(time.gridDay(date), "day")
                }
                navLinkWeekClick={(date: Date) =>
                    propsRef.current.onOpenDay(time.gridDay(date), "week")
                }
                slotDuration={{ minutes: props.slotMinutes }}
                scrollTime={openingScroll.current}
                scrollTimeReset={false}
                slotLabelFormat={{
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: props.hour12,
                    omitZeroMinute: props.hour12
                }}
                eventTimeFormat={{
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: props.hour12,
                    meridiem: props.hour12 ? "short" : false
                }}
                slotLabelContent={
                    secondary
                        ? (arg) => {
                              const other = time.wallOf(
                                  time.gridInstant(arg.date, propsRef.current.zone),
                                  secondary
                              );
                              const date = new Date(`${other.slice(0, 16)}:00Z`);
                              return (
                                  <span className="pc-slot" title={props.words.secondaryZone}>
                                      <span className="pc-slot-secondary">
                                          {hourFormat.format(date)}
                                      </span>
                                      <span>{arg.text}</span>
                                  </span>
                              );
                          }
                        : undefined
                }
                dayHeaderClassNames={(arg: DayHeaderContentArg) => dayClasses(arg.date)}
                dayCellClassNames={(arg: DayCellContentArg) => dayClasses(arg.date)}
                dayHeaderContent={(arg: DayHeaderContentArg) =>
                    TIME_GRIDS.includes(propsRef.current.view) ? (
                        <span className="pc-dh">
                            <span className="pc-dh-weekday">
                                {dayFormat.weekday.format(arg.date)}
                            </span>
                            <span
                                className="pc-dh-number"
                                aria-current={arg.isToday ? "date" : undefined}
                            >
                                {dayFormat.number.format(arg.date)}
                            </span>
                        </span>
                    ) : (
                        arg.text
                    )
                }
                // Only where a day cell shows its number: a time grid's all-day
                // row has none, and the header above it already names the day.
                dayCellContent={
                    timeGrid
                        ? undefined
                        : (arg: DayCellContentArg) => (
                              <span
                                  className="pc-day-number"
                                  aria-current={arg.isToday ? "date" : undefined}
                              >
                                  {arg.date.getUTCDate() === 1 && propsRef.current.view === "month"
                                      ? dayFormat.monthDay.format(arg.date)
                                      : dayFormat.number.format(arg.date)}
                              </span>
                          )
                }
                nowIndicatorContent={(arg) =>
                    arg.isAxis ? (
                        <span className="pc-now-time">{hourFormat.format(arg.date)}</span>
                    ) : null
                }
                {...(month
                    ? monthLimits(props.eventLimit, room)
                    : {
                          // The all-day row of a time grid: a number from
                          // settings, or the four lines it has always kept.
                          dayMaxEvents:
                              props.eventLimit === 0
                                  ? false
                                  : props.eventLimit === "fit"
                                    ? ALL_DAY_LINES
                                    : props.eventLimit,
                          dayMaxEventRows: false
                      })}
                businessHours={props.businessHours.length > 0 ? props.businessHours : false}
                nowIndicator
                editable
                eventResizableFromStart
                eventInteractive
                selectable
                selectMirror
                selectLongPressDelay={350}
                eventLongPressDelay={350}
                droppable
                unselectAuto={false}
                datesSet={() =>
                    requestAnimationFrame(() => {
                        const current = propsRef.current;
                        markCells(root.current, current.anchor, current.words.day);
                        markZone(
                            root.current,
                            time.zoneOffsetLabel(current.zone, current.now, current.locale)
                        );
                    })
                }
                eventAllow={(drop, dragged) => (dragged ? drop.allDay === dragged.allDay : true)}
                events={events}
                // A task wears Tasks' round status mark before its title, and the
                // mark ticks it off; everything else is drawn as the grid draws it.
                eventContent={(arg) => {
                    const item = (arg.event.extendedProps as { item?: GridItem }).item;
                    if (item?.kind !== "task") return true;
                    // On a chip the mark is drawn in the chip's ink with the tick
                    // in its fill; where there is no chip - a timed task in the
                    // month or the year is a line on the page, and so is every
                    // row of the schedule - in the calendar's own colour.
                    const type = arg.view.type;
                    const chip = type.startsWith("timeGrid") || (arg.event.allDay && !type.startsWith("list"));
                    return (
                        <span className="pc-task-chip flex min-w-0 items-center gap-1 overflow-hidden px-0.5">
                            <TaskMark
                                task={item.task}
                                color={
                                    chip
                                        ? arg.event.textColor || "currentColor"
                                        : arg.event.borderColor || arg.event.backgroundColor || "currentColor"
                                }
                                markColor={chip ? arg.event.backgroundColor || undefined : undefined}
                                size={12}
                                onToggle={(task) => propsRef.current.onTaskToggle(task)}
                            />
                            {arg.timeText ? (
                                <span className="fc-event-time shrink-0 tabular-nums">{arg.timeText}</span>
                            ) : null}
                            {/* The grid's own title class, so a done task is struck
                                through and a past one greyed like any event. */}
                            <span className="fc-event-title min-w-0 truncate">{arg.event.title}</span>
                        </span>
                    );
                }}
                eventDidMount={(arg) => {
                    // The dimmed past is drawing, not something a menu can be about.
                    if (arg.event.display === "background") return;
                    const { label, stripe } = arg.event.extendedProps as {
                        label?: string;
                        stripe?: string | null;
                    };
                    if (stripe) arg.el.style.setProperty("--pc-stripe", stripe);
                    arg.el.setAttribute("data-event-id", arg.event.id);
                    if (label) {
                        arg.el.setAttribute("aria-label", label);
                        // A title cut short by its box is still readable on hover.
                        arg.el.setAttribute("title", label);
                    }
                    arg.el.addEventListener("focus", () =>
                        propsRef.current.onItemFocus(arg.event.id)
                    );
                }}
                eventClick={(arg: EventClickArg) => {
                    arg.jsEvent.preventDefault();
                    if (!(arg.event.extendedProps as { item?: GridItem }).item) return;
                    const target = arg.jsEvent.target;
                    if (target instanceof Element && target.closest("[data-task-mark]")) return;
                    propsRef.current.onItemClick(
                        itemOf(arg.event),
                        arg.event.id,
                        arg.el.getBoundingClientRect()
                    );
                }}
                select={(arg: DateSelectArg) => {
                    if (drawing.current) return;
                    const zone = propsRef.current.zone;
                    const target =
                        arg.jsEvent?.target instanceof Element
                            ? arg.jsEvent.target.getBoundingClientRect()
                            : null;
                    const range = {
                        start: moment(arg.start, arg.allDay, zone),
                        end: moment(arg.end, arg.allDay, zone)
                    };
                    // Highlighted until the screen says otherwise: it holds the
                    // range while its card is open, and clears it after.
                    drawn.current = range;
                    if (propsRef.current.onSelectRange(range, target)) return;
                    const held = propsRef.current.selection;
                    drawn.current = null;
                    calendar.current?.getApi().unselect();
                    if (held) requestAnimationFrame(() => redraw(held));
                }}
                eventDrop={(arg: EventDropArg) => {
                    const zone = propsRef.current.zone;
                    const allDay = arg.oldEvent.allDay;
                    propsRef.current.onChange({
                        item: itemOf(arg.event),
                        startDeltaMs: edgeDelta(arg.oldEvent.start, arg.event.start, allDay, zone),
                        endDeltaMs: edgeDelta(
                            arg.oldEvent.end ?? arg.oldEvent.start,
                            arg.event.end ?? arg.event.start,
                            allDay,
                            zone
                        ),
                        revert: arg.revert
                    });
                }}
                eventResize={(arg: EventResizeDoneArg) => {
                    const zone = propsRef.current.zone;
                    const allDay = arg.oldEvent.allDay;
                    propsRef.current.onChange({
                        item: itemOf(arg.event),
                        startDeltaMs: edgeDelta(arg.oldEvent.start, arg.event.start, allDay, zone),
                        endDeltaMs: edgeDelta(
                            arg.oldEvent.end ?? arg.oldEvent.start,
                            arg.event.end ?? arg.event.start,
                            allDay,
                            zone
                        ),
                        revert: arg.revert
                    });
                }}
                eventReceive={(arg: EventReceiveArg) => {
                    const taskId = (arg.event.extendedProps as { taskId?: string }).taskId;
                    const start = arg.event.start;
                    const allDay = arg.event.allDay;
                    // The dropped copy is only a preview: the task is drawn again
                    // from the server once it has a due date.
                    arg.event.remove();
                    if (taskId && start)
                        propsRef.current.onTaskDrop(
                            taskId,
                            moment(start, allDay, propsRef.current.zone)
                        );
                }}
            />
        </div>
    );
}
