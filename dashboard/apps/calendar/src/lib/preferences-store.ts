/**
 * Where one person's calendar settings are kept.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { readPreferences, type CalendarPreferences, type PreferencesPatch } from "./preferences";

export async function loadPreferences(userId: string): Promise<CalendarPreferences> {
    const row = await prisma.calendarPreference.findUnique({ where: { userId }, select: { value: true } });
    return readPreferences(row?.value);
}

/** Apply a change and answer the whole settings as they now read. A change that
 *  leaves every value as it was writes nothing. */
export async function savePreferences(userId: string, patch: PreferencesPatch): Promise<CalendarPreferences> {
    const current = await loadPreferences(userId);
    const next = { ...current, ...patch } as CalendarPreferences;
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    const value = JSON.stringify(next);
    await prisma.calendarPreference.upsert({
        where: { userId },
        create: { userId, value },
        update: { value }
    });
    return next;
}
