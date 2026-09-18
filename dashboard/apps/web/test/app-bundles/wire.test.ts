/**
 * What an app's server action sends and answers survives the trip as itself.
 */

import { describe, expect, it } from "vitest";
import { fromWire, toWire } from "@/lib/app-bundles/wire";

const trip = (value: unknown) => fromWire(JSON.parse(JSON.stringify(toWire(value))));

describe("the action wire format", () => {
    it("keeps plain values and what JSON would lose", () => {
        const at = new Date("2026-09-18T10:00:00.000Z");
        expect(trip({ at, big: 12n, nan: Number.NaN, inf: -Infinity, list: [1, "a", null] })).toEqual({
            at,
            big: 12n,
            nan: Number.NaN,
            inf: -Infinity,
            list: [1, "a", null]
        });
        expect(trip(undefined)).toBeUndefined();
        expect(trip([undefined, 1])).toEqual([undefined, 1]);
    });

    it("keeps maps and sets", () => {
        const value = { map: new Map([["a", new Date(0)]]), set: new Set([1, 2]) };
        expect(trip(value)).toEqual(value);
    });

    it("drops a property that was undefined, as a server action does", () => {
        expect(trip({ a: 1, b: undefined })).toEqual({ a: 1 });
    });

    it("cannot be fooled by an object that looks like a tagged value", () => {
        const value = { $polaris: "date", value: "not a date" };
        expect(trip(value)).toEqual(value);
    });

    it("refuses what cannot travel", () => {
        expect(() => toWire({ run: () => 1 })).toThrow(/function/);
        const loop: Record<string, unknown> = {};
        loop.self = loop;
        expect(() => toWire(loop)).toThrow(/refers to itself/);
    });
});
