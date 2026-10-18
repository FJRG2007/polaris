/**
 * The channels somebody runs, asked of every channel at once.
 *
 * `administeredChannelsWhere` has to give the answer `channelAccess` gives as
 * `mayAdminister`, one channel at a time, or an automation is offered a webhook
 * it will be refused on save - or, worse, one it should never have been shown.
 * So each way in is asserted with the condition `channelAccess` puts on it.
 */

import { describe, expect, it, vi } from "vitest";
import type { AdministeredFacts } from "@/lib/chat/access";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { administeredChannelsWhere } = await import("@/lib/chat/access");

interface Room {
    id: string;
    spaceId: string | null;
    private: boolean;
}

type Clause = Record<string, unknown>;

function inList(value: string | null, test: unknown): boolean {
    const filter = test as { in?: string[]; notIn?: string[]; not?: null };
    if (filter.in) return value !== null && filter.in.includes(value);
    if (filter.notIn) return value !== null && !filter.notIn.includes(value);
    if ("not" in filter) return value !== null;
    return value === test;
}

/** The part of Prisma's where language the clause is written in. */
function matches(room: Room, where: Clause): boolean {
    return Object.entries(where).every(([key, test]) => {
        if (key === "OR") return (test as Clause[]).some((clause) => matches(room, clause));
        if (key === "private") return room.private === test;
        if (key === "id") return inList(room.id, test);
        if (key === "spaceId") return inList(room.spaceId, test);
        throw new Error(`unexpected key ${key}`);
    });
}

function run(rooms: Room[], facts: Partial<AdministeredFacts>): string[] {
    const where = administeredChannelsWhere({
        reachable: new Set(),
        adminSpaces: [],
        rooms: new Map(),
        grantedRooms: new Map(),
        ...facts
    });
    return where ? rooms.filter((room) => matches(room, where)).map((room) => room.id) : [];
}

const OPEN: Room = { id: "open", spaceId: "s1", private: false };
const SHUT: Room = { id: "shut", spaceId: "s1", private: true };
const ELSEWHERE: Room = { id: "elsewhere", spaceId: "s2", private: false };
const DIRECT: Room = { id: "direct", spaceId: null, private: true };

describe("the channels somebody runs", () => {
    it("is nothing, and no query, for somebody who runs nothing", () => {
        expect(
            administeredChannelsWhere({
                reachable: new Set(["s1"]),
                adminSpaces: [],
                rooms: new Map([["open", "member"]]),
                grantedRooms: new Map([["open", "member"]])
            })
        ).toBeNull();
    });

    it("is a space's open rooms for whoever runs the space, not its private ones", () => {
        const rooms = [OPEN, SHUT, ELSEWHERE];
        expect(run(rooms, { reachable: new Set(["s1"]), adminSpaces: ["s1"] })).toEqual(["open"]);
    });

    it("adds a private room they were let into, by a row or by a grant", () => {
        const facts = { reachable: new Set(["s1"]), adminSpaces: ["s1"] };
        expect(run([SHUT], { ...facts, rooms: new Map([["shut", "member"]]) })).toEqual(["shut"]);
        expect(run([SHUT], { ...facts, grantedRooms: new Map([["shut", "member"]]) })).toEqual([
            "shut"
        ]);
    });

    it("counts an administrator's row only while the room is still reachable", () => {
        const rooms = new Map([["elsewhere", "admin"]]);
        expect(run([ELSEWHERE], { reachable: new Set(["s2"]), rooms })).toEqual(["elsewhere"]);
        expect(run([ELSEWHERE], { rooms })).toEqual([]);
        expect(
            run([ELSEWHERE], { rooms, grantedRooms: new Map([["elsewhere", "member"]]) })
        ).toEqual(["elsewhere"]);
    });

    it("never counts a member's row", () => {
        expect(
            run([OPEN], { reachable: new Set(["s1"]), rooms: new Map([["open", "member"]]) })
        ).toEqual([]);
    });

    it("counts a grant of the room where channelAccess asks it", () => {
        const grantedRooms = new Map([
            ["open", "admin"],
            ["shut", "admin"],
            ["elsewhere", "admin"]
        ]);
        // s1 is theirs, so the open room's grant is never asked; the private one
        // is, since they have no row in it; s2 is out of reach, so its room is.
        expect(run([OPEN, SHUT, ELSEWHERE], { reachable: new Set(["s1"]), grantedRooms })).toEqual([
            "shut",
            "elsewhere"
        ]);
        expect(
            run([SHUT], {
                reachable: new Set(["s1"]),
                rooms: new Map([["shut", "member"]]),
                grantedRooms
            })
        ).toEqual([]);
        expect(
            run([OPEN], { reachable: new Set(["s1"]), grantedRooms: new Map([["open", "member"]]) })
        ).toEqual([]);
    });

    it("never offers a direct message or a group", () => {
        expect(
            run([DIRECT], {
                rooms: new Map([["direct", "admin"]]),
                grantedRooms: new Map([["direct", "admin"]])
            })
        ).toEqual([]);
    });
});
