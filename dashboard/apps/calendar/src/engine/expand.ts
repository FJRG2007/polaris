/**
 * Recurrence expansion: which occurrences of an event fall in a range.
 *
 * RFC 5545 expands a rule in the event's own local time, so ical.js iterates
 * wall times in the TZID of DTSTART and each is then turned into an instant on
 * that zone's clock. That is what keeps a 09:00 Madrid meeting at 09:00 in
 * Madrid on both sides of a clock change. Occurrences are matched against
 * EXDATE and RECURRENCE-ID by that same wall reading, so a matching never
 * depends on which offset was in force.
 *
 * COUNT and UNTIL are applied here rather than by ical.js: DTSTART is always
 * the first occurrence (RFC 5545 3.8.5.3), and UNTIL in UTC has to be compared
 * with the local occurrence after it is placed in time, which a floating
 * iterator cannot do.
 */

import ICAL from "ical.js";
import { addToWall, formatWall, parseWall, wallDifferenceSeconds } from "./tz";
import type { CalendarEvent, CalendarItem, DateValue, Frequency, Occurrence, RecurrenceRule, WallTime } from "./types";
import { addDays, clockFor, daysBetween, isDateOnly, valueToInstant, valueWall, type ZoneClock } from "./zones";

/** Iterations a single rule may take before it is treated as runaway. */
const ITERATION_GUARD = 200_000;

/** The wall-clock length of one period, for the frequencies whose periods all
 *  have the same length. */
const PERIOD_SECONDS: Partial<Record<Frequency, number>> = { SECONDLY: 1, MINUTELY: 60, HOURLY: 3600, DAILY: 86_400, WEEKLY: 604_800 };

/** The most days each month can have. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Where every expansion of one item reads its times. */
export interface ExpandContext {
    readonly floatingZone: string;
    readonly timezones: readonly string[];
}

/** A generated occurrence start, before it is placed in time. */
export interface GeneratedStart {
    /** The start as a wall reading in the master's zone (`YYYY-MM-DDTHH:mm:ss`)
     *  or, all-day, its date. What EXDATE and RECURRENCE-ID are matched on. */
    readonly wallKey: string;
    readonly wall: WallTime;
}

/** The clock the master's start is read on. */
export function masterClock(master: CalendarEvent, context: ExpandContext): ZoneClock {
    const tzid = isDateOnly(master.start) ? null : master.start.tzid;
    return clockFor(tzid, context.floatingZone, context.timezones);
}

/**
 * The wall key a DTSTART-like value has in the master's frame: how an EXDATE,
 * RDATE or RECURRENCE-ID is compared with generated occurrences.
 */
export function wallKeyOf(value: DateValue, master: CalendarEvent, context: ExpandContext): string {
    if (isDateOnly(master.start)) return isDateOnly(value) ? value.date : value.dateTime.slice(0, 10);
    const start = master.start;
    if (isDateOnly(value)) return `${value.date}${start.dateTime.slice(10)}`;
    if (value.tzid === start.tzid) return value.dateTime;
    return formatWall(masterClock(master, context).toWall(valueToInstant(value, context.floatingZone, context.timezones)));
}

/** The occurrence key a screen uses for a wall key: an ISO instant, or the date. */
export function recurrenceKeyOf(wallKey: string, master: CalendarEvent, context: ExpandContext): string {
    if (isDateOnly(master.start)) return wallKey;
    return masterClock(master, context).toInstant(parseWall(wallKey)).toISOString();
}

/** The wall key a screen's recurrence key stands for. */
export function wallKeyFromRecurrenceKey(key: string, master: CalendarEvent, context: ExpandContext): string {
    if (isDateOnly(master.start)) return key.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return `${key}${master.start.dateTime.slice(10)}`;
    return formatWall(masterClock(master, context).toWall(new Date(key)));
}

