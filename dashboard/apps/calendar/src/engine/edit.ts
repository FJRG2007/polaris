/**
 * Changing a recurring event: this occurrence, this and the following ones, or
 * the whole series - and the same three for deleting.
 *
 * - "this" writes an override (a VEVENT with RECURRENCE-ID) for the one
 *   occurrence, or an EXDATE to delete it.
 * - "following" ends the original series just before the occurrence (UNTIL, or
 *   COUNT when the rule counted) and starts a new series, with a new UID, at the
 *   occurrence. Overrides and EXDATEs from there on move to the new series.
 * - "all" changes the master. Overrides keep their own values; when the series'
 *   date, time of day, zone or kind changes, their RECURRENCE-IDs and the
 *   EXDATEs are re-pointed at the occurrences' new starts so they still match.
 *
 * Keys are the `recurrenceKey` of an `Occurrence`. A floating event's keys were
 * placed in the reader's zone, so the functions take that zone too (UTC when
 * not given, which is only right for events that are not floating).
 */

import { withRule } from "./rule";
import * as expand from "./expand";
import { formatWall, parseWall, wallDifferenceSeconds, addToWall } from "./tz";
import { addDays, daysBetween, isDateOnly, valueToInstant, instantToValue } from "./zones";
import type {
    CalendarEvent,
    CalendarItem,
    DateValue,
    EditScope,
    PartStat,
    RecurrenceRule
} from "./types";

type EventItem = Extract<CalendarItem, { component: "VEVENT" }>;

function context(item: CalendarItem, floatingZone: string): expand.ExpandContext {
    return { floatingZone, timezones: item.timezones };
}

function sameValue(a: DateValue | null, b: DateValue | null): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether a change moves the event in time or changes how it repeats: the
 *  changes RFC 5546 says bump SEQUENCE. */
function timingChanged(before: CalendarEvent, after: CalendarEvent): boolean {
    return (
        !sameValue(before.start, after.start) ||
        !sameValue(before.end, after.end) ||
        (before.rule?.raw ?? null) !== (after.rule?.raw ?? null) ||
        JSON.stringify(before.rdates) !== JSON.stringify(after.rdates) ||
        JSON.stringify(before.exdates) !== JSON.stringify(after.exdates)
    );
}

function bumped(before: CalendarEvent, after: CalendarEvent): CalendarEvent {
    const sequence = Math.max(before.sequence, after.sequence);
    return { ...after, sequence: timingChanged(before, after) ? sequence + 1 : sequence };
}

function newUid(): string {
    return globalThis.crypto.randomUUID();
}

/** The part of a start that decides where every occurrence of a series sits
 *  within its day: its kind, zone and time of day. */
function frame(value: DateValue): string {
    return isDateOnly(value) ? "date" : `${value.tzid ?? ""}|${value.dateTime.slice(11)}`;
}

function dateOf(value: DateValue): string {
    return isDateOnly(value) ? value.date : value.dateTime.slice(0, 10);
}

/**
 * A RECURRENCE-ID / EXDATE / RDATE re-pointed at a master whose frame or date
 * changed: the calendar date moved by `days`, at the new start's time, zone
 * and kind.
 */
function reframe(
    value: DateValue,
    oldMaster: CalendarEvent,
    newStart: DateValue,
    ctx: expand.ExpandContext,
    days = 0
): DateValue {
    const date = addDays(expand.wallKeyOf(value, oldMaster, ctx).slice(0, 10), days);
    if (isDateOnly(newStart)) return { date };
    return { dateTime: `${date}${newStart.dateTime.slice(10)}`, tzid: newStart.tzid };
}

function onlyItem(item: CalendarItem): EventItem {
    if (item.component !== "VEVENT") throw new Error("Only events have occurrences to edit.");
    return item;
}

/** A value moved so its wall reading changes by `seconds`, in its own frame. */
function shiftValue(value: DateValue, seconds: number): DateValue {
    if (isDateOnly(value)) return { date: addDays(value.date, Math.round(seconds / 86_400)) };
    return {
        dateTime: formatWall(addToWall(parseWall(value.dateTime), { seconds })),
        tzid: value.tzid
    };
}

