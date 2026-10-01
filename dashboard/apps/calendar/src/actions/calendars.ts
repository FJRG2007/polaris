"use server";

/**
 * The calendar list: create, change, show or hide, reorder, put in the trash,
 * or leave one somebody shared. Each validates what it was sent before anything
 * runs and answers `{ ok, error }` rather than throwing at the screen.
 */

import { z } from "zod";
import * as calendars from "../lib/calendars";
import * as schemas from "../lib/schemas";
import { requireCalendarUser } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";
import type { CalendarSummary } from "../lib/wire";

/** Every calendar the signed-in person reaches, in their order. */
export async function listCalendarsAction(): Promise<Outcome<{ calendars: CalendarSummary[] }>> {
    return outcome(async () => ({
        calendars: await calendars.listCalendars(await requireCalendarUser())
    }));
}

export async function createCalendarAction(
    input: unknown
): Promise<Outcome<{ calendar: CalendarSummary }>> {
    const parsed = schemas.calendarInputSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        const id = await calendars.createCalendar(user, parsed.data);
        return { calendar: await calendars.calendarSummary(user, id) };
    });
}

export async function updateCalendarAction(
    id: unknown,
    patch: unknown
): Promise<Outcome<{ calendar: CalendarSummary }>> {
    const calendarId = schemas.uuidSchema.safeParse(id);
    const parsed = schemas.calendarPatchSchema.safeParse(patch);
    if (!calendarId.success) return invalid(calendarId.error.issues);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        await calendars.updateCalendar(user, calendarId.data, parsed.data);
        return { calendar: await calendars.calendarSummary(user, calendarId.data) };
    });
}

export async function setDisplayAction(id: unknown, patch: unknown): Promise<Outcome<object>> {
    const calendarId = schemas.uuidSchema.safeParse(id);
    const parsed = schemas.displayPatchSchema.safeParse(patch);
    if (!calendarId.success) return invalid(calendarId.error.issues);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await calendars.setDisplay(await requireCalendarUser(), calendarId.data, parsed.data);
        return {};
    });
}

export async function reorderCalendarsAction(ids: unknown): Promise<Outcome<object>> {
    const parsed = z.array(schemas.uuidSchema).max(500).safeParse(ids);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await calendars.reorderCalendars(await requireCalendarUser(), parsed.data);
        return {};
    });
}

/** Put a calendar of one's own in the trash. */
export async function trashCalendarAction(id: unknown): Promise<Outcome<object>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await calendars.trashCalendar(await requireCalendarUser(), parsed.data);
        return {};
    });
}

/** Take a calendar somebody shared out of one's own list. */
export async function leaveCalendarAction(id: unknown): Promise<Outcome<object>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await calendars.leaveCalendar(await requireCalendarUser(), parsed.data);
        return {};
    });
}
