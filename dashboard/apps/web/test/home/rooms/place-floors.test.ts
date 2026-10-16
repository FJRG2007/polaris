/**
 * Floors as rows of their own: a room put on a floor by name makes it once, a
 * floor renamed carries every room on it, a floor deleted leaves its rooms on
 * none, and a room written before floors were rows still reads its floor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Floor {
    id: string;
    installedAppId: string;
    placeId: string;
    name: string;
}

interface Room {
    id: string;
    installedAppId: string;
    placeId: string;
    name: string;
    floor: string | null;
    floorId: string | null;
}

const db = vi.hoisted(() => ({ floors: [] as Floor[], rooms: [] as Room[], next: 0 }));

vi.mock("@polaris/db", () => {
    function roomRow(room: Room) {
        const floor = db.floors.find((each) => each.id === room.floorId);
        return { ...room, placeFloor: floor ? { name: floor.name } : null };
    }
    function floorRow(floor: Floor) {
        return { id: floor.id, placeId: floor.placeId, name: floor.name };
    }
    function matches(row: object, where: Record<string, unknown>): boolean {
        return Object.entries(where).every(([key, value]) => {
            const field = (row as Record<string, unknown>)[key];
            if (value && typeof value === "object" && "not" in value)
                return field !== (value as { not: unknown }).not;
            return field === value;
        });
    }
    return {
        prisma: {
            place: {
                findFirst: async ({ where }: { where: { id: string } }) =>
                    where.id.startsWith("place-") ? { id: where.id } : null
            },
            placeFloor: {
                findMany: async ({ where }: { where: Record<string, unknown> }) =>
                    db.floors.filter((each) => matches(each, where)).map(floorRow),
                findFirst: async ({ where }: { where: Record<string, unknown> }) => {
                    const found = db.floors.find((each) => matches(each, where));
                    return found ? floorRow(found) : null;
                },
                upsert: async (args: {
                    where: { placeId_name: { placeId: string; name: string } };
                    create: Omit<Floor, "id">;
                }) => {
                    const key = args.where.placeId_name;
                    let found = db.floors.find(
                        (each) => each.placeId === key.placeId && each.name === key.name
                    );
                    if (!found) {
                        found = { id: `floor-${++db.next}`, ...args.create };
                        db.floors.push(found);
                    }
                    return { id: found.id, name: found.name };
                },
                create: async ({ data }: { data: Omit<Floor, "id"> }) => {
                    const floor = { id: `floor-${++db.next}`, ...data };
                    db.floors.push(floor);
                    return floorRow(floor);
                },
                update: async ({
                    where,
                    data
                }: {
                    where: { id: string };
                    data: { name: string };
                }) => {
                    const floor = db.floors.find((each) => each.id === where.id)!;
                    floor.name = data.name;
                    return floorRow(floor);
                },
                delete: async ({ where }: { where: { id: string } }) => {
                    db.floors = db.floors.filter((each) => each.id !== where.id);
                }
            },
            placeRoom: {
                create: async ({ data }: { data: Omit<Room, "id"> }) => {
                    const room = { id: `room-${++db.next}`, ...data };
                    db.rooms.push(room);
                    return roomRow(room);
                },
                update: async ({ where, data }: { where: { id: string }; data: Partial<Room> }) => {
                    const room = db.rooms.find((each) => each.id === where.id)!;
                    Object.assign(room, data);
                    return roomRow(room);
                },
                updateMany: async ({
                    where,
                    data
                }: {
                    where: Record<string, unknown>;
                    data: Partial<Room>;
                }) => {
                    for (const room of db.rooms.filter((each) => matches(each, where)))
                        Object.assign(room, data);
                },
                findFirst: async ({ where }: { where: Record<string, unknown> }) => {
                    const found = db.rooms.find((each) => matches(each, where));
                    return found ? roomRow(found) : null;
                },
                findMany: async ({ where }: { where: Record<string, unknown> }) =>
                    db.rooms.filter((each) => matches(each, where)).map(roomRow)
            },
            $transaction: async (steps: Promise<unknown>[]) => Promise.all(steps)
        }
    };
});

const rooms = await import("@polaris-app/places/src/lib/rooms");

const APP = "app-1";

beforeEach(() => {
    db.floors = [];
    db.rooms = [];
    db.next = 0;
});

describe("floors at a place", () => {
    it("are made once from the name a room is put on", async () => {
        const kitchen = await rooms.createRoom(APP, {
            placeId: "place-1",
            name: "Kitchen",
            floor: "Ground floor"
        });
        const hall = await rooms.createRoom(APP, {
            placeId: "place-1",
            name: "Hall",
            floor: "Ground floor"
        });
        expect(db.floors).toHaveLength(1);
        expect(kitchen.floorId).toBe(hall.floorId);
        expect(kitchen.floor).toBe("Ground floor");
    });

    it("carry every room on them through a rename", async () => {
        const floor = await rooms.createFloor(APP, { placeId: "place-1", name: "Upstairs" });
        await rooms.createRoom(APP, {
            placeId: "place-1",
            name: "Bedroom",
            floor: "",
            floorId: floor.id
        });
        await rooms.renameFloor(APP, floor.id, "First floor");
        const [bedroom] = await rooms.listRooms(APP, "place-1");
        expect(bedroom.floor).toBe("First floor");
        expect(db.rooms[0].floor).toBe("First floor");
    });

    it("refuse a second floor of the same name at a place", async () => {
        await rooms.createFloor(APP, { placeId: "place-1", name: "Attic" });
        await expect(rooms.createFloor(APP, { placeId: "place-1", name: "Attic" })).rejects.toThrow(
            "A floor with that name is already here"
        );
        const other = await rooms.createFloor(APP, { placeId: "place-1", name: "Cellar" });
        await expect(rooms.renameFloor(APP, other.id, "Attic")).rejects.toThrow(
            "A floor with that name is already here"
        );
    });

    it("leave their rooms on none when deleted", async () => {
        const floor = await rooms.createFloor(APP, { placeId: "place-1", name: "Loft" });
        await rooms.createRoom(APP, {
            placeId: "place-1",
            name: "Study",
            floor: "",
            floorId: floor.id
        });
        await rooms.deleteFloor(APP, floor.id);
        const [study] = await rooms.listRooms(APP, "place-1");
        expect(study).toMatchObject({ name: "Study", floor: "", floorId: "" });
    });

    it("refuse a floor from another place", async () => {
        const floor = await rooms.createFloor(APP, { placeId: "place-2", name: "Ground" });
        await expect(
            rooms.createRoom(APP, { placeId: "place-1", name: "Den", floor: "", floorId: floor.id })
        ).rejects.toThrow("That floor is at another place");
    });

    it("read a room written before floors were rows by its own floor name", async () => {
        db.rooms.push({
            id: "old",
            installedAppId: APP,
            placeId: "place-1",
            name: "Garage",
            floor: "Basement",
            floorId: null
        });
        expect(await rooms.requireRoom(APP, "old")).toMatchObject({
            floor: "Basement",
            floorId: ""
        });
    });
});
