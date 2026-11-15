/**
 * The Ports page at hosting scale: the list query is bounded and keyset-paged,
 * and a host can declare several port ranges that may never overlap.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy-service", () => ({ hostPortForApp: () => 0 }));
vi.mock("@/lib/apps/port-block-store", () => ({ getPortRangesFor: vi.fn() }));

import {
    GAME_PORTS_PAGE_DEFAULT,
    GAME_PORTS_PAGE_MAX,
    decodeGamePortsCursor,
    encodeGamePortsCursor,
    gamePortsSearch,
    parseGamePortsQuery
} from "@/lib/apps/game-ports-query";
import { firstFreeRun } from "@/lib/apps/port-registry";
import { overlappingRanges, parseRangesInput, portRangesSchema } from "@/lib/apps/port-block";

const ID = "0190a2b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b";

describe("game ports query", () => {
    it("defaults to the first page of every server by name", () => {
        expect(parseGamePortsQuery(new URLSearchParams())).toEqual({
            q: "",
            status: "all",
            sort: "name",
            limit: GAME_PORTS_PAGE_DEFAULT,
            after: null
        });
    });

    it("never asks the database for more than a page", () => {
        expect(parseGamePortsQuery(new URLSearchParams("limit=100000"))?.limit).toBe(GAME_PORTS_PAGE_DEFAULT);
        expect(parseGamePortsQuery(new URLSearchParams("limit=0"))?.limit).toBe(GAME_PORTS_PAGE_DEFAULT);
        expect(parseGamePortsQuery(new URLSearchParams(`limit=${GAME_PORTS_PAGE_MAX}`))?.limit).toBe(
            GAME_PORTS_PAGE_MAX
        );
    });

    it("falls back on an unknown filter or sort instead of failing the page", () => {
        const query = parseGamePortsQuery(new URLSearchParams("status=nope&sort=drop"));
        expect(query?.status).toBe("all");
        expect(query?.sort).toBe("name");
    });

    it("refuses a search past the limit and a cursor it did not write", () => {
        expect(parseGamePortsQuery(new URLSearchParams({ q: "x".repeat(101) }))).toBeNull();
        expect(parseGamePortsQuery(new URLSearchParams({ after: "not-a-cursor!" }))).toBeNull();
        expect(parseGamePortsQuery(new URLSearchParams({ after: encodeGamePortsCursor({ key: "a", id: "x" }) }))).toBeNull();
    });

    it("round-trips a cursor, names with any character included", () => {
        const cursor = { key: "Servidor ñ ✓ 'one'", id: ID };
        expect(decodeGamePortsCursor(encodeGamePortsCursor(cursor))).toEqual(cursor);
        const query = parseGamePortsQuery(new URLSearchParams({ after: encodeGamePortsCursor(cursor) }));
        expect(query?.after).toEqual(cursor);
    });

    it("refuses a newest-first cursor without a timestamp", () => {
        const after = encodeGamePortsCursor({ key: "Alpha", id: ID });
        expect(parseGamePortsQuery(new URLSearchParams({ sort: "newest", after }))).toBeNull();
        const dated = encodeGamePortsCursor({ key: new Date(0).toISOString(), id: ID });
        expect(parseGamePortsQuery(new URLSearchParams({ sort: "newest", after: dated }))?.after?.id).toBe(ID);
    });

    it("leaves defaults out of the URL", () => {
        expect(gamePortsSearch({ q: "", status: "all", sort: "name", after: null })).toBe("");
        expect(gamePortsSearch({ q: "mc", status: "running", sort: "newest", after: "abc" })).toBe(
            "q=mc&status=running&sort=newest&after=abc"
        );
    });
});

describe("host port ranges", () => {
    it("accepts several ranges, wider than a hundred ports", () => {
        expect(parseRangesInput("25565-25664, 30000-39999\n40000-40000")).toEqual([
            { start: 25565, end: 25664 },
            { start: 30000, end: 39999 },
            { start: 40000, end: 40000 }
        ]);
    });

    it("refuses ranges that share a port, touching ends included", () => {
        expect(parseRangesInput("25565-25664, 25664-25700")).toBeNull();
        expect(parseRangesInput("30000-30100, 25000-30000")).toBeNull();
        expect(overlappingRanges([{ start: 1, end: 5 }, { start: 6, end: 9 }])).toBeNull();
        expect(overlappingRanges([{ start: 10, end: 20 }, { start: 1, end: 10 }])).toEqual([
            { start: 1, end: 10 },
            { start: 10, end: 20 }
        ]);
    });

    it("refuses an empty list, too many ranges, and a range over 80 or 443", () => {
        expect(parseRangesInput("  ")).toBeNull();
        const many = Array.from({ length: 17 }, (_, index) => `${2000 + index * 10}-${2005 + index * 10}`).join(",");
        expect(parseRangesInput(many)).toBeNull();
        expect(parseRangesInput("100-500")).toBeNull();
    });

    it("holds the same rules in the store schema", () => {
        expect(portRangesSchema.safeParse({ tcp: [{ start: 2000, end: 2010 }], udp: [{ start: 3000, end: 3001 }] }).success).toBe(true);
        expect(
            portRangesSchema.safeParse({
                tcp: [
                    { start: 2000, end: 2010 },
                    { start: 2005, end: 2020 }
                ],
                udp: [{ start: 3000, end: 3001 }]
            }).success
        ).toBe(false);
    });

    it("allocates across ranges once the first is full", () => {
        const ranges = [
            { start: 25565, end: 25566 },
            { start: 30000, end: 30010 }
        ];
        const taken = new Set([25565, 25566]);
        expect(firstFreeRun(25565, 1, ranges, (port) => taken.has(port))).toBe(30000);
    });

    it("keeps a run inside one range rather than across a gap", () => {
        const ranges = [
            { start: 2000, end: 2001 },
            { start: 2002, end: 2010 }
        ];
        expect(firstFreeRun(2001, 2, ranges, () => false)).toBe(2000);
        expect(firstFreeRun(2001, 3, ranges, () => false)).toBe(2002);
        expect(firstFreeRun(2000, 20, ranges, () => false)).toBeNull();
    });

    it("honours the preferred port and walks forward from it", () => {
        const ranges = [{ start: 25565, end: 25664 }];
        expect(firstFreeRun(25565, 1, ranges, () => false)).toBe(25565);
        expect(firstFreeRun(25600, 1, ranges, (port) => port === 25600)).toBe(25601);
        expect(firstFreeRun(1, 1, ranges, () => false)).toBe(25565);
    });
});
