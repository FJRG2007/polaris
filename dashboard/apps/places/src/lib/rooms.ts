/**
 * The rooms at a place, and the floors they are on.
 *
 * A room is what lets an automation be built by where a device is - "the
 * kitchen", "everything upstairs" - rather than by its name. A floor is a row
 * of its own, so it can be made before any room is on it and renamed once for
 * all of them; each room also keeps its floor's name beside the link, as rooms
 * did before floors were rows, so a reader of the name alone still reads the
 * right one. Deleting a room leaves its devices at the place, in no room;
 * deleting a floor leaves its rooms at the place, on none.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "./home-error";
import type { FloorView, RoomView } from "./room-kinds";

export type { FloorView, RoomView } from "./room-kinds";

const ROOM_FIELDS = {
    id: true,
    placeId: true,
    name: true,
    floor: true,
    floorId: true,
    placeFloor: { select: { name: true } }
} as const;

const FLOOR_FIELDS = { id: true, placeId: true, name: true } as const;

function toView(row: {
    id: string;
    placeId: string;
    name: string;
    floor: string | null;
    floorId: string | null;
    placeFloor: { name: string } | null;
}): RoomView {
    return {
        id: row.id,
        placeId: row.placeId,
        name: row.name,
        // The linked floor's name wins over the room's copy of it, which a
        // build from before floors were rows may have written alone.
        floor: row.placeFloor?.name ?? row.floor ?? "",
        floorId: row.floorId ?? ""
    };
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

/** A place's floors, by name. */
export async function listFloors(installedAppId: string, placeId: string): Promise<FloorView[]> {
    return prisma.placeFloor.findMany({
        where: { installedAppId, placeId },
        orderBy: { name: "asc" },
        select: FLOOR_FIELDS,
        take: 100
    });
}

export interface RoomInput {
    readonly placeId: string;
    readonly name: string;
    /** The floor's name, made at the place when it is not there yet. Empty is none. */
    readonly floor: string;
    /** The floor by its id, where the screen picked one; wins over `floor`.
     *  Empty is none. */
    readonly floorId?: string;
}

/** The floor a room is to be on, by id or by name, at the room's place. */
async function floorFor(
    installedAppId: string,
    placeId: string,
    input: Pick<RoomInput, "floor" | "floorId">
): Promise<{ id: string; name: string } | null> {
    if (input.floorId !== undefined) {
        if (!input.floorId) return null;
        const floor = await requireFloor(installedAppId, input.floorId);
        if (floor.placeId !== placeId) throw new HomeError("That floor is at another place");
        return floor;
    }
    if (!input.floor) return null;
    return prisma.placeFloor.upsert({
        where: { placeId_name: { placeId, name: input.floor } },
        create: { installedAppId, placeId, name: input.floor },
        update: {},
        select: { id: true, name: true }
    });
}

export async function createRoom(installedAppId: string, input: RoomInput): Promise<RoomView> {
    const place = await prisma.place.findFirst({
        where: { id: input.placeId, installedAppId },
        select: { id: true }
    });
    if (!place) throw new HomeError("Place not found");
    const floor = await floorFor(installedAppId, place.id, input);
    const row = await prisma.placeRoom.create({
        data: {
            installedAppId,
            placeId: place.id,
            name: input.name,
            floor: floor?.name ?? null,
            floorId: floor?.id ?? null
        },
        select: ROOM_FIELDS
    });
    return toView(row);
}

/** A room's name and floor. It stays at the place it was made at. */
export async function updateRoom(
    installedAppId: string,
    id: string,
    input: Pick<RoomInput, "name" | "floor" | "floorId">
): Promise<RoomView> {
    const room = await requireRoom(installedAppId, id);
    const floor = await floorFor(installedAppId, room.placeId, input);
    const row = await prisma.placeRoom.update({
        where: { id },
        data: { name: input.name, floor: floor?.name ?? null, floorId: floor?.id ?? null },
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

/** A floor of this install's, refusing rather than answering when it is not. */
export async function requireFloor(installedAppId: string, id: string): Promise<FloorView> {
    const row = await prisma.placeFloor.findFirst({
        where: { id, installedAppId },
        select: FLOOR_FIELDS
    });
    if (!row) throw new HomeError("Floor not found");
    return row;
}

/** Whether another floor at the place already has this name. */
async function nameTaken(placeId: string, name: string, except?: string): Promise<boolean> {
    const found = await prisma.placeFloor.findFirst({
        where: { placeId, name, ...(except ? { id: { not: except } } : {}) },
        select: { id: true }
    });
    return found !== null;
}

export async function createFloor(
    installedAppId: string,
    input: { placeId: string; name: string }
): Promise<FloorView> {
    const place = await prisma.place.findFirst({
        where: { id: input.placeId, installedAppId },
        select: { id: true }
    });
    if (!place) throw new HomeError("Place not found");
    if (await nameTaken(place.id, input.name))
        throw new HomeError("A floor with that name is already here");
    return prisma.placeFloor.create({
        data: { installedAppId, placeId: place.id, name: input.name },
        select: FLOOR_FIELDS
    });
}

/** A floor's new name, and every room on it with it. */
export async function renameFloor(
    installedAppId: string,
    id: string,
    name: string
): Promise<FloorView> {
    const floor = await requireFloor(installedAppId, id);
    if (await nameTaken(floor.placeId, name, id))
        throw new HomeError("A floor with that name is already here");
    const [renamed] = await prisma.$transaction([
        prisma.placeFloor.update({ where: { id }, data: { name }, select: FLOOR_FIELDS }),
        prisma.placeRoom.updateMany({ where: { floorId: id }, data: { floor: name } })
    ]);
    return renamed;
}

/** Remove a floor. Its rooms stay at the place, on none. */
export async function deleteFloor(installedAppId: string, id: string): Promise<void> {
    await requireFloor(installedAppId, id);
    await prisma.$transaction([
        prisma.placeRoom.updateMany({
            where: { floorId: id },
            data: { floor: null, floorId: null }
        }),
        prisma.placeFloor.delete({ where: { id } })
    ]);
}