/** The RECURRENCE-ID value an override of that occurrence carries. */
export function recurrenceIdFor(key: string, master: CalendarEvent, context: ExpandContext): DateValue {
    const wallKey = wallKeyFromRecurrenceKey(key, master, context);
    if (isDateOnly(master.start)) return { date: wallKey };
    return { dateTime: wallKey, tzid: master.start.tzid };
}

function rawWithout(raw: string, names: readonly string[]): string {
    return raw
        .split(";")
        .filter((part) => part.trim() && !names.includes(part.split("=")[0]?.trim().toUpperCase() ?? ""))
        .join(";");
}

/** UNTIL in the master's frame: a wall key the last occurrence may not pass. */
function untilKey(master: CalendarEvent, context: ExpandContext): string | null {
    const until = master.rule?.until;
    if (!until) return null;
    if (isDateOnly(master.start)) return isDateOnly(until) ? until.date : wallKeyOf(until, { ...master, start: { dateTime: `${master.start.date}T00:00:00`, tzid: null } }, context).slice(0, 10);
    if (isDateOnly(until)) return `${until.date}T23:59:59`;
    return wallKeyOf(until, master, context);
}

/** Whether a rule's BYMONTH and BYMONTHDAY name no day that exists. */
function noSuchDay(rule: RecurrenceRule): boolean {
    if (rule.byMonthDay.length === 0) return false;
    const months = rule.byMonth.length > 0 ? rule.byMonth : MONTH_DAYS.map((_, index) => index + 1);
    return months.every((month) => rule.byMonthDay.every((day) => Math.abs(day) > (MONTH_DAYS[month - 1] ?? 0)));
}

/** Whether a generated day is one the rule's BYMONTH and BYMONTHDAY allow:
 *  ical.js rolls a day the month does not have (February 29th) into the next. */
function allowedDay(rule: RecurrenceRule, wall: WallTime): boolean {
    if (rule.byMonth.length > 0 && !rule.byMonth.includes(wall.month)) return false;
    if (rule.byMonthDay.length === 0) return true;
    const days = new Date(Date.UTC(wall.year, wall.month, 0)).getUTCDate();
    return rule.byMonthDay.some((day) => day === wall.day || days + day + 1 === wall.day);
}

/**
 * Every start the master's rule and RDATEs generate, in order, stopping after
 * `stopAfter` (a wall key) or `max` starts. EXDATE is not applied here.
 *
 * Starts before `from` (a wall key) other than DTSTART are left out, and a rule
 * that neither counts nor has periods of varying length is not walked through
 * them: its iteration begins a whole number of periods after DTSTART, two
 * periods short of `from`, which generates the same starts from there on.
 */
export function generateStarts(master: CalendarEvent, context: ExpandContext, stopAfter: string | null, max = Number.POSITIVE_INFINITY, from: string | null = null): GeneratedStart[] {
    const allDay = isDateOnly(master.start);
    const first = valueWall(master.start);
    const firstKey = allDay ? formatWall(first).slice(0, 10) : formatWall(first);
    const found = new Map<string, GeneratedStart>();
    const keyOfWall = (wall: WallTime) => (allDay ? formatWall(wall).slice(0, 10) : formatWall(wall));
    found.set(firstKey, { wallKey: firstKey, wall: first });
    const rule = master.rule;
    if (rule && !noSuchDay(rule)) {
        const limit = Math.min(max, rule.count ?? Number.POSITIVE_INFINITY);
        const until = untilKey(master, context);
        const recur = ICAL.Recur.fromString(rawWithout(rule.raw, ["COUNT", "UNTIL"]));
        let anchor = first;
        const period = (PERIOD_SECONDS[rule.frequency] ?? 0) * rule.interval;
        if (from !== null && rule.count === null && period > 0 && (!allDay || period % 86_400 === 0)) {
            const periods = Math.floor(wallDifferenceSeconds(first, parseWall(from)) / period) - 2;
            if (periods > 0) anchor = addToWall(first, { seconds: periods * period });
        }
        const iterator = recur.iterator(ICAL.Time.fromData({ ...anchor, isDate: allDay }));
        let emitted = 1;
        let guard = 0;
        for (let next = iterator.next(); next && emitted < limit && guard < ITERATION_GUARD; next = iterator.next(), guard++) {
            const wall: WallTime = { year: next.year, month: next.month, day: next.day, hour: allDay ? 0 : next.hour, minute: allDay ? 0 : next.minute, second: allDay ? 0 : next.second };
            const key = keyOfWall(wall);
            if (key <= firstKey) continue;
            if (until !== null && key > until) break;
            if (stopAfter !== null && key > stopAfter) break;
            if (!allowedDay(rule, wall)) continue;
            if (from === null || key >= from) found.set(key, { wallKey: key, wall });
            emitted++;
        }
    }
    for (const rdate of master.rdates) {
        const key = wallKeyOf(rdate, master, context);
        if (stopAfter !== null && key > stopAfter) continue;
        found.set(key, { wallKey: key, wall: parseWall(key) });
    }
    return [...found.values()].sort((a, b) => (a.wallKey < b.wallKey ? -1 : a.wallKey > b.wallKey ? 1 : 0));
}

