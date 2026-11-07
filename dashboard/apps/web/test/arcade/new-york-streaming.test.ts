// New York keeps the instanced building detail near the camera by diffing which blocks entered or left the radius,
// so a move writes and uploads only those blocks' instances instead of every instance within 560 m.
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain browser module without types
import * as slots from "../../../arcade/game/new-york/engine/instance-slots.js";

type Owner = { id: string; slot: number };

function held(pool: ReturnType<typeof slots.createSlotPool>, id: string): Owner {
    const owner: Owner = { id, slot: -1 };
    owner.slot = pool.add(owner);
    return owner;
}

describe("instance slot pool", () => {
    it("hands out a dense prefix and refuses past capacity", () => {
        const pool = slots.createSlotPool(2);
        expect(held(pool, "a").slot).toBe(0);
        expect(held(pool, "b").slot).toBe(1);
        expect(pool.add({ id: "c" })).toBe(-1);
        expect(pool.count).toBe(2);
    });

    it("fills a freed slot with the last instance and moves its owner along", () => {
        const pool = slots.createSlotPool(4);
        const [a, b, c] = ["a", "b", "c"].map((id) => held(pool, id));
        pool.dirty.clear();
        const from = pool.remove(a.slot);
        expect(from).toBe(2);
        expect(pool.owners[0]).toBe(c);
        pool.owners[0].slot = 0;
        expect(pool.count).toBe(2);
        expect([...pool.dirty]).toEqual([0]);
        expect(b.slot).toBe(1);
    });

    it("removing the last slot copies nothing", () => {
        const pool = slots.createSlotPool(4);
        held(pool, "a");
        const b = held(pool, "b");
        pool.dirty.clear();
        expect(pool.remove(b.slot)).toBe(-1);
        expect(pool.count).toBe(1);
        expect(pool.dirty.size).toBe(0);
    });

    it("keeps owners consistent through a block releasing several of its own instances", () => {
        const pool = slots.createSlotPool(8);
        const mine = [held(pool, "x"), held(pool, "y")];
        const others = [held(pool, "p"), held(pool, "q"), held(pool, "r")];
        for (const owner of mine) {
            const from = pool.remove(owner.slot);
            if (from >= 0) pool.owners[owner.slot].slot = owner.slot;
        }
        expect(pool.count).toBe(3);
        for (let i = 0; i < pool.count; i++) expect(pool.owners[i].slot).toBe(i);
        expect(new Set(pool.owners.slice(0, 3))).toEqual(new Set(others));
    });
});

describe("dirty upload runs", () => {
    it("merges adjacent slots and drops slots past the live count", () => {
        expect(slots.dirtyRuns(new Set([5, 1, 2, 3, 9]), 9)).toEqual([
            { start: 1, count: 3 },
            { start: 5, count: 1 }
        ]);
    });

    it("joins the closest runs when there are too many", () => {
        const runs = slots.dirtyRuns(new Set([0, 10, 12, 30]), 100, 2);
        expect(runs).toEqual([
            { start: 0, count: 13 },
            { start: 30, count: 1 }
        ]);
    });

    it("is empty when nothing changed", () => {
        expect(slots.dirtyRuns(new Set(), 10)).toEqual([]);
    });
});

describe("blocks entering and leaving the radius", () => {
    it("diffs a resident map against the blocks now in range, keeping range order", () => {
        const [a, b, c, d] = [{ n: "a" }, { n: "b" }, { n: "c" }, { n: "d" }];
        const resident = new Map<object, unknown[]>([[a, []], [b, []]]);
        const { entering, leaving } = slots.diffResident(resident, [d, b, c]);
        expect(entering).toEqual([d, c]);
        expect(leaving).toEqual([a]);
    });

    it("an unmoved focus changes nothing", () => {
        const a = { n: "a" };
        const { entering, leaving } = slots.diffResident(new Set([a]), [a]);
        expect(entering).toEqual([]);
        expect(leaving).toEqual([]);
    });

    it("refills blocks a full pool cut short once a leaving block frees slots, closest first", () => {
        const [a, b, c, d] = [{ n: "a" }, { n: "b" }, { n: "c" }, { n: "d" }];
        const resident = new Map<object, unknown[]>([[a, []], [b, []], [c, []]]);
        const { entering, leaving } = slots.diffResident(resident, [b, d, c], new Set([b]));
        expect(leaving).toEqual([a, b]);
        expect(entering).toEqual([b, d]);
    });

    it("leaves a cut-short block alone while nothing frees a slot", () => {
        const [a, b] = [{ n: "a" }, { n: "b" }];
        const { entering, leaving } = slots.diffResident(new Set([a, b]), [a, b], new Set([b]));
        expect(entering).toEqual([]);
        expect(leaving).toEqual([]);
    });
});

describe("per-frame fill budget", () => {
    it("takes queued blocks in order while they fit", () => {
        const queue = [4, 4, 4, 4];
        expect(slots.takeBudget(queue, (n: number) => n, 10)).toEqual([4, 4]);
        expect(queue).toEqual([4, 4]);
    });

    it("always takes one so an oversized block cannot stall the queue", () => {
        const queue = [50, 1];
        expect(slots.takeBudget(queue, (n: number) => n, 10)).toEqual([50]);
        expect(slots.takeBudget(queue, (n: number) => n, 10)).toEqual([1]);
        expect(queue).toEqual([]);
    });
});
