/**
 * Between a provider's JSON and iCalendar text, through the calendar engine.
 *
 * Google and Microsoft Graph describe events as JSON; the sync engine stores
 * iCalendar. Rather than write iCalendar by hand here (escaping, folding and
 * date forms are the engine's job, and doing them twice is how they drift), a
 * provider builds the engine's own `CalendarEvent` and lets `serializeItem`
 * write it - and reads a local object back with `parseCalendarText`.
 */

import * as engine from "../../engine";
import { SyncRefusedError } from "./errors";
import type * as types from "../../engine/types";

/** Writable copy of the engine's event, for building one field by field. */
export type EventDraft = { -readonly [K in keyof types.CalendarEvent]: types.CalendarEvent[K] };

/** An event with every field at the engine's default. */
export function blankEvent(uid: string, start: types.DateValue, end: types.DateValue): EventDraft {
    return { ...engine.newEvent({ uid, start, end }) };
}

/** A provider's timestamp as the engine writes CREATED / LAST-MODIFIED, or null. */
export function stampOf(value: string | null | undefined): string | null {
    if (!value) return null;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : `${at.toISOString().slice(0, 19)}Z`;
}

/** An instant as a wall time in `zone` (UTC when the zone is unknown). */
export function wallValue(instant: Date, zone: string | null): types.DateTimeValue {
    const resolved = (zone && engine.resolveZone(zone)) || "UTC";
    return { dateTime: engine.formatWall(engine.instantToWall(instant, resolved)), tzid: resolved };
}

/** The IANA zone a TZID stands for, UTC for a floating time or one nothing resolves. */
export function zoneOrUtc(tzid: string | null): string {
    return (tzid && engine.resolveZone(tzid)) || "UTC";
}

/** Whether a value is all-day. */
export function isDate(value: types.DateValue): value is types.DateOnly {
    return "date" in value;
}

/**
 * The instant a value names. A floating time or a date is read in
 * `floatingZone`; a TZID nothing resolves is read as UTC.
 */
export function toInstant(value: types.DateValue, floatingZone = "UTC"): Date {
    if (isDate(value)) return engine.wallToInstant(engine.parseWall(value.date), floatingZone);
    const zone = value.tzid === null ? floatingZone : (engine.resolveZone(value.tzid) ?? "UTC");
    return engine.wallToInstant(engine.parseWall(value.dateTime), zone);
}

/** A value as `YYYYMMDD` or `YYYYMMDDTHHMMSSZ` (in UTC) - the form provider ids use. */
export function compactUtc(value: types.DateValue, floatingZone = "UTC"): string {
    if (isDate(value)) return value.date.replace(/-/g, "");
    return `${toInstant(value, floatingZone).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

/** An engine item holding a master and its overrides. */
export function eventItem(uid: string, master: types.CalendarEvent | null, overrides: readonly types.CalendarEvent[]): types.CalendarItem {
    return { component: "VEVENT", uid, master, overrides, timezones: [], method: null };
}

/** The item written as a whole VCALENDAR. */
export function writeItem(item: types.CalendarItem): string {
    return engine.serializeItem(item, {});
}

/** The event item in an object's text; a provider that only knows events refuses a task. */
export function readEventItem(ics: string, uid: string): Extract<types.CalendarItem, { component: "VEVENT" }> {
    const { items } = engine.parseCalendarText(ics);
    const item = items.find((candidate) => candidate.uid === uid) ?? items[0];
    if (!item) throw new SyncRefusedError("The object has no event in it", null);
    if (item.component !== "VEVENT") throw new SyncRefusedError("This calendar only holds events", null);
    return item;
}

/** Unfolds iCalendar text into content lines. */
function contentLines(text: string): string[] {
    return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n").filter(Boolean);
}

/**
 * The recurrence of a provider's `RRULE:` / `EXDATE:` / `RDATE:` lines, read by
 * the engine's own parser against the series start, so every date form
 * (`VALUE=DATE`, `TZID=`, UTC) is read one way everywhere.
 */
export function readRecurrence(lines: readonly string[], start: types.DateValue): Pick<types.CalendarEvent, "rule" | "exdates" | "rdates"> {
    const probe = eventItem("recurrence-probe", { ...blankEvent("recurrence-probe", start, start) }, []);
    const text = writeItem(probe);
    const kept = lines.map((line) => line.trim()).filter((line) => /^(RRULE|EXDATE|RDATE)[;:]/i.test(line));
    const withRecurrence = text.replace(/END:VEVENT/, `${kept.join("\r\n")}\r\nEND:VEVENT`);
    const parsed = engine.parseCalendarText(withRecurrence).items[0];
    const master = parsed && parsed.component === "VEVENT" ? parsed.master : null;
    return { rule: master?.rule ?? null, exdates: master?.exdates ?? [], rdates: master?.rdates ?? [] };
}

/** The `RRULE` / `EXDATE` / `RDATE` lines the engine writes for an event, unfolded. */
export function recurrenceLines(event: types.CalendarEvent): string[] {
    if (!event.rule && event.exdates.length === 0 && event.rdates.length === 0) return [];
    const bare: EventDraft = { ...blankEvent(event.uid, event.start, event.end), rule: event.rule, exdates: event.exdates, rdates: event.rdates };
    // Only the event's own lines: the VTIMEZONE blocks in the same file carry
    // RRULE and RDATE lines of their own, which describe the zone, not the event.
    const lines = contentLines(writeItem(eventItem(event.uid, bare, [])));
    const start = lines.indexOf("BEGIN:VEVENT");
    const end = lines.indexOf("END:VEVENT", start);
    return lines.slice(start, end).filter((line) => /^(RRULE|EXDATE|RDATE)[;:]/.test(line));
}

/** The value of an `X-` property kept in `extra`, or null. */
export function extraValue(event: types.CalendarEvent, name: string): string | null {
    const upper = name.toUpperCase();
    for (const { line } of event.extra) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const head = line.slice(0, colon).split(";")[0]!.toUpperCase();
        if (head === upper) return line.slice(colon + 1);
    }
    return null;
}

/** Strips HTML to readable text, for a DESCRIPTION next to the HTML original. */
export function htmlToText(html: string): string {
    return html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
