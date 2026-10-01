/**
 * Seeding and reading helpers shared by the Calendar server tests: people,
 * calendars, shares and stored events in the fake database, the engine's own
 * text for them, and the catalog's words to compare sentences against.
 *
 * Each test file mocks `@polaris/db` and `@polaris/app-host` with the fakes
 * (see fake-db.ts, fake-host.ts) and calls `resetWorld()` before each test.
 */

import { vi } from "vitest";
import { resetHost } from "./fake-host";
import { db, type Row } from "./fake-db";
import * as engine from "@polaris-app/calendar/src/engine";
import { calendarTIn, ruleTIn } from "@polaris-app/calendar/src/lib/i18n";

/** The instant every test starts at: Thursday 1 October 2026, 08:00 UTC. */
export const NOW = new Date("2026-10-01T08:00:00.000Z");

export function resetWorld(at: Date = NOW): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
    db.reset();
    resetHost();
}

/** Let what an action started in the background (a push, a first pull) finish. */
export async function settle(): Promise<void> {
    for (let round = 0; round < 40; round++) await new Promise((resolve) => setImmediate(resolve));
}

/** A sentence from the Calendar's English catalog. */
export function en(key: string, values?: Record<string, unknown>): string {
    return (
        calendarTIn("en-US") as unknown as (key: string, values?: Record<string, unknown>) => string
    )(key, values);
}

/** A sentence from the English recurrence and validation catalog. */
export function enRule(key: string): string {
    return (ruleTIn("en-US") as unknown as (key: string) => string)(key);
}

export function addCalendar(ownerId: string, data: Row = {}): string {
    return db.insert("calendar", { ownerId, name: "Work", ...data }).id as string;
}

export function addShare(
    calendarId: string,
    to: { userId?: string; teamId?: string },
    access: string
): string {
    return db.insert("calendarShare", {
        calendarId,
        userId: to.userId ?? null,
        teamId: to.teamId ?? null,
        access
    }).id as string;
}

/** An event built by the engine, with every field at its default but these. */
export function event(
    fields: Partial<engine.CalendarEvent> & { start: engine.DateValue; end: engine.DateValue }
): engine.CalendarEvent {
    return engine.newEvent(fields);
}

/** A timed value in a zone. */
export function at(dateTime: string, tzid: string | null = "Europe/Madrid"): engine.DateTimeValue {
    return { dateTime, tzid };
}

/** Store an item as a row with the columns derived the way `writeItem` derives them. */
export function storeItem(
    calendarId: string,
    item: engine.CalendarItem,
    extra: Row = {},
    floatingZone = "UTC"
): Row {
    const bounds = engine.itemBounds(item, floatingZone);
    return db.insert("calendarObject", {
        calendarId,
        uid: item.uid,
        component: item.component,
        ics: engine.serializeItem(item),
        summary: bounds.summary,
        location: bounds.location,
        startsAt: bounds.startsAt,
        endsAt: bounds.endsAt,
        allDay: bounds.allDay,
        recurring: bounds.recurring,
        status: bounds.status,
        ...extra
    });
}

export function storeEvent(
    calendarId: string,
    fields: Parameters<typeof event>[0],
    extra: Row = {}
): Row {
    return storeItem(calendarId, engine.eventItem(event(fields)), extra);
}

/** The one item a stored row's text holds. */
export function itemIn(row: Row | undefined): engine.CalendarItem {
    const item = engine.parseCalendarText(String(row?.ics ?? "")).items[0];
    if (!item) throw new Error("the row holds no item");
    return item;
}

/** The master (or first override) of an event row. */
export function eventIn(row: Row | undefined): engine.CalendarEvent {
    const item = itemIn(row);
    if (item.component !== "VEVENT") throw new Error("not an event");
    const found = item.master ?? item.overrides[0];
    if (!found) throw new Error("no event");
    return found;
}

/** What the editor sends for an event, validated by the same schema the action uses. */
export function input(calendarId: string, fields: Record<string, unknown> = {}): engine.EventInput {
    return engine.eventInputSchema.parse({
        calendarId,
        summary: "Planning",
        start: at("2026-10-08T10:00:00"),
        end: at("2026-10-08T11:00:00"),
        allDay: false,
        ...fields
    });
}

/** A weekly rule as the editor sends it. */
export function weekly(
    end: engine.RuleEditorModel["end"] = { kind: "never" }
): engine.RuleEditorModel {
    return {
        frequency: "WEEKLY",
        interval: 1,
        weekdays: [],
        monthlyMode: "day",
        monthDays: [],
        ordinal: 1,
        ordinalDay: "MO",
        months: [],
        end
    };
}

export function objectsIn(calendarId: string): Row[] {
    return db.rows("calendarObject").filter((row) => row.calendarId === calendarId);
}
