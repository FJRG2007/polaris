/**
 * The grid of a published calendar: FullCalendar, read-only, loaded only when
 * the page first draws it. Like the calendar's own grid it runs in UTC and is
 * handed wall times of the visitor's zone, so named zones need no plugin.
 */

import { GRID_CSS } from "../grid-css";
import { useEffect, useRef } from "react";
import listPlugin from "@fullcalendar/list";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import type { EventInput } from "@fullcalendar/core";

export const PUBLIC_VIEWS = {
    month: "dayGridMonth",
    week: "timeGridWeek",
    list: "listRange"
} as const;
export type PublicView = keyof typeof PUBLIC_VIEWS;

export interface PublicGridProps {
    readonly view: PublicView;
    readonly anchor: string;
    readonly listDays: number;
    readonly firstDay: number;
    readonly locale: string;
    readonly now: string;
    readonly events: EventInput[];
    readonly words: {
        readonly allDay: string;
        readonly noEvents: string;
        readonly week: string;
        readonly more: (count: number) => string;
    };
}

export default function PublicGrid(props: PublicGridProps) {
    const calendar = useRef<FullCalendar>(null);
    const fcView = PUBLIC_VIEWS[props.view];

    useEffect(() => {
        const api = calendar.current?.getApi();
        if (!api) return;
        if (api.view.type !== fcView) api.changeView(fcView, props.anchor);
        else api.gotoDate(props.anchor);
    }, [fcView, props.anchor]);

    return (
        <div className="pc-grid h-full min-h-0">
            <style>{GRID_CSS}</style>
            <FullCalendar
                ref={calendar}
                plugins={[dayGridPlugin, timeGridPlugin, listPlugin]}
                initialView={fcView}
                initialDate={props.anchor}
                views={{ listRange: { type: "list", duration: { days: props.listDays } } }}
                timeZone="UTC"
                now={props.now}
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
                dayMaxEvents
                nowIndicator
                scrollTime="08:00:00"
                editable={false}
                selectable={false}
                eventTimeFormat={{ hour: "numeric", minute: "2-digit" }}
                slotLabelFormat={{ hour: "numeric", minute: "2-digit" }}
                events={props.events}
                eventDidMount={(arg) => {
                    const label = (arg.event.extendedProps as { label?: string }).label;
                    if (label) arg.el.setAttribute("aria-label", label);
                }}
            />
        </div>
    );
}