/** Whether two values are of one kind and, timed, in one zone (`zone` false:
 *  of one kind only). */
function sameFrame(a: DateValue, b: DateValue, zone = true): boolean {
    if (isDateOnly(a) || isDateOnly(b)) return isDateOnly(a) && isDateOnly(b);
    return !zone || a.tzid === b.tzid;
}

/** A value moved by as much as `from` became `to`, all three of one kind. */
function movedBy(value: DateValue, from: DateValue, to: DateValue): DateValue {
    if (isDateOnly(value))
        return { date: addDays(value.date, daysBetween(dateOf(from), dateOf(to))) };
    if (isDateOnly(from) || isDateOnly(to)) return value;
    return shiftValue(
        value,
        wallDifferenceSeconds(parseWall(from.dateTime), parseWall(to.dateTime))
    );
}

/** The whole-series edit: the master takes `next`, moved by as much as the
 *  edited occurrence moved. */
function editAll(
    item: EventItem,
    recurrenceKey: string | null,
    next: CalendarEvent,
    ctx: expand.ExpandContext
): EventItem {
    const master = item.master;
    if (!master) return item;
    let start = next.start;
    let end = next.end;
    if (recurrenceKey !== null) {
        const occurrence = expand.occurrenceFor(item, recurrenceKey, ctx.floatingZone);
        const shown = occurrence?.overridden ? occurrence.event : null;
        if (!occurrence) {
            start = master.start;
            end = master.end;
        } else if (
            shown &&
            sameFrame(shown.start, next.start) &&
            sameFrame(shown.end, next.end) &&
            sameFrame(master.start, next.start, false) &&
            sameFrame(master.end, next.end, false)
        ) {
            // Opened on a moved occurrence: the series moves by what changed
            // there, not to where that one occurrence was moved.
            start = movedBy(master.start, shown.start, next.start);
            end = movedBy(master.end, shown.end, next.end);
        } else {
            // The editor holds the occurrence; the series moves by the same
            // number of days and takes the new time of day and length.
            const shownDate = isDateOnly(occurrence.event.start)
                ? (occurrence.startDate ?? "")
                : formatWall(expand.masterClock(master, ctx).toWall(occurrence.start)).slice(0, 10);
            const newDate = isDateOnly(next.start)
                ? next.start.date
                : next.start.dateTime.slice(0, 10);
            const masterDate = isDateOnly(master.start)
                ? master.start.date
                : master.start.dateTime.slice(0, 10);
            const days = Math.round((Date.parse(newDate) - Date.parse(shownDate)) / 86_400_000);
            const startDate = addDays(masterDate, days);
            start = isDateOnly(next.start)
                ? { date: startDate }
                : {
                      dateTime: `${startDate}${next.start.dateTime.slice(10)}`,
                      tzid: next.start.tzid
                  };
            const length =
                isDateOnly(next.start) && isDateOnly(next.end)
                    ? {
                          days: Math.round(
                              (Date.parse(next.end.date) - Date.parse(next.start.date)) / 86_400_000
                          )
                      }
                    : null;
            if (length) end = { date: addDays(startDate, Math.max(1, length.days)) };
            else if (!isDateOnly(next.start) && !isDateOnly(next.end)) {
                if (next.end.tzid === next.start.tzid)
                    end = shiftValue(
                        start,
                        wallDifferenceSeconds(
                            parseWall(next.start.dateTime),
                            parseWall(next.end.dateTime)
                        )
                    );
                else {
                    const length =
                        valueToInstant(next.end, ctx.floatingZone, ctx.timezones).getTime() -
                        valueToInstant(next.start, ctx.floatingZone, ctx.timezones).getTime();
                    end = instantToValue(
                        new Date(
                            valueToInstant(start, ctx.floatingZone, ctx.timezones).getTime() +
                                length
                        ),
                        next.end,
                        ctx.floatingZone,
                        ctx.timezones
                    );
                }
            }
        }
    }
    const updated = bumped(master, {
        ...next,
        uid: master.uid,
        recurrenceId: null,
        thisAndFuture: false,
        start,
        end,
        exdates: master.exdates,
        rdates: master.rdates
    });
    const days = daysBetween(dateOf(master.start), dateOf(start));
    if (days === 0 && frame(master.start) === frame(start)) return { ...item, master: updated };
    return {
        ...item,
        master: {
            ...updated,
            exdates: master.exdates.map((value) => reframe(value, master, start, ctx, days)),
            rdates: master.rdates.map((value) => reframe(value, master, start, ctx, days))
        },
        overrides: item.overrides.map((override) =>
            override.recurrenceId
                ? {
                      ...override,
                      recurrenceId: reframe(override.recurrenceId, master, start, ctx, days)
                  }
                : override
        )
    };
}