/** The span an event covers, placed at a given start (wall reading in its frame). */
function placed(event: CalendarEvent, wall: WallTime, context: ExpandContext, clock: ZoneClock): { start: Date; end: Date; startDate: string | null; endDate: string | null } {
    if (isDateOnly(event.start)) {
        const startDate = formatWall(wall).slice(0, 10);
        const length = isDateOnly(event.end) ? Math.max(1, daysBetween(event.start.date, event.end.date)) : 1;
        const endDate = addDays(startDate, length);
        const floating = clockFor(null, context.floatingZone);
        return { start: floating.toInstant(parseWall(startDate)), end: floating.toInstant(parseWall(endDate)), startDate, endDate };
    }
    const start = clock.toInstant(wall);
    const end = event.end;
    if (!isDateOnly(end) && end.tzid === event.start.tzid) {
        // Same clock: keep the wall-clock length, so a 09:00-10:00 meeting is
        // still 09:00-10:00 on the day the clocks change.
        const seconds = wallDifferenceSeconds(valueWall(event.start), valueWall(end));
        return { start, end: clock.toInstant(addToWall(wall, { seconds: Math.max(0, seconds) })), startDate: null, endDate: null };
    }
    const length = valueToInstant(end, context.floatingZone, context.timezones).getTime() - valueToInstant(event.start, context.floatingZone, context.timezones).getTime();
    return { start, end: new Date(start.getTime() + Math.max(0, length)), startDate: null, endDate: null };
}

/** An event where its own DTSTART/DTEND put it (a single event or an override). */
export function placeEvent(event: CalendarEvent, context: ExpandContext): { start: Date; end: Date; startDate: string | null; endDate: string | null } {
    return placed(event, valueWall(event.start), context, clockFor(isDateOnly(event.start) ? null : event.start.tzid, context.floatingZone, context.timezones));
}

function overlaps(start: Date, end: Date, range: { from: Date; to: Date }): boolean {
    if (start.getTime() >= range.to.getTime()) return false;
    if (end.getTime() > range.from.getTime()) return true;
    // A zero-length event on the range's first instant is still in it.
    return start.getTime() === end.getTime() && start.getTime() >= range.from.getTime();
}

function occurrenceOf(event: CalendarEvent, recurrenceKey: string, span: ReturnType<typeof placed>, overridden: boolean, recurring: boolean): Occurrence {
    return {
        uid: event.uid,
        recurrenceKey,
        start: span.start,
        end: span.end,
        allDay: isDateOnly(event.start),
        startDate: span.startDate,
        endDate: span.endDate,
        overridden,
        recurring,
        event
    };
}

/** Whether an event repeats at all (a rule or extra dates). */
export function isRecurring(event: CalendarEvent): boolean {
    return event.rule !== null || event.rdates.length > 0;
}

