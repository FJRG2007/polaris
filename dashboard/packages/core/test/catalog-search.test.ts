/**
 * Searching a game's catalogue, now that it runs the shared search.
 *
 * What it promised before has to still hold: the item called exactly what was
 * typed comes first, a typo still finds it, an item with no picture sinks among
 * equals - and a catalogue without the thing answers nothing.
 */

import { describe, expect, it } from "vitest";
import { searchCatalog, type SearchableItem } from "../src/catalog-search.js";

const item = (id: string, label: string, rank = 0): SearchableItem => ({
    id,
    label,
    search: `${label.toLowerCase()} ${id}`,
    rank
});

const CATALOG: readonly SearchableItem[] = [
    item("minecraft:block_of_diamond", "Block of Diamond"),
    item("minecraft:diamond_sword", "Diamond Sword"),
    item("minecraft:diamond", "Diamond"),
    item("minecraft:diamond_ore", "Diamond Ore", 1),
    item("minecraft:dirt", "Dirt")
];

const labels = (query: string, limit = 10): string[] =>
    searchCatalog(CATALOG, query, limit).map((entry) => entry.label);

describe("searching a catalogue", () => {
    it("puts the item called exactly that first, and the one inside a longer name last", () => {
        expect(labels("diamond")).toEqual([
            "Diamond",
            "Diamond Sword",
            "Diamond Ore",
            "Block of Diamond"
        ]);
    });

    it("answers a precise query precisely", () => {
        expect(labels("diamond sw")).toEqual(["Diamond Sword"]);
    });

    it("still finds what a typo meant", () => {
        expect(labels("dimaond")[0]).toBe("Diamond");
    });

    it("answers nothing for a thing the catalogue does not have", () => {
        expect(labels("beacon")).toEqual([]);
    });

    it("stops at the limit, and is the first of everything when nothing is typed", () => {
        expect(labels("diamond", 2)).toEqual(["Diamond", "Diamond Sword"]);
        expect(labels("", 2)).toEqual(["Block of Diamond", "Diamond Sword"]);
    });
});