/** An override for one occurrence, written or replaced. */
function editThis(
    item: EventItem,
    recurrenceKey: string,
    next: CalendarEvent,
    ctx: expand.ExpandContext
): EventItem {
    const master = item.master;
    const existing = master
        ? expand
              .overridesByKey(item, ctx)
              .get(expand.wallKeyFromRecurrenceKey(recurrenceKey, master, ctx))
        : item.overrides.find(
              (event) => event.recurrenceId && keyOfValue(event.recurrenceId, ctx) === recurrenceKey
          );
    const recurrenceId =
        existing?.recurrenceId ??
        (master ? expand.recurrenceIdFor(recurrenceKey, master, ctx) : null);
    if (!recurrenceId) return item;
    // SEQUENCE goes up when the occurrence moves from where it was drawn.
    const shown = expand.occurrenceFor(item, recurrenceKey, ctx.floatingZone);
    if (master && !shown) return item;
    const instant = (value: DateValue) =>
        valueToInstant(value, ctx.floatingZone, ctx.timezones).getTime();
    const moved =
        !shown ||
        instant(next.start) !== shown.start.getTime() ||
        instant(next.end) !== shown.end.getTime();
    const sequence = Math.max(next.sequence, existing?.sequence ?? 0, master?.sequence ?? 0);
    const override: CalendarEvent = {
        ...next,
        uid: item.uid,
        recurrenceId,
        thisAndFuture: false,
        rule: null,
        rdates: [],
        exdates: [],
        sequence: moved ? sequence + 1 : sequence
    };
    const overrides = existing
        ? item.overrides.map((event) => (event === existing ? override : event))
        : [...item.overrides, override];
    return { ...item, overrides };
}

function keyOfValue(value: DateValue, ctx: expand.ExpandContext): string {
    return isDateOnly(value)
        ? value.date
        : valueToInstant(value, ctx.floatingZone, ctx.timezones).toISOString();
}

/** The master cut so its last occurrence is the one before `wallKey`, and what
 *  was cut off: the starts that remain, and the overrides and dates after. */
function truncate(
    item: EventItem,
    wallKey: string,
    ctx: expand.ExpandContext
): {
    original: EventItem;
    before: number;
    overrides: CalendarEvent[];
    exdates: DateValue[];
    rdates: DateValue[];
} {
    const master = item.master;
    if (!master) throw new Error("A series with no master cannot be split.");
    // COUNT counts what the rule generates, RDATEs apart.
    const before = expand
        .generateStarts({ ...master, rdates: [] }, ctx, wallKey)
        .filter((start) => start.wallKey < wallKey).length;
    const at = (value: DateValue) => expand.wallKeyOf(value, master, ctx) >= wallKey;
    let rule: RecurrenceRule | null = master.rule;
    if (rule) {
        if (rule.count !== null) rule = withRule(rule, { count: Math.max(1, before) });
        else rule = withRule(rule, { until: untilBefore(wallKey, master, ctx) });
    }
    const keep = (event: CalendarEvent) => !event.recurrenceId || !at(event.recurrenceId);
    const truncated: CalendarEvent = bumped(master, {
        ...master,
        rule,
        exdates: master.exdates.filter((value) => !at(value)),
        rdates: master.rdates.filter((value) => !at(value))
    });
    return {
        original: { ...item, master: truncated, overrides: item.overrides.filter(keep) },
        before,
        overrides: item.overrides.filter((event) => !keep(event)),
        exdates: master.exdates.filter(at),
        rdates: master.rdates.filter(at)
    };
}

