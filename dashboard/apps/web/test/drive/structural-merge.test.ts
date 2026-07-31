import { describe, expect, it } from "vitest";
import { mergeUnchanged } from "@/lib/structural-merge";

/** A snapshot shaped like the NAS payload, small enough to reason about. */
function snapshot() {
    return {
        totalBytes: 3_600_000_000_000,
        usedBytes: 6_600_000,
        slotsTotal: 7,
        slotsPopulated: 1,
        health: "healthy",
        system: { name: "UNAS-Pro", cpuLoad: 0.03, cpuTemp: 64, uptimeSeconds: 100 },
        disks: [
            { slot: 1, present: true, temperature: 41 },
            { slot: 2, present: false, temperature: null }
        ]
    };
}

describe("folding a fresh reading into the one on screen", () => {
    it("keeps the very same object when nothing moved", () => {
        const previous = snapshot();
        const merged = mergeUnchanged(previous, snapshot());
        expect(merged).toBe(previous);
    });

    it("replaces only the branch that changed", () => {
        const previous = snapshot();
        const next = snapshot();
        next.system.cpuTemp = 66;

        const merged = mergeUnchanged(previous, next);

        expect(merged).not.toBe(previous);
        expect(merged.system).not.toBe(previous.system);
        expect(merged.system.cpuTemp).toBe(66);
        // The bays did not move, so they must not re-render.
        expect(merged.disks).toBe(previous.disks);
    });

    it("keeps the disks that did not change when one of them did", () => {
        const previous = snapshot();
        const next = snapshot();
        next.disks[0]!.temperature = 43;

        const merged = mergeUnchanged(previous, next);

        expect(merged.disks).not.toBe(previous.disks);
        expect(merged.disks[0]).not.toBe(previous.disks[0]);
        expect(merged.disks[0]!.temperature).toBe(43);
        expect(merged.disks[1]).toBe(previous.disks[1]);
        // The rest of the device is untouched.
        expect(merged.system).toBe(previous.system);
    });

    it("takes a new disk without re-creating the existing ones", () => {
        const previous = snapshot();
        const next = { ...snapshot(), disks: [...snapshot().disks, { slot: 3, present: true, temperature: 39 }] };

        const merged = mergeUnchanged(previous, next);

        expect(merged.disks).toHaveLength(3);
        expect(merged.disks[0]).toBe(previous.disks[0]);
        expect(merged.disks[1]).toBe(previous.disks[1]);
        expect(merged.disks[2]!.slot).toBe(3);
    });

    it("notices a removed key rather than reporting no change", () => {
        const previous = { a: 1, b: 2 };
        const merged = mergeUnchanged(previous, { a: 1 } as typeof previous);
        expect(merged).not.toBe(previous);
        expect(merged).toEqual({ a: 1 });
    });

    it("treats null and a missing reading as the values they are", () => {
        expect(mergeUnchanged({ v: null }, { v: null }).v).toBeNull();
        expect(mergeUnchanged({ v: null as number | null }, { v: 3 }).v).toBe(3);
        expect(mergeUnchanged({ v: 3 as number | null }, { v: null }).v).toBeNull();
    });

    it("does not confuse an array with an object of the same entries", () => {
        const merged = mergeUnchanged<unknown>([1, 2], { 0: 1, 1: 2 });
        expect(Array.isArray(merged)).toBe(false);
    });

    it("returns the fresh value when the shape changes entirely", () => {
        expect(mergeUnchanged<unknown>({ a: 1 }, "gone")).toBe("gone");
    });
});
