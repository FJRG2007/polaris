/**
 * What the grid is handed: every occurrence and task in the window as the grid
 * draws it, in wall times of the display zone, with the classes that say how
 * the reader is taking part and a sentence a screen reader reads for it.
 *
 * Pure, so what the grid shows can be asserted without drawing it.
 */

import { inkFor, mix, rgbOf } from "./ui-color";
import type { EventInput } from "@fullcalendar/core";
import type { CalendarTranslator } from "../lib/i18n";
import { formatInstant, formatDay, wallOf, addDays } from "./time";
import type { CalendarSummary, OccurrenceView, RangeView, TaskItemView } from "../lib/wire";

export type GridItem =
    | { readonly kind: "event"; readonly occurrence: OccurrenceView }
    | { readonly kind: "task"; readonly task: TaskItemView };

export interface GridOptions {
    readonly zone: string;
    readonly locale: string;
    readonly now: Date;
    readonly showDeclined: boolean;
    readonly showTasks: boolean;
    readonly dimPast: boolean;
    /** The colour the grid is drawn on (the card, as hex), which a faded or
     *  outlined event is mixed toward; the dark theme's when omitted. */
    readonly surface?: string;
    /** Calendars by id; a hidden one is not drawn. */
    readonly calendars: ReadonlyMap<string, CalendarSummary>;
    readonly t: CalendarTranslator;
}

/** The id the grid knows an occurrence by. */
export function occurrenceId(
    occurrence: Pick<OccurrenceView, "objectId" | "recurrenceKey">
): string {
    return `event|${occurrence.objectId}|${occurrence.recurrenceKey}`;
}

export function taskId(task: Pick<TaskItemView, "source" | "id">): string {
    return `task|${task.source}|${task.id}`;
}

const FALLBACK_COLOR = "#7f7f7f";

/** The dark theme's card, for a caller that did not say what it draws on. */
export const DARK_SURFACE = "#14161a";

/** How the reader takes part, which decides how an event is filled. */
export type EventResponse = "accepted" | "needs-action" | "tentative" | "declined";

/** The colours one event is drawn in. */
export interface EventPaint {
    readonly fill: string;
    readonly edge: string;
    readonly ink: string;
    /** Second colour of a striped fill (declined, cancelled, busy), or null. */
    readonly stripe: string | null;
}

/** How much of the event's colour a faded (past) event keeps. */
const PAST_WEIGHT = 0.55;
/** How much of it tints an outlined (unanswered, tentative) event. */
const TINT_WEIGHT = 0.18;
/** How much of it the stripes of a declined event carry. */
const STRIPE_WEIGHT = 0.28;

/**
 * The colours of one event, the way Google draws them: an event the reader
 * takes part in is filled with its colour; one not answered yet, or answered
 * "maybe", is outlined in it over a tint; a declined or cancelled one is
 * outlined over stripes; and a past one is the same, faded toward the page.
 * The ink is chosen against whatever it is drawn on - every fill and stripe -
 * so it reads at 4.5:1 or better whatever the colour and the theme.
 */
export function paintFor(
    color: string,
    state: {
        readonly response: EventResponse;
        readonly struck: boolean;
        readonly past: boolean;
        readonly busy?: boolean;
    },
    surface: string = DARK_SURFACE
): EventPaint {
    const base = rgbOf(color) ? color : FALLBACK_COLOR;
    const page = rgbOf(surface) ? surface : DARK_SURFACE;
    const own = state.past ? mix(base, page, PAST_WEIGHT) : base;
    if (state.struck || state.response === "declined") {
        const stripe = mix(own, page, STRIPE_WEIGHT);
        return { fill: page, edge: own, ink: inkFor(page, stripe), stripe };
    }
    if (state.response === "needs-action" || state.response === "tentative") {
        const fill = mix(own, page, TINT_WEIGHT);
        return { fill, edge: own, ink: inkFor(fill), stripe: null };
    }
    if (state.busy) {
        // The hatching moves away from the ink - darker under white text,
        // lighter under dark - so it never takes contrast from the title.
        const stripe =
            inkFor(own) === "#ffffff" ? mix("#000000", own, 0.18) : mix("#ffffff", own, 0.24);
        return { fill: own, edge: own, ink: inkFor(own, stripe), stripe };
    }
    return { fill: own, edge: own, ink: inkFor(own), stripe: null };
}

function responseOf(occurrence: OccurrenceView): EventResponse {
    if (occurrence.myPartstat === "DECLINED") return "declined";
    if (occurrence.myPartstat === "NEEDS-ACTION") return "needs-action";
    if (occurrence.myPartstat === "TENTATIVE" || occurrence.status === "TENTATIVE")
        return "tentative";
    return "accepted";
}

function whenText(occurrence: OccurrenceView, options: GridOptions): string {
    if (occurrence.allDay && occurrence.startDate) {
        const last = occurrence.endDate ? addDays(occurrence.endDate, -1) : occurrence.startDate;
        const format = new Intl.DateTimeFormat(options.locale, {
            dateStyle: "medium",
            timeZone: "UTC"
        });
        return last > occurrence.startDate
            ? format.formatRange(
                  new Date(`${occurrence.startDate}T12:00:00Z`),
                  new Date(`${last}T12:00:00Z`)
              )
            : formatDay(occurrence.startDate, options.locale, { dateStyle: "medium" });
    }
    return new Intl.DateTimeFormat(options.locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: options.zone
    }).formatRange(new Date(occurrence.start), new Date(occurrence.end));
}