/** UNTIL for "stop just before this occurrence", in the form RFC 5545 wants
 *  for the master's DTSTART: a date, a UTC time, or a floating time. */
function untilBefore(wallKey: string, master: CalendarEvent, ctx: expand.ExpandContext): DateValue {
    if (isDateOnly(master.start)) return { date: addDays(wallKey.slice(0, 10), -1) };
    const previous = formatWall(addToWall(parseWall(wallKey), { seconds: -1 }));
    if (master.start.tzid === null) return { dateTime: previous, tzid: null };
    const instant = expand.masterClock(master, ctx).toInstant(parseWall(previous));
    return { dateTime: instant.toISOString().slice(0, 19), tzid: "UTC" };
}

function editFollowing(
    item: EventItem,
    recurrenceKey: string,
    next: CalendarEvent,
    ctx: expand.ExpandContext
): { item: EventItem; split: EventItem | null } {
    const master = item.master;
    if (!master || !master.rule)
        return { item: editAll(item, recurrenceKey, next, ctx), split: null };
    const wallKey = expand.wallKeyFromRecurrenceKey(recurrenceKey, master, ctx);
    const firstKey = expand.wallKeyOf(master.start, master, ctx);
    if (wallKey <= firstKey) return { item: editAll(item, recurrenceKey, next, ctx), split: null };
    const cut = truncate(item, wallKey, ctx);
    const uid = newUid();
    let rule = next.rule;
    // The same counted rule carries on for what was left of the count.
    if (rule && master.rule.count !== null && rule.raw === master.rule.raw)
        rule = withRule(rule, { count: Math.max(1, master.rule.count - cut.before) });
    const occurrenceStart = recurrenceIdStart(wallKey, master);
    const newMaster: CalendarEvent = {
        ...next,
        uid,
        recurrenceId: null,
        thisAndFuture: false,
        rule,
        sequence: 0,
        exdates: [],
        rdates: []
    };
    const moved =
        frame(occurrenceStart) !== frame(newMaster.start) ||
        !sameValue(occurrenceStart, newMaster.start);
    const days = daysBetween(wallKey.slice(0, 10), dateOf(newMaster.start));
    const carry = (value: DateValue) =>
        moved ? reframe(value, master, newMaster.start, ctx, days) : value;
    const splitMaster: CalendarEvent = {
        ...newMaster,
        exdates: cut.exdates.map(carry),
        rdates: cut.rdates.map(carry)
    };
    const split: EventItem = {
        component: "VEVENT",
        uid,
        master: splitMaster,
        // The occurrence being edited is the new series' first: its own
        // override, if it had one, is what `next` replaces.
        overrides: cut.overrides
            .filter(
                (event) =>
                    !event.recurrenceId ||
                    expand.wallKeyOf(event.recurrenceId, master, ctx) !== wallKey
            )
            .map((event) => ({
                ...event,
                uid,
                recurrenceId: event.recurrenceId ? carry(event.recurrenceId) : null
            })),
        timezones: item.timezones,
        method: null
    };
    return { item: cut.original, split };
}

function recurrenceIdStart(wallKey: string, master: CalendarEvent): DateValue {
    return isDateOnly(master.start)
        ? { date: wallKey }
        : { dateTime: wallKey, tzid: master.start.tzid };
}

/**
 * Save an edited event.
 *
 * `recurrenceKey` is the occurrence the editor was opened on (null for the
 * series itself or a single event); `next` is what the editor holds, with that
 * occurrence's own start and end (not the series'). The item
 * comes back changed; `split` is the new series a "following" edit starts, to
 * be stored as an object of its own. A single event ignores the scope.
 */
