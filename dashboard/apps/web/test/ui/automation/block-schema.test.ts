/**
 * The shapes and list operations every automation editor shares: a block's own
 * name, note and switch, lengths of time, thresholds, and copying or moving a
 * block in its list.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";

describe("a block's own fields", () => {
    const node = z.object({ id: z.string(), kind: z.literal("manual"), ...core.blockBaseShape });

    it("reads a block saved before they existed", () => {
        expect(node.parse({ id: "abcd", kind: "manual" })).toEqual({ id: "abcd", kind: "manual" });
    });

    it("keeps a name, a note and the switch through a parse", () => {
        const parsed = node.parse({
            id: "abcd",
            kind: "manual",
            alias: "  Porch  ",
            note: "Only in winter",
            enabled: false
        });
        expect(parsed).toEqual({
            id: "abcd",
            kind: "manual",
            alias: "Porch",
            note: "Only in winter",
            enabled: false
        });
        expect(core.blockEnabled(parsed)).toBe(false);
        expect(core.blockEnabled({})).toBe(true);
    });

    it("refuses a note longer than a row can show", () => {
        const long = "x".repeat(core.BLOCK_LIMITS.note + 1);
        expect(node.safeParse({ id: "abcd", kind: "manual", note: long }).success).toBe(false);
    });

    it("titles a block by its name, else its sentence", () => {
        expect(core.blockTitle({ alias: "Porch" }, "Light turns on")).toBe("Porch");
        expect(core.blockTitle({ alias: "  " }, "Light turns on")).toBe("Light turns on");
    });
});

describe("lengths of time", () => {
    it("says a number of seconds in its largest whole unit", () => {
        expect(core.durationOf(7200)).toEqual({ amount: 2, unit: "hours" });
        expect(core.durationOf(90)).toEqual({ amount: 90, unit: "seconds" });
        expect(core.durationOf(86400 * 3)).toEqual({ amount: 3, unit: "days" });
        expect(core.durationOf(0)).toEqual({ amount: 0, unit: "seconds" });
    });

    it("turns a duration back into seconds", () => {
        expect(core.durationSeconds({ amount: 5, unit: "minutes" })).toBe(300);
    });
});

describe("thresholds", () => {
    it("compares past one value and inside or outside two", () => {
        const above = core.thresholdSchema.parse({ op: "above", than: { value: 10 } });
        expect(core.passesThreshold(11, above)).toBe(true);
        expect(core.passesThreshold(10, above)).toBe(false);
        const between = core.thresholdSchema.parse({
            op: "between",
            low: { value: 18 },
            high: { value: 24 }
        });
        expect(core.passesThreshold(20, between)).toBe(true);
        expect(core.passesThreshold(25, between)).toBe(false);
        const outside = { ...between, op: "outside" as const };
        expect(core.passesThreshold(25, outside)).toBe(true);
    });

    it("never passes on a reference nobody resolved", () => {
        const above = core.thresholdSchema.parse({ op: "above", than: { ref: "sensor-1" } });
        expect(core.passesThreshold(1000, above)).toBe(false);
        expect(core.passesThreshold(5, above, () => 4)).toBe(true);
    });
});

describe("a list of blocks", () => {
    it("copies a block with fresh ids on it and everything inside", () => {
        let n = 0;
        const copy = core.withFreshIds(
            { id: "a", kind: "group", items: [{ id: "b", deviceId: "dev-1" }] },
            () => `new${(n += 1)}`
        );
        expect(copy).toEqual({
            id: "new1",
            kind: "group",
            items: [{ id: "new2", deviceId: "dev-1" }]
        });
    });

    it("puts blocks after one, and at the ends", () => {
        expect(core.insertAfter(["a", "b"], 0, "x")).toEqual(["a", "x", "b"]);
        expect(core.insertAfter(["a", "b"], 9, "x")).toEqual(["a", "b", "x"]);
        expect(core.insertAfter(["a", "b"], -1, "x")).toEqual(["x", "a", "b"]);
    });

    it("moves a block and keeps it inside the list", () => {
        expect(core.moveBy(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
        expect(core.moveBy(["a", "b", "c"], 2, 5)).toEqual(["a", "b", "c"]);
        expect(core.moveBy(["a", "b", "c"], 2, -2)).toEqual(["c", "a", "b"]);
    });
});