/** Overrides by the wall key of the occurrence they replace. */
export function overridesByKey(item: Extract<CalendarItem, { component: "VEVENT" }>, context: ExpandContext): Map<string, CalendarEvent> {
    const found = new Map<string, CalendarEvent>();
    const master = item.master;
    if (!master) return found;
    for (const override of item.overrides) {
        if (override.recurrenceId) found.set(wallKeyOf(override.recurrenceId, master, context), override);
    }
    return found;
}

/**
 * Every occurrence of an event that overlaps `range` (start < to, end > from),
 * sorted by start, at most `limit` (2000 by default).
 *
 * An override replaces the occurrence it names wherever it moved to, in or out
 * of the range; an EXDATE removes one; RDATEs add some. An override with
 * RANGE=THISANDFUTURE moves every later occurrence by the same amount and lends
 * them its details, unless a later override of their own says otherwise. An
 * override naming an occurrence the rule never produces is not drawn - the same
 * reading ical.js and Nextcloud give it.
 */
export function expandItem(item: CalendarItem, range: { from: Date; to: Date }, options: { floatingZone: string; limit?: number }): Occurrence[] {
    if (item.component !== "VEVENT") return [];
    const context: ExpandContext = { floatingZone: options.floatingZone, timezones: item.timezones };
    const limit = options.limit ?? 2000;
    const master = item.master;
    const result: Occurrence[] = [];
    if (!master) {
        for (const override of item.overrides) {
            const span = placeEvent(override, context);
            const key = override.recurrenceId ? recurrenceKeyOfValue(override.recurrenceId, context) : span.start.toISOString();
            if (overlaps(span.start, span.end, range)) result.push(occurrenceOf(override, key, span, true, true));
        }
        return sortAndLimit(result, limit);
    }
    const clock = masterClock(master, context);
    if (!isRecurring(master)) {
        const span = placeEvent(master, context);
        const key = isDateOnly(master.start) ? master.start.date : span.start.toISOString();
        const override = overridesByKey(item, context).get(isDateOnly(master.start) ? master.start.date : master.start.dateTime);
        if (override) {
            const moved = placeEvent(override, context);
            if (overlaps(moved.start, moved.end, range)) result.push(occurrenceOf(override, key, moved, true, false));
        } else if (overlaps(span.start, span.end, range)) result.push(occurrenceOf(master, key, span, false, false));
        return result;
    }
    const overrides = overridesByKey(item, context);
    const exdates = new Set(master.exdates.map((value) => wallKeyOf(value, master, context)));
    const futures = [...overrides.entries()].filter(([, event]) => event.thisAndFuture).sort(([a], [b]) => (a < b ? -1 : 1));
    // Iterate far enough to reach the range's end and every overridden
    // occurrence, which may have been moved into the range from later on, and
    // as far again on both sides as a THISANDFUTURE override moves the rest.
    const reach = Math.max(0, ...futures.map(([, event]) => Math.abs(shiftSeconds(event, master, context)))) * 1000;
    const margin = 2 * 86_400_000 + masterLengthMs(master, context) + reach;
    let stopAfter = formatWall(clock.toWall(new Date(range.to.getTime() + 2 * 86_400_000 + reach)));
    if (isDateOnly(master.start)) stopAfter = stopAfter.slice(0, 10);
    for (const key of overrides.keys()) if (key > stopAfter) stopAfter = key;
    const lowWall = formatWall(clock.toWall(new Date(range.from.getTime() - margin)));
    const low = isDateOnly(master.start) ? lowWall.slice(0, 10) : lowWall;
    const from = [...overrides.keys()].reduce((earliest, key) => (key < earliest ? key : earliest), low);
    for (const generated of generateStarts(master, context, stopAfter, Number.POSITIVE_INFINITY, from)) {
        if (exdates.has(generated.wallKey)) continue;
        const override = overrides.get(generated.wallKey);
        if (override) {
            const span = placeEvent(override, context);
            if (overlaps(span.start, span.end, range)) result.push(occurrenceOf(override, recurrenceKeyOf(generated.wallKey, master, context), span, true, true));
            continue;
        }
        if (generated.wallKey < low) continue;
        const future = [...futures].reverse().find(([key]) => key < generated.wallKey)?.[1];
        const event = future ?? master;
        const wall = future ? addToWall(generated.wall, { seconds: shiftSeconds(future, master, context) }) : generated.wall;
        const span = placed(event, wall, context, future && isDateOnly(master.start) ? clockFor(isDateOnly(future.start) ? null : future.start.tzid, context.floatingZone, context.timezones) : clock);
        if (overlaps(span.start, span.end, range)) result.push(occurrenceOf(event, recurrenceKeyOf(generated.wallKey, master, context), span, false, true));
    }
    return sortAndLimit(result, limit);
}