/** What a screen reader says for one occurrence. */
export function occurrenceLabel(
    occurrence: OccurrenceView,
    calendar: CalendarSummary | undefined,
    options: GridOptions
): string {
    const t = options.t;
    const title = occurrence.busyOnly
        ? t("screen.busy")
        : occurrence.summary || t("screen.untitled");
    const parts = [title, whenText(occurrence, options)];
    if (calendar) parts.push(t("grid.inCalendar", { name: calendar.name }));
    if (occurrence.status === "CANCELLED") parts.push(t("grid.cancelled"));
    if (occurrence.myPartstat === "NEEDS-ACTION") parts.push(t("grid.needsAnswer"));
    if (occurrence.myPartstat === "TENTATIVE") parts.push(t("grid.tentative"));
    if (occurrence.myPartstat === "DECLINED") parts.push(t("grid.declined"));
    if (occurrence.recurring) parts.push(t("grid.repeats"));
    return parts.join(", ");
}

/** The background that dims today from midnight up to now (a wall time of the
 *  display zone), in a time grid. Not an event: nothing opens or moves it. */
export function elapsedToday(today: string, nowWall: string): EventInput {
    return {
        id: "pc-elapsed",
        start: `${today}T00:00:00`,
        end: nowWall.slice(0, 19),
        display: "background",
        classNames: ["pc-elapsed"],
        editable: false,
        interactive: false,
        extendedProps: {}
    };
}

/** The grid's events for one window. */
export function gridEvents(range: RangeView | null, options: GridOptions): EventInput[] {
    if (!range) return [];
    const events: EventInput[] = [];
    for (const occurrence of range.occurrences) {
        const calendar = options.calendars.get(occurrence.calendarId);
        if (calendar?.hidden) continue;
        if (occurrence.myPartstat === "DECLINED" && !options.showDeclined) continue;
        const color = occurrence.color ?? calendar?.color ?? FALLBACK_COLOR;
        const past = options.dimPast && new Date(occurrence.end) < options.now;
        const response = responseOf(occurrence);
        const paint = paintFor(
            color,
            {
                response,
                struck: occurrence.status === "CANCELLED",
                past,
                busy: occurrence.busyOnly
            },
            options.surface
        );
        const classes = ["pc-event", `pc-${response}`];
        if (past) classes.push("pc-past");
        if (occurrence.status === "CANCELLED") classes.push("pc-cancelled");
        if (paint.stripe) classes.push("pc-striped");
        if (occurrence.busyOnly) classes.push("pc-busy");
        if (occurrence.transparent) classes.push("pc-free");
        const allDay = occurrence.allDay && occurrence.startDate !== null;
        events.push({
            id: occurrenceId(occurrence),
            title: occurrence.busyOnly
                ? options.t("screen.busy")
                : occurrence.summary || options.t("screen.untitled"),
            start: allDay
                ? (occurrence.startDate as string)
                : wallOf(occurrence.start, options.zone),
            end: allDay
                ? (occurrence.endDate ?? addDays(occurrence.startDate as string, 1))
                : wallOf(occurrence.end, options.zone),
            allDay,
            backgroundColor: paint.fill,
            borderColor: paint.edge,
            textColor: paint.ink,
            classNames: classes,
            editable: occurrence.editable,
            startEditable: occurrence.editable,
            durationEditable: occurrence.editable,
            extendedProps: {
                item: { kind: "event", occurrence } satisfies GridItem,
                label: occurrenceLabel(occurrence, calendar, options),
                stripe: paint.stripe
            }
        });
    }
    if (!options.showTasks) return events;
    for (const task of range.tasks) {
        if (!task.due) continue;
        const calendar = task.calendarId ? options.calendars.get(task.calendarId) : undefined;
        if (calendar?.hidden) continue;
        const color = calendar?.color ?? FALLBACK_COLOR;
        const label = options.t(task.done ? "grid.taskDone" : "grid.task", {
            title: task.title,
            when: task.allDay
                ? formatDay(wallOf(task.due, options.zone).slice(0, 10), options.locale, {
                      dateStyle: "medium"
                  })
                : formatInstant(task.due, options.locale, options.zone, {
                      dateStyle: "medium",
                      timeStyle: "short"
                  })
        });
        const day = wallOf(task.due, options.zone).slice(0, 10);
        // A task is due at a moment rather than spanning one: past once that
        // moment has gone, and faded once done whenever it was due.
        const paint = paintFor(
            color,
            {
                response: "accepted",
                struck: false,
                past: task.done || (options.dimPast && new Date(task.due) < options.now)
            },
            options.surface
        );
        events.push({
            id: taskId(task),
            title: task.reference ? `${task.reference} ${task.title}` : task.title,
            start: task.allDay ? day : wallOf(task.due, options.zone),
            allDay: task.allDay,
            backgroundColor: paint.fill,
            borderColor: paint.edge,
            textColor: paint.ink,
            classNames: ["pc-task", ...(task.done ? ["pc-done"] : [])],
            editable: false,
            extendedProps: { item: { kind: "task", task } satisfies GridItem, label, stripe: null }
        });
    }
    return events;
}
