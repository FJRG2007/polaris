"use server";

/**
 * Events: open one, save it (new, this occurrence, this and following, the
 * whole series), drag or resize it, delete it, copy it, answer it. Every input
 * is validated here against the same schema the editor validates with.
 */

import { z } from "zod";
import * as engine from "../engine";
import * as objects from "../lib/objects";
import * as detail from "../lib/event-detail";
import { addressesOf } from "../lib/occurrences";
import { requireCalendarUser } from "../lib/access";
import { isKnownZone, uuidSchema } from "../lib/schemas";
import type { EventDetail, TodoDetail } from "../lib/wire";
import { invalid, outcome, type Outcome } from "../lib/outcome";

const zone = z.string().max(64).refine(isKnownZone);
const scope = z.enum(["this", "following", "all"]);
const recurrenceKey = z.string().min(8).max(40).nullable();
const version = z.string().datetime().nullable();

const openInput = z.object({ objectId: uuidSchema, recurrenceKey, zone });

export async function openEventAction(input: unknown): Promise<Outcome<{ detail: EventDetail }>> {
    const parsed = openInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        return {
            detail: await detail.eventDetail(user, {
                objectId: parsed.data.objectId,
                recurrenceKey: parsed.data.recurrenceKey,
                floatingZone: parsed.data.zone,
                emails: await addressesOf(user)
            })
        };
    });
}

export async function openTodoAction(objectId: unknown): Promise<Outcome<{ detail: TodoDetail }>> {
    const parsed = uuidSchema.safeParse(objectId);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({
        detail: await detail.todoDetail(await requireCalendarUser(), parsed.data)
    }));
}

const saveInput = z.object({
    objectId: uuidSchema.nullable(),
    recurrenceKey,
    scope,
    version,
    zone,
    event: engine.eventInputSchema
});

/** Create an event, or change one - the scope says which occurrences. */
export async function saveEventAction(input: unknown): Promise<Outcome<{ objectId: string }>> {
    const parsed = saveInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () =>
        objects.saveEvent(await requireCalendarUser(), {
            objectId: parsed.data.objectId,
            recurrenceKey: parsed.data.recurrenceKey,
            scope: parsed.data.scope,
            version: parsed.data.version,
            event: parsed.data.event,
            floatingZone: parsed.data.zone
        })
    );
}

/** A day is the most a drag moves anything by more than a year. */
const delta = z
    .number()
    .int()
    .min(-366 * 86_400_000)
    .max(366 * 86_400_000);

const shiftInput = z.object({
    objectId: uuidSchema,
    recurrenceKey,
    startDeltaMs: delta,
    endDeltaMs: delta,
    scope,
    version,
    zone
});

/** Drag or resize. */
export async function shiftEventAction(input: unknown): Promise<Outcome<object>> {
    const parsed = shiftInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await objects.shiftEvent(await requireCalendarUser(), {
            objectId: parsed.data.objectId,
            recurrenceKey: parsed.data.recurrenceKey,
            startDeltaMs: parsed.data.startDeltaMs,
            endDeltaMs: parsed.data.endDeltaMs,
            scope: parsed.data.scope,
            version: parsed.data.version,
            floatingZone: parsed.data.zone
        });
        return {};
    });
}

const deleteInput = z.object({ objectId: uuidSchema, recurrenceKey, scope, zone });

export async function deleteEventAction(input: unknown): Promise<Outcome<object>> {
    const parsed = deleteInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        await objects.deleteEvent(await requireCalendarUser(), {
            objectId: parsed.data.objectId,
            recurrenceKey: parsed.data.recurrenceKey,
            scope: parsed.data.scope,
            floatingZone: parsed.data.zone
        });
        return {};
    });
}

export async function duplicateEventAction(input: unknown): Promise<Outcome<{ objectId: string }>> {
    const parsed = z.object({ objectId: uuidSchema, zone }).safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => ({
        objectId: await objects.duplicateEvent(
            await requireCalendarUser(),
            parsed.data.objectId,
            parsed.data.zone
        )
    }));
}

const respondInput = z.object({
    objectId: uuidSchema,
    recurrenceKey,
    partstat: z.enum(["ACCEPTED", "DECLINED", "TENTATIVE"]),
    zone
});

/** Accept, decline or answer maybe - for one occurrence or the series. */
export async function respondToEventAction(input: unknown): Promise<Outcome<object>> {
    const parsed = respondInput.safeParse(input);
    if (!parsed.success) return invalid(parsed.error.issues);
    return outcome(async () => {
        const user = await requireCalendarUser();
        await objects.respondToEvent(user, {
            objectId: parsed.data.objectId,
            recurrenceKey: parsed.data.recurrenceKey,
            partstat: parsed.data.partstat,
            emails: await addressesOf(user),
            floatingZone: parsed.data.zone
        });
        return {};
    });
}