/** How far a THISANDFUTURE override moves a later occurrence: its wall delta
 *  in seconds, read in the master's frame. */
function shiftSeconds(future: CalendarEvent, master: CalendarEvent, context: ExpandContext): number {
    const original = future.recurrenceId;
    if (!original) return 0;
    if (isDateOnly(future.start) || isDateOnly(original)) {
        const from = isDateOnly(original) ? original.date : original.dateTime.slice(0, 10);
        const to = isDateOnly(future.start) ? future.start.date : future.start.dateTime.slice(0, 10);
        return daysBetween(from, to) * 86_400;
    }
    const originalKey = wallKeyOf(original, master, context);
    const movedKey = wallKeyOf(future.start, master, context);
    return wallDifferenceSeconds(parseWall(originalKey), parseWall(movedKey));
}

function masterLengthMs(master: CalendarEvent, context: ExpandContext): number {
    const span = placeEvent(master, context);
    return Math.max(0, span.end.getTime() - span.start.getTime());
}

function recurrenceKeyOfValue(value: DateValue, context: ExpandContext): string {
    if (isDateOnly(value)) return value.date;
    return valueToInstant(value, context.floatingZone, context.timezones).toISOString();
}

function sortAndLimit(occurrences: Occurrence[], limit: number): Occurrence[] {
    return occurrences.sort((a, b) => a.start.getTime() - b.start.getTime() || a.recurrenceKey.localeCompare(b.recurrenceKey)).slice(0, limit);
}

/**
 * The occurrence a screen's key names, whether or not it is in any range the
 * screen has drawn: its override when there is one, otherwise the generated
 * occurrence. Null when the key names nothing the item has.
 */
export function occurrenceFor(item: CalendarItem, recurrenceKey: string, floatingZone: string): Occurrence | null {
    if (item.component !== "VEVENT") return null;
    const context: ExpandContext = { floatingZone, timezones: item.timezones };
    const master = item.master;
    if (!master) {
        const override = item.overrides.find((event) => event.recurrenceId && recurrenceKeyOfValue(event.recurrenceId, context) === recurrenceKey);
        return override ? occurrenceOf(override, recurrenceKey, placeEvent(override, context), true, true) : null;
    }
    const wallKey = wallKeyFromRecurrenceKey(recurrenceKey, master, context);
    const override = overridesByKey(item, context).get(wallKey);
    if (override) return occurrenceOf(override, recurrenceKey, placeEvent(override, context), true, isRecurring(master));
    const wall = parseWall(wallKey);
    return occurrenceOf(master, recurrenceKey, placed(master, wall, context, masterClock(master, context)), false, isRecurring(master));
}

/**
 * A task's times in instants. An all-day DUE or DTSTART is midnight in
 * `floatingZone`, like an all-day event.
 */
export function expandTodo(item: CalendarItem, floatingZone: string): { due: Date | null; start: Date | null; allDay: boolean } {
    if (item.component !== "VTODO") return { due: null, start: null, allDay: false };
    const { todo } = item;
    const due = todo.due ? valueToInstant(todo.due, floatingZone, item.timezones) : null;
    const start = todo.start ? valueToInstant(todo.start, floatingZone, item.timezones) : null;
    const reference = todo.due ?? todo.start;
    return { due, start, allDay: reference ? isDateOnly(reference) : false };
}
