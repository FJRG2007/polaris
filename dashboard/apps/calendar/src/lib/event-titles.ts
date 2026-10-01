/**
 * The titles of calendar events, for a calendar link pasted into Chat or a page
 * to show as a named chip. Only what the reader could open themselves: an event
 * in a calendar they read in full, and not a private one they only see as busy.
 * Anything else is simply not named - the chip keeps the pasted address.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { reachableCalendars, reaches } from "./access";
import { tryItemOf } from "./objects";

export async function eventTitles(userId: string, ids: readonly string[]): Promise<Record<string, string>> {
    const wanted = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 50);
    if (wanted.length === 0) return {};
    const reach = await reachableCalendars(userId);
    const rows = await prisma.calendarObject.findMany({
        where: { id: { in: wanted }, deletedAt: null, calendarId: { in: [...reach.keys()] } },
        select: { id: true, calendarId: true, ics: true, summary: true }
    });
    const titles: Record<string, string> = {};
    for (const row of rows) {
        const level = reach.get(row.calendarId) ?? null;
        if (!reaches(level, "read")) continue;
        if (!reaches(level, "write")) {
            const item = tryItemOf(row.ics);
            const event = item?.component === "VEVENT" ? (item.master ?? item.overrides[0]) : null;
            if (event && event.classification !== "PUBLIC") continue;
        }
        if (row.summary) titles[row.id] = row.summary;
    }
    return titles;
}
