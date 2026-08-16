/**
 * The shelf of ARK mods Polaris suggests.
 *
 * Every id on it was resolved against Steam before it was written down, and what
 * is asserted here is the part that can rot without anybody noticing: an id that
 * is not an id, the same mod on two shelves, an entry with nothing said about it.
 * What each one is called and how big it is comes from Steam as the screen draws,
 * so none of that is pinned here.
 */

import { describe, expect, it } from "vitest";
import { ARK_MOD_SHELVES, findSuggestion, shelfModIds } from "@/lib/apps/ark/mod-catalog";

const entries = ARK_MOD_SHELVES.flatMap((shelf) => shelf.entries);

describe("the suggested mods", () => {
    it("has shelves, and none of them empty", () => {
        expect(ARK_MOD_SHELVES.length).toBeGreaterThan(0);
        for (const shelf of ARK_MOD_SHELVES) expect(shelf.entries.length).toBeGreaterThan(0);
    });

    it("names every entry by a Workshop id", () => {
        for (const entry of entries) expect(entry.id).toMatch(/^\d{6,12}$/);
    });

    it("suggests each mod once", () => {
        const ids = entries.map((entry) => entry.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("says why each one is worth having", () => {
        // A shelf of names is a search box with extra steps.
        for (const entry of entries) {
            expect(entry.why.length).toBeGreaterThan(20);
            expect(entry.name.length).toBeGreaterThan(0);
        }
    });

    it("says which of them is a map, since that is a different button", () => {
        for (const entry of entries) expect(["mod", "map"]).toContain(entry.kind);
        expect(entries.some((entry) => entry.kind === "map")).toBe(true);
    });

    it("hands every id to the one call that resolves them", () => {
        expect(shelfModIds()).toHaveLength(entries.length);
        // Well inside the ceiling on one details call, so the shelf is one request.
        expect(shelfModIds().length).toBeLessThanOrEqual(64);
    });

    it("finds a suggestion by its id", () => {
        const first = entries[0];
        expect(findSuggestion(first?.id ?? "")).toEqual(first);
        expect(findSuggestion("000000")).toBeUndefined();
    });
});
