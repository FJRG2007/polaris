/**
 * Sizes typed in the unit the person is thinking in.
 *
 * The settings still store what they always stored - megabytes for an upload
 * limit, bytes for a disk budget - so what is pinned here is the conversion and,
 * more importantly, the two ways a size field can silently be wrong: a value that
 * comes back in a different unit than it went in, and a unit change that
 * reinterprets the number instead of converting it. Both are factor-of-1024
 * mistakes nobody notices until somebody cannot send a file.
 */

import { describe, expect, it } from "vitest";
import { bytesOf, convertSize, readableSize, SIZE_UNITS, unitBytes, unitsFrom } from "@polaris/core";

describe("what a unit is worth", () => {
    it("counts in binary units, which is what the things being limited use", () => {
        expect(unitBytes("B")).toBe(1);
        expect(unitBytes("KB")).toBe(1024);
        expect(unitBytes("MB")).toBe(1024 * 1024);
        expect(unitBytes("GB")).toBe(1024 ** 3);
    });

    it("turns a number and a unit into bytes", () => {
        expect(bytesOf(4, "GB")).toBe(4 * 1024 ** 3);
        expect(bytesOf(0, "GB")).toBe(0);
        expect(bytesOf(Number.NaN, "GB")).toBe(0);
    });

    it("converts between units without going through a string", () => {
        expect(convertSize(4, "GB", "MB")).toBe(4096);
        expect(convertSize(4096, "MB", "GB")).toBe(4);
        expect(convertSize(1536, "MB", "GB")).toBe(1.5);
    });
});

describe("the unit a field opens on", () => {
    it("shows a round number of the biggest unit it is one of", () => {
        expect(readableSize(4096, "MB")).toEqual({ value: 4, unit: "GB" });
        expect(readableSize(25, "MB")).toEqual({ value: 25, unit: "MB" });
        // 1.5 GB typed back is a rounding argument nobody asked for, so it stays
        // in the unit it is exact in.
        expect(readableSize(1536, "MB")).toEqual({ value: 1536, unit: "MB" });
    });

    it("never goes below the unit the setting is stored in", () => {
        // A limit kept in megabytes has no way to express 900 KB, and a field
        // offering it would lose what was typed into it.
        expect(readableSize(1, "MB").unit).toBe("MB");
        expect(unitsFrom("MB")).toEqual(["MB", "GB", "TB"]);
        expect(unitsFrom("B")).toEqual([...SIZE_UNITS]);
    });

    it("leaves nought alone, since nought is the same in every unit", () => {
        expect(readableSize(0, "B")).toEqual({ value: 0, unit: "B" });
    });

    it("survives the round trip a field makes of it", () => {
        for (const stored of ["B", "MB"] as const) {
            for (const value of [1, 25, 1024, 4096, 1024 ** 2]) {
                const shown = readableSize(value, stored);
                expect(Math.round(convertSize(shown.value, shown.unit, stored))).toBe(value);
            }
        }
    });
});
