/**
 * A cache keyed by whatever a caller asks for must stay under its limits however
 * many keys are asked for, and lose the oldest answers first.
 */

import { describe, expect, it } from "vitest";
import { setBounded } from "@/lib/bounded-map";

describe("setBounded", () => {
    it("forgets the oldest entries past the entry limit", () => {
        const map = new Map<string, number>();
        for (let index = 0; index < 10; index++)
            setBounded(map, `k${index}`, index, { maxEntries: 3 });
        expect([...map.keys()]).toEqual(["k7", "k8", "k9"]);
    });

    it("treats writing a key again as the newest write", () => {
        const map = new Map<string, number>();
        setBounded(map, "a", 1, { maxEntries: 2 });
        setBounded(map, "b", 2, { maxEntries: 2 });
        setBounded(map, "a", 3, { maxEntries: 2 });
        setBounded(map, "c", 4, { maxEntries: 2 });
        expect([...map.entries()]).toEqual([
            ["a", 3],
            ["c", 4]
        ]);
    });

    it("forgets the oldest entries past the byte budget", () => {
        const map = new Map<string, Uint8Array>();
        const limits = {
            maxEntries: 100,
            maxBytes: 10,
            sizeOf: (value: Uint8Array) => value.byteLength
        };
        setBounded(map, "a", new Uint8Array(4), limits);
        setBounded(map, "b", new Uint8Array(4), limits);
        setBounded(map, "c", new Uint8Array(4), limits);
        expect([...map.keys()]).toEqual(["b", "c"]);
    });

    it("keeps the entry just written even when it alone is over the budget", () => {
        const map = new Map<string, Uint8Array>();
        const limits = {
            maxEntries: 100,
            maxBytes: 10,
            sizeOf: (value: Uint8Array) => value.byteLength
        };
        setBounded(map, "a", new Uint8Array(4), limits);
        setBounded(map, "big", new Uint8Array(20), limits);
        expect([...map.keys()]).toEqual(["big"]);
    });
});
