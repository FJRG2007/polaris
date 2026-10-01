/**
 * The grid itself: FullCalendar, loaded only when the calendar is first drawn
 * so it is not in any page's first JavaScript.
 *
 * It runs in UTC and is handed wall times of the display zone (see time.ts), so
 * named zones need no plugin and the browser's own zone never leaks in. Views,
 * dates and the header are the screen's; this only draws the window it is told
 * to and reports what was pressed, dragged or selected - with the instants it
 * means, never the grid's own dates.
 */

import * as time from "./time";
import { GRID_CSS } from "./grid-css";
import listPlugin from "@fullcalendar/list";
import type { GridItem } from "./grid-events";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import { useEffect, useMemo, useRef } from "react";
import timeGridPlugin from "@fullcalendar/timegrid";
import multiMonthPlugin from "@fullcalendar/multimonth";
import interactionPlugin from "@fullcalendar/interaction";
import type { CalendarViewName } from "../lib/preferences";
import type { EventReceiveArg, EventResizeDoneArg } from "@fullcalendar/interaction";
import type { DateSelectArg, EventApi, EventClickArg, EventDropArg, EventInput } from "@fullcalendar/core";

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
    readonly slotMinutes: number;
    readonly dayStart: string;
    readonly eventLimit: number;
    readonly businessHours: { daysOfWeek: number[]; startTime: string; endTime: string }[];
    readonly events: EventInput[];
    readonly selectedId: string | null;
    readonly words: {
        readonly allDay: string;
        readonly noEvents: string;
        readonly week: string;
        readonly more: (count: number) => string;
        readonly secondaryZone: string;
    };
    readonly onSelectRange: (range: { start: GridMoment; end: GridMoment }, anchor: DOMRect | null) => void;
    readonly onItemClick: (item: GridItem, id: string, anchor: DOMRect) => void;
    readonly onItemFocus: (id: string) => void;
    readonly onChange: (change: GridChange) => void;
    readonly onTaskDrop: (taskId: string, at: GridMoment) => void;
    readonly onOpenDay: (day: string, view: CalendarViewName) => void;
}

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

export default function GridView(props: GridViewProps) {
    const calendar = useRef<FullCalendar>(null);
    const fcView = FC_VIEWS[props.view];
    const propsRef = useRef(props);
    propsRef.current = props;

    useEffect(() => {
        const api = calendar.current?.getApi();
        if (!api) return;
        if (api.view.type !== fcView) api.changeView(fcView, props.anchor);
        else api.gotoDate(props.anchor);
    }, [fcView, props.anchor, props.customDays]);

    const views = useMemo(
        () => ({
            timeGridDays: { type: "timeGrid", duration: { days: props.customDays } },
            listRange: { type: "list", duration: { days: time.LIST_DAYS } }
        }),
        [props.customDays]
    );

    const hourFormat = useMemo(() => new Intl.DateTimeFormat(props.locale, { hour: "numeric", minute: "2-digit", hour12: props.hour12, timeZone: "UTC" }), [props.locale, props.hour12]);
    const secondary = props.secondaryZone && props.secondaryZone !== props.zone ? props.secondaryZone : null;
    const events = useMemo(() => props.events.map((event) => (event.id === props.selectedId ? { ...event, classNames: [...((event.classNames as string[]) ?? []), "pc-selected"] } : event)), [props.events, props.selectedId]);

    return (
        <div className="pc-grid h-full min-h-0">
            <style>{GRID_CSS}</style>
            <FullCalendar
                ref={calendar}
                plugins={[dayGridPlugin, timeGridPlugin, listPlugin, multiMonthPlugin, interactionPlugin]}
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
                navLinkDayClick={(date: Date) => propsRef.current.onOpenDay(time.gridDay(date), "day")}
                navLinkWeekClick={(date: Date) => propsRef.current.onOpenDay(time.gridDay(date), "week")}
                slotDuration={{ minutes: props.slotMinutes }}
                scrollTime={`${props.dayStart}:00`}
                scrollTimeReset={false}
                slotLabelFormat={{ hour: "numeric", minute: "2-digit", hour12: props.hour12, omitZeroMinute: props.hour12 }}
                eventTimeFormat={{ hour: "numeric", minute: "2-digit", hour12: props.hour12, meridiem: props.hour12 ? "short" : false }}
                slotLabelContent={
                    secondary
                        ? (arg) => {
                              const other = time.wallOf(time.gridInstant(arg.date, propsRef.current.zone), secondary);
                              const date = new Date(`${other.slice(0, 16)}:00Z`);
                              return (
                                  <span className="pc-slot" title={props.words.secondaryZone}>
                                      <span className="pc-slot-secondary">{hourFormat.format(date)}</span>
                                      <span>{arg.text}</span>
                                  </span>
                              );
                          }
                        : undefined
                }
                dayMaxEvents={props.eventLimit === 0 ? false : props.eventLimit}
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
                eventAllow={(drop, dragged) => (dragged ? drop.allDay === dragged.allDay : true)}
                events={events}
                eventDidMount={(arg) => {
                    const label = (arg.event.extendedProps as { label?: string }).label;
                    if (label) arg.el.setAttribute("aria-label", label);
                    arg.el.addEventListener("focus", () => propsRef.current.onItemFocus(arg.event.id));
                }}
                eventClick={(arg: EventClickArg) => {
                    arg.jsEvent.preventDefault();
                    propsRef.current.onItemClick(itemOf(arg.event), arg.event.id, arg.el.getBoundingClientRect());
                }}
                select={(arg: DateSelectArg) => {
                    const zone = propsRef.current.zone;
                    const target = arg.jsEvent?.target instanceof Element ? arg.jsEvent.target.getBoundingClientRect() : null;
                    propsRef.current.onSelectRange({ start: moment(arg.start, arg.allDay, zone), end: moment(arg.end, arg.allDay, zone) }, target);
                    calendar.current?.getApi().unselect();
                }}
                eventDrop={(arg: EventDropArg) => {
                    const zone = propsRef.current.zone;
                    const allDay = arg.oldEvent.allDay;
                    propsRef.current.onChange({
                        item: itemOf(arg.event),
                        startDeltaMs: edgeDelta(arg.oldEvent.start, arg.event.start, allDay, zone),
                        endDeltaMs: edgeDelta(arg.oldEvent.end ?? arg.oldEvent.start, arg.event.end ?? arg.event.start, allDay, zone),
                        revert: arg.revert
                    });
                }}
                eventResize={(arg: EventResizeDoneArg) => {
                    const zone = propsRef.current.zone;
                    const allDay = arg.oldEvent.allDay;
                    propsRef.current.onChange({
                        item: itemOf(arg.event),
                        startDeltaMs: edgeDelta(arg.oldEvent.start, arg.event.start, allDay, zone),
                        endDeltaMs: edgeDelta(arg.oldEvent.end ?? arg.oldEvent.start, arg.event.end ?? arg.event.start, allDay, zone),
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
                    if (taskId && start) propsRef.current.onTaskDrop(taskId, moment(start, allDay, propsRef.current.zone));
                }}
            />
        </div>
    );
}
