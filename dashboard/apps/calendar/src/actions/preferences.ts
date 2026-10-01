"use server";

/** One person's calendar settings: read them, change some of them. */

import { loadPreferences, savePreferences } from "../lib/preferences-store";
import { preferencesPatchSchema, type CalendarPreferences } from "../lib/preferences";
import { requireCalendarUser } from "../lib/access";
import { invalid, outcome, type Outcome } from "../lib/outcome";

export async function loadPreferencesAction(): Promise<Outcome<{ preferences: CalendarPreferences }>> {
    return outcome(async () => ({ preferences: await loadPreferences((await requireCalendarUser()).id) }));
}

export async function savePreferencesAction(patch: unknown): Promise<Outcome<{ preferences: CalendarPreferences }>> {
    const parsed = preferencesPatchSchema.safeParse(patch);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({
        preferences: await savePreferences((await requireCalendarUser()).id, parsed.data)
    }));
}
