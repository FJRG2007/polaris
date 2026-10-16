/**
 * A room as a screen sees it, and how a list of them reads: grouped by floor,
 * the floors in the order their names sort, a room on no floor last. Pure, so
 * the browser and the server read rooms alike.
 */

/** A room at a place. `floor` is empty where none was said. */
export interface RoomView {
    readonly id: string;
    readonly placeId: string;
    readonly name: string;
    readonly floor: string;
}

/** Rooms by floor: each floor's name with its rooms by name, the unsaid floor last. */
export function roomsByFloor(rooms: readonly RoomView[]): { floor: string; rooms: RoomView[] }[] {
    const floors = new Map<string, RoomView[]>();
    for (const room of rooms) {
        const list = floors.get(room.floor) ?? [];
        list.push(room);
        floors.set(room.floor, list);
    }
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    return [...floors.entries()]
        .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : byName(a, b)))
        .map(([floor, list]) => ({
            floor,
            rooms: [...list].sort((a, b) => byName(a.name, b.name))
        }));
}

/** The floor names already used at a place, to offer when naming another room's. */
export function floorNames(rooms: readonly RoomView[]): string[] {
    return [...new Set(rooms.map((room) => room.floor).filter((floor) => floor.length > 0))].sort(
        (a, b) => a.localeCompare(b, undefined, { numeric: true })
    );
}
