"use server";

/** Importing a calendar file. Exports are downloads (routes/api/calendar/export). */

import { z } from "zod";
import { importCalendar } from "../lib/transfer";
import { requireCalendarUser } from "../lib/access";
import { importInputSchema, isKnownZone } from "../lib/schemas";
import { invalid, outcome, type Outcome } from "../lib/outcome";

const input = importInputSchema.extend({
    zone: z.string().max(64).refine(isKnownZone).default("UTC")
});

export async function importCalendarAction(
    raw: unknown
): Promise<Outcome<{ calendarId: string; imported: number; skipped: number; problems: string[] }>> {
    const parsed = input.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const result = await importCalendar(await requireCalendarUser(), {
            target: parsed.data.target,
            text: parsed.data.text,
            floatingZone: parsed.data.zone
        });
        return { ...result, problems: [...result.problems] };
    });
}
