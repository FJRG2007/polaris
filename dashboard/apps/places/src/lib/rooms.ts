/**
 * The rooms at a place, and which floor each is on.
 *
 * A room is what lets an automation be built by where a device is - "the
 * kitchen", "everything upstairs" - rather than by its name. The floor is the
 * room's own word rather than a table of its own: a house names its floors once,
 * and the screen offers the names already used. Deleting a room leaves its
 * devices at the place, in no room.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "./home-error";
import type { RoomView } from "./room-kinds";

export type { RoomView } from "./room-kinds";

const ROOM_FIELDS = { id: true, placeId: true, name: true, floor: true } as const;

function toView(row: {
    id: string;
    placeId: string;
    name: string;
    floor: string | null;
}): RoomView {
    return { id: row.id, placeId: row.placeId, name: row.name, floor: row.floor ?? "" };
}

/** A place's rooms, by floor and then by name. Bounded by what one house has. */
export async function listRooms(installedAppId: string, placeId: string): Promise<RoomView[]> {
    const rows = await prisma.placeRoom.findMany({
        where: { installedAppId, placeId },
        orderBy: [{ floor: "asc" }, { name: "asc" }],
        select: ROOM_FIELDS,
        take: 500
    });
    return rows.map(toView);
}

export interface RoomInput {
    readonly placeId: string;
    readonly name: string;
    readonly floor: string;
}

export async function createRoom(installedAppId: string, input: RoomInput): Promise<RoomView> {
    const place = await prisma.place.findFirst({
        where: { id: input.placeId, installedAppId },
        select: { id: true }
    });
    if (!place) throw new HomeError("Place not found");
    const row = await prisma.placeRoom.create({
        data: {
            installedAppId,
            placeId: place.id,
            name: input.name,
            floor: input.floor || null
        },
        select: ROOM_FIELDS
    });
    return toView(row);
}

/** A room's name and floor. It stays at the place it was made at. */
export async function updateRoom(
    installedAppId: string,
    id: string,
    input: Pick<RoomInput, "name" | "floor">
): Promise<RoomView> {
    await requireRoom(installedAppId, id);
    const row = await prisma.placeRoom.update({
        where: { id },
        data: { name: input.name, floor: input.floor || null },
        select: ROOM_FIELDS
    });
    return toView(row);
}

/** Remove a room. Its devices stay where they are, in no room. */
export async function deleteRoom(installedAppId: string, id: string): Promise<void> {
    await requireRoom(installedAppId, id);
    await prisma.placeRoom.delete({ where: { id } });
}

/** A room of this install's, refusing rather than answering when it is not. */
export async function requireRoom(installedAppId: string, id: string): Promise<RoomView> {
    const row = await prisma.placeRoom.findFirst({
        where: { id, installedAppId },
        select: ROOM_FIELDS
    });
    if (!row) throw new HomeError("Room not found");
    return toView(row);
}
