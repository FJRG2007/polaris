"use server";

/** Free/busy for the find-a-time grid and a person's card. Busy intervals
 *  only, and only for people the reader may look up (see lib/freebusy.ts). */

import { z } from "zod";
import * as schemas from "../lib/schemas";
import * as freebusy from "../lib/freebusy";
import { requireCalendarUser } from "../lib/access";
import { outcome, type Outcome } from "../lib/outcome";
import { refusedInput } from "../lib/scheduling-guard";
import type { FreeBusyView } from "../lib/scheduling-wire";
import { freeBusyRequestSchema, requiredZoneSchema } from "../lib/scheduling-schemas";

export async function freeBusyAction(input: unknown): Promise<Outcome<{ view: FreeBusyView }>> {
    const parsed = freeBusyRequestSchema.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({
        view: await freebusy.freeBusy(await requireCalendarUser(), {
            ...parsed.data,
            from: new Date(parsed.data.from),
            to: new Date(parsed.data.to)
        })
    }));
}

const nowInput = z.object({ userId: schemas.uuidSchema, zone: requiredZoneSchema });

export async function availabilityNowAction(
    input: unknown
): Promise<Outcome<{ status: "free" | "busy" | "away" | "unavailable"; until: string | null }>> {
    const parsed = nowInput.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => freebusy.availabilityNow(await requireCalendarUser(), parsed.data.userId, parsed.data.zone));
}
