/**
 * Reminders: when each alarm of each occurrence fires, and how a trigger is
 * said in words.
 *
 * A relative trigger counts from the occurrence's start (or its end, RELATED=
 * END); an all-day occurrence starts at midnight in the reader's zone, so "on
 * the day at 9:00" is +540 minutes from the start. An absolute trigger fires
 * once, whatever the recurrence. An override's own alarms replace the series'
 * for its occurrence, and a cancelled occurrence has none.
 */

import type { RuleTranslator } from "./rule";
import { expandItem, expandTodo, placeEvent, recurrenceKeyOf, wallKeyOf } from "./expand";
import type { Alarm, AlarmAction, AlarmTrigger, CalendarItem } from "./types";

/** One reminder to deliver. */
export interface PlannedAlarm {
    /** Which alarm of the event, stable across unrelated edits and changed when
     *  the alarm itself changes - what a delivery log is keyed by. */
    readonly key: string;
    readonly action: AlarmAction;
    readonly fireAt: Date;
    readonly occurrenceStart: Date;
    readonly recurrenceKey: string;
}

const MINUTE = 60_000;

/** The stable key of one alarm: its place in the list and its trigger. */
export function alarmKey(alarm: Alarm, index: number): string {
    const trigger = alarm.trigger.kind === "absolute" ? `abs:${alarm.trigger.at}` : `rel:${alarm.trigger.minutes}:${alarm.trigger.related}`;
    return `${index}:${alarm.action}:${trigger}`;
}

/** The instant an absolute trigger names; one written without a zone is UTC. */
export function absoluteInstant(at: string): Date {
    return new Date(at.endsWith("Z") ? at : `${at}Z`);
}

function fireTime(alarm: Alarm, occurrence: { start: Date; end: Date }): Date {
    if (alarm.trigger.kind === "absolute") return absoluteInstant(alarm.trigger.at);
    const from = alarm.trigger.related === "END" ? occurrence.end : occurrence.start;
    return new Date(from.getTime() + alarm.trigger.minutes * MINUTE);
}

function inRange(date: Date, range: { from: Date; to: Date }): boolean {
    return date.getTime() >= range.from.getTime() && date.getTime() < range.to.getTime();
}

/** Fire times of a list of alarms for one occurrence. A null entry keeps its
 *  place (so keys stay the alarm's index) but is not planned. */
function plan(alarms: readonly (Alarm | null)[], occurrence: { start: Date; end: Date }, recurrenceKey: string, range: { from: Date; to: Date }): PlannedAlarm[] {
    const found: PlannedAlarm[] = [];
    alarms.forEach((alarm, index) => {
        if (!alarm) return;
        const fireAt = fireTime(alarm, occurrence);
        if (inRange(fireAt, range)) found.push({ key: alarmKey(alarm, index), action: alarm.action, fireAt, occurrenceStart: occurrence.start, recurrenceKey });
    });
    return found;
}

/**
 * Every alarm that fires in `range` (from inclusive, to exclusive), for every
 * occurrence, sorted by fire time.
 */
export function alarmsFor(item: CalendarItem, range: { from: Date; to: Date }, floatingZone: string): PlannedAlarm[] {
    if (item.component === "VTODO") {
        const times = expandTodo(item, floatingZone);
        const start = times.start ?? times.due;
        const end = times.due ?? times.start;
        if (!start || !end || item.todo.status === "COMPLETED" || item.todo.status === "CANCELLED") return [];
        const reference = item.todo.due ?? item.todo.start;
        const key = reference && "date" in reference ? reference.date : start.toISOString();
        return sortByFire(plan(item.todo.alarms, { start, end }, key, range));
    }
    const events = [item.master, ...item.overrides].filter((event) => event !== null);
    const offsets = events.flatMap((event) => event.alarms).filter((alarm) => alarm.trigger.kind === "relative").map((alarm) => (alarm.trigger.kind === "relative" ? alarm.trigger.minutes : 0));
    if (events.every((event) => event.alarms.length === 0)) return [];
    // An occurrence whose alarm fires in the range starts within these bounds.
    const earliest = Math.min(0, ...offsets);
    const latest = Math.max(0, ...offsets);
    const window = { from: new Date(range.from.getTime() - latest * MINUTE), to: new Date(range.to.getTime() - earliest * MINUTE + MINUTE) };
    const found: PlannedAlarm[] = [];
    const relativeOnly = (alarms: readonly Alarm[]) => alarms.map((alarm) => (alarm.trigger.kind === "absolute" ? null : alarm));
    for (const occurrence of expandItem(item, window, { floatingZone, limit: 10_000 })) {
        if (occurrence.event.status === "CANCELLED") continue;
        found.push(...plan(relativeOnly(occurrence.event.alarms), occurrence, occurrence.recurrenceKey, range));
    }
    // An absolute trigger fires once, whatever the recurrence and wherever the
    // occurrences are: it belongs to the component that carries it.
    const context = { floatingZone, timezones: item.timezones };
    for (const event of events) {
        if (event.status === "CANCELLED" || !event.alarms.some((alarm) => alarm.trigger.kind === "absolute")) continue;
        const span = placeEvent(event, context);
        const key = event.recurrenceId && item.master ? recurrenceKeyOf(wallKeyOf(event.recurrenceId, item.master, context), item.master, context) : span.startDate ?? span.start.toISOString();
        const absolute = event.alarms.map((alarm) => (alarm.trigger.kind === "absolute" ? alarm : null));
        found.push(...plan(absolute, span, key, range));
    }
    return sortByFire(found);
}