export function applyEdit(
    item: CalendarItem,
    recurrenceKey: string | null,
    next: CalendarEvent,
    scope: EditScope,
    floatingZone = "UTC"
): { item: CalendarItem; split: CalendarItem | null } {
    const events = onlyItem(item);
    const ctx = context(item, floatingZone);
    const master = events.master;
    const recurring = master ? expand.isRecurring(master) : events.overrides.length > 0;
    if (!recurring || !master) {
        if (master)
            return {
                item: {
                    ...events,
                    master: bumped(master, { ...next, uid: master.uid, recurrenceId: null })
                },
                split: null
            };
        if (recurrenceKey !== null)
            return { item: editThis(events, recurrenceKey, next, ctx), split: null };
        return { item, split: null };
    }
    if (recurrenceKey === null || scope === "all")
        return { item: editAll(events, recurrenceKey, next, ctx), split: null };
    if (scope === "this") return { item: editThis(events, recurrenceKey, next, ctx), split: null };
    return editFollowing(events, recurrenceKey, next, ctx);
}

/**
 * Delete occurrences. Returns the item left, or null when nothing of it
 * remains and the whole object should go.
 *
 * "this" removes the occurrence's override and adds an EXDATE; "following"
 * ends the series before it (deleting the first occurrence onwards is deleting
 * everything); "all" - or a key of null - deletes the object.
 */
export function deleteOccurrences(
    item: CalendarItem,
    recurrenceKey: string | null,
    scope: EditScope,
    floatingZone = "UTC"
): CalendarItem | null {
    if (item.component !== "VEVENT" || recurrenceKey === null || scope === "all") return null;
    const ctx = context(item, floatingZone);
    const master = item.master;
    if (!master) {
        const overrides = item.overrides.filter(
            (event) => !event.recurrenceId || keyOfValue(event.recurrenceId, ctx) !== recurrenceKey
        );
        return overrides.length > 0 ? { ...item, overrides } : null;
    }
    if (!expand.isRecurring(master)) return null;
    const wallKey = expand.wallKeyFromRecurrenceKey(recurrenceKey, master, ctx);
    const firstKey = expand.wallKeyOf(master.start, master, ctx);
    if (scope === "following") {
        if (wallKey <= firstKey) return null;
        return truncate(item, wallKey, ctx).original;
    }
    const overrides = item.overrides.filter(
        (event) =>
            !event.recurrenceId || expand.wallKeyOf(event.recurrenceId, master, ctx) !== wallKey
    );
    const exdate = recurrenceIdStart(wallKey, master);
    const exdates = master.exdates.some((value) => expand.wallKeyOf(value, master, ctx) === wallKey)
        ? master.exdates
        : [...master.exdates, exdate];
    const updated: EventItem = {
        ...item,
        master: bumped(master, { ...master, exdates }),
        overrides
    };
    // Deleting the only occurrence left is deleting the event.
    const remaining = expand
        .generateStarts(updated.master ?? master, ctx, null, 5001)
        .filter(
            (start) =>
                !exdates.some((value) => expand.wallKeyOf(value, master, ctx) === start.wallKey)
        );
    return remaining.length === 0 ? null : updated;
}

/**
 * Drag and resize: move an occurrence's start and end by these amounts and
 * save it with the given scope. All-day moves are whole days (the deltas are
 * rounded to days); a timed move keeps the event in its own zone.
 */
