"use server";

/** Rooms and equipment: the administrators' list, and the room picker's
 *  question "which of them are free then". */

import { z } from "zod";
import * as schemas from "../lib/schemas";
import * as resources from "../lib/resources";
import { requireCalendarUser } from "../lib/access";
import { outcome, type Outcome } from "../lib/outcome";
import { refusedInput } from "../lib/scheduling-guard";
import { roomInputSchema } from "../lib/scheduling-schemas";
import type { RoomAvailability, RoomView } from "../lib/scheduling-wire";

export async function listRoomsAction(): Promise<Outcome<{ rooms: RoomView[]; canManage: boolean }>> {
    return outcome(async () => {
        const user = await requireCalendarUser();
        return { rooms: await resources.listRooms(), canManage: await resources.mayManageRooms(user) };
    });
}

export async function createRoomAction(input: unknown): Promise<Outcome<{ room: RoomView }>> {
    const parsed = roomInputSchema.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({ room: await resources.createRoom(await requireCalendarUser(), parsed.data) }));
}

export async function updateRoomAction(id: unknown, input: unknown): Promise<Outcome<{ room: RoomView }>> {
    const parsedId = schemas.uuidSchema.safeParse(id);
    if (!parsedId.success) return refusedInput(parsedId.error.issues);
    const parsed = roomInputSchema.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => ({ room: await resources.updateRoom(await requireCalendarUser(), parsedId.data, parsed.data) }));
}

export async function removeRoomAction(id: unknown): Promise<Outcome<object>> {
    const parsed = schemas.uuidSchema.safeParse(id);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => {
        await resources.removeRoom(await requireCalendarUser(), parsed.data);
        return {};
    });
}

const windowInput = z
    .object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) })
    .refine((value) => Date.parse(value.end) > Date.parse(value.start))
    .refine((value) => Date.parse(value.end) - Date.parse(value.start) <= 31 * 86_400_000);

export async function roomsForAction(input: unknown): Promise<Outcome<{ rooms: RoomAvailability[] }>> {
    const parsed = windowInput.safeParse(input);
    if (!parsed.success) return refusedInput(parsed.error.issues);
    return outcome(async () => {
        await requireCalendarUser();
        return { rooms: await resources.roomsFor({ from: new Date(parsed.data.start), to: new Date(parsed.data.end) }) };
    });
}
