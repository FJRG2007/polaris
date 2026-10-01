/**
 * What the grid is handed: every occurrence and task in the window as the grid
 * draws it, in wall times of the display zone, with the classes that say how
 * the reader is taking part and a sentence a screen reader reads for it.
 *
 * Pure, so what the grid shows can be asserted without drawing it.
 */

import { inkOn } from "./ui-color";
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

/** The grid's events for one window. */
export function gridEvents(range: RangeView | null, options: GridOptions): EventInput[] {
    if (!range) return [];
    const events: EventInput[] = [];
    for (const occurrence of range.occurrences) {
        const calendar = options.calendars.get(occurrence.calendarId);
        if (calendar?.hidden) continue;
        if (occurrence.myPartstat === "DECLINED" && !options.showDeclined) continue;
        const color = occurrence.color ?? calendar?.color ?? FALLBACK_COLOR;
        const classes = ["pc-event"];
        if (options.dimPast && new Date(occurrence.end) < options.now) classes.push("pc-past");
        if (occurrence.status === "CANCELLED") classes.push("pc-cancelled");
        if (occurrence.status === "TENTATIVE") classes.push("pc-tentative");
        if (occurrence.myPartstat === "NEEDS-ACTION") classes.push("pc-needs-action");
        if (occurrence.myPartstat === "TENTATIVE") classes.push("pc-tentative");
        if (occurrence.myPartstat === "DECLINED") classes.push("pc-declined");
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
            backgroundColor: color,
            borderColor: color,
            textColor: inkOn(color),
            classNames: classes,
            editable: occurrence.editable,
            startEditable: occurrence.editable,
            durationEditable: occurrence.editable,
            extendedProps: {
                item: { kind: "event", occurrence } satisfies GridItem,
                label: occurrenceLabel(occurrence, calendar, options)
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
        events.push({
            id: taskId(task),
            title: task.reference ? `${task.reference} ${task.title}` : task.title,
            start: task.allDay ? day : wallOf(task.due, options.zone),
            allDay: task.allDay,
            backgroundColor: "transparent",
            borderColor: color,
            classNames: ["pc-task", ...(task.done ? ["pc-done"] : [])],
            editable: false,
            extendedProps: { item: { kind: "task", task } satisfies GridItem, label }
        });
    }
    return events;
}