export function shiftOccurrence(
    item: CalendarItem,
    recurrenceKey: string | null,
    startDeltaMs: number,
    endDeltaMs: number,
    scope: EditScope,
    floatingZone = "UTC"
): { item: CalendarItem; split: CalendarItem | null } {
    const events = onlyItem(item);
    const ctx = context(item, floatingZone);
    const occurrence =
        recurrenceKey !== null ? expand.occurrenceFor(item, recurrenceKey, floatingZone) : null;
    const base = occurrence?.event ?? events.master;
    if (!base) return { item, split: null };
    let start: DateValue;
    let end: DateValue;
    if (occurrence && !occurrence.overridden) {
        // A generated occurrence: its values are the master's, moved to it.
        start = instantToValue(occurrence.start, base.start, floatingZone, item.timezones);
        end = instantToValue(occurrence.end, base.end, floatingZone, item.timezones);
        if (isDateOnly(base.start) && occurrence.startDate && occurrence.endDate) {
            start = { date: occurrence.startDate };
            end = { date: occurrence.endDate };
        }
    } else {
        start = base.start;
        end = base.end;
    }
    const move = (value: DateValue, ms: number): DateValue => {
        if (isDateOnly(value)) return { date: addDays(value.date, Math.round(ms / 86_400_000)) };
        return instantToValue(
            new Date(valueToInstant(value, ctx.floatingZone, ctx.timezones).getTime() + ms),
            value,
            ctx.floatingZone,
            ctx.timezones
        );
    };
    const nextStart = move(start, startDeltaMs);
    let nextEnd = move(end, endDeltaMs);
    if (isDateOnly(nextStart) && isDateOnly(nextEnd) && nextEnd.date <= nextStart.date)
        nextEnd = { date: addDays(nextStart.date, 1) };
    if (
        !isDateOnly(nextStart) &&
        !isDateOnly(nextEnd) &&
        valueToInstant(nextEnd, floatingZone, item.timezones) <
            valueToInstant(nextStart, floatingZone, item.timezones)
    )
        nextEnd = nextStart;
    return applyEdit(
        item,
        recurrenceKey,
        { ...base, start: nextStart, end: nextEnd },
        scope,
        floatingZone
    );
}

/** A copy of an item under a new UID, everything else kept - extra lines too. */
export function duplicateItem(item: CalendarItem): CalendarItem {
    const uid = newUid();
    if (item.component === "VTODO") return { ...item, uid, todo: { ...item.todo, uid } };
    return {
        ...item,
        uid,
        master: item.master ? { ...item.master, uid } : null,
        overrides: item.overrides.map((event) => ({ ...event, uid }))
    };
}

function withStatus(event: CalendarEvent, email: string, partstat: PartStat): CalendarEvent {
    const address = email
        .trim()
        .toLowerCase()
        .replace(/^mailto:/, "");
    if (!event.attendees.some((attendee) => attendee.email === address)) return event;
    return {
        ...event,
        attendees: event.attendees.map((attendee) =>
            attendee.email === address ? { ...attendee, partstat } : attendee
        )
    };
}

/**
 * Record an attendee's answer. With no key it answers the whole series (the
 * master and every override that lists them); with a key it answers that one
 * occurrence, writing an override for it when there is none. SEQUENCE is not
 * bumped: an answer is not a change to the event.
 */
export function setAttendeeStatus(
    item: CalendarItem,
    email: string,
    partstat: PartStat,
    recurrenceKey: string | null,
    floatingZone = "UTC"
): CalendarItem {
    const events = onlyItem(item);
    if (recurrenceKey === null) {
        return {
            ...events,
            master: events.master ? withStatus(events.master, email, partstat) : null,
            overrides: events.overrides.map((event) => withStatus(event, email, partstat))
        };
    }
    const occurrence = expand.occurrenceFor(item, recurrenceKey, floatingZone);
    if (!occurrence) return item;
    if (occurrence.overridden)
        return {
            ...events,
            overrides: events.overrides.map((event) =>
                event === occurrence.event ? withStatus(event, email, partstat) : event
            )
        };
    if (!events.master || !expand.isRecurring(events.master))
        return {
            ...events,
            master: events.master ? withStatus(events.master, email, partstat) : null
        };
    const ctx = context(item, floatingZone);
    const moved = withStatus(
        {
            ...events.master,
            start: instantToValue(
                occurrence.start,
                events.master.start,
                floatingZone,
                item.timezones
            ),
            end: instantToValue(occurrence.end, events.master.end, floatingZone, item.timezones)
        },
        email,
        partstat
    );
    if (isDateOnly(events.master.start) && occurrence.startDate && occurrence.endDate)
        return editThis(
            events,
            recurrenceKey,
            { ...moved, start: { date: occurrence.startDate }, end: { date: occurrence.endDate } },
            ctx
        );
    return editThis(events, recurrenceKey, moved, ctx);
}