function sortByFire(alarms: PlannedAlarm[]): PlannedAlarm[] {
    return alarms.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime() || a.key.localeCompare(b.key));
}

/**
 * The next time each alarm fires after `after`, looking `horizonDays` ahead:
 * one entry per alarm key, what a reminder job schedules next.
 */
export function nextAlarm(item: CalendarItem, after: Date, floatingZone: string, horizonDays = 400): PlannedAlarm[] {
    const range = { from: new Date(after.getTime() + 1), to: new Date(after.getTime() + horizonDays * 86_400_000) };
    const first = new Map<string, PlannedAlarm>();
    for (const alarm of alarmsFor(item, range, floatingZone)) if (!first.has(alarm.key)) first.set(alarm.key, alarm);
    return sortByFire([...first.values()]);
}

/**
 * The reminder choices the editor offers, Nextcloud's: for timed events at the
 * start, 5, 10, 15, 30 and 45 minutes, 1, 2 and 3 hours, 1 and 2 days before;
 * for all-day events 9:00 on the day and 9:00 one, two, three days and a week
 * before.
 */
export function defaultAlarmPresets(allDay: boolean): AlarmTrigger[] {
    const relative = (minutes: number): AlarmTrigger => ({ kind: "relative", minutes, related: "START" });
    if (allDay) return [540, 540 - 1440, 540 - 2 * 1440, 540 - 3 * 1440, 540 - 7 * 1440].map(relative);
    return [0, -5, -10, -15, -30, -45, -60, -120, -180, -1440, -2880].map(relative);
}

/** "15 minutes", "2 hours", "1 week": the largest unit that divides evenly. */
function amount(minutes: number, t: RuleTranslator): string {
    const value = Math.abs(minutes);
    if (value % 10_080 === 0) return t("alarm.weeks", { n: value / 10_080 });
    if (value % 1440 === 0) return t("alarm.days", { n: value / 1440 });
    if (value % 60 === 0) return t("alarm.hours", { n: value / 60 });
    return t("alarm.minutes", { n: value });
}

function clock(minutesOfDay: number, locale: string): { text: string; one: "yes" | "no" } {
    const hours = Math.floor(minutesOfDay / 60);
    const date = new Date(Date.UTC(2024, 0, 1, hours, minutesOfDay % 60));
    const text = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(date);
    return { text, one: hours === 1 || hours === 13 ? "yes" : "no" };
}

/**
 * A trigger in words: "15 minutes before", "At the start", "1 day before at
 * 9:00 AM", "El mismo día a las 9:00". All-day triggers are read as a day and a
 * time of day, the way the presets are made. `t` is scoped to `rule.json`.
 */
export function describeTrigger(trigger: AlarmTrigger, allDay: boolean, t: RuleTranslator, options: { locale?: string; timeZone?: string } = {}): string {
    const locale = options.locale ?? "en-US";
    if (trigger.kind === "absolute") {
        const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: options.timeZone ?? "UTC" }).format(absoluteInstant(trigger.at));
        return t("alarm.onDate", { date });
    }
    const minutes = trigger.minutes;
    if (allDay && trigger.related === "START") {
        const days = Math.floor(minutes / 1440);
        const time = clock(minutes - days * 1440, locale);
        if (days === 0) return t("alarm.onDay", { at: time.text, one: time.one });
        const key = days < 0 ? "alarm.beforeAt" : "alarm.afterAt";
        return t(key, { time: amount(days * 1440, t), at: time.text, one: time.one });
    }
    if (minutes === 0) return t(trigger.related === "END" ? "alarm.atEnd" : "alarm.atStart");
    const time = amount(minutes, t);
    if (trigger.related === "END") return t(minutes < 0 ? "alarm.beforeEnd" : "alarm.afterEnd", { time });
    return t(minutes < 0 ? "alarm.before" : "alarm.after", { time });
}

