import { describe, expect, it } from "vitest";
import { isDirty, sameValue } from "../src/lib/dirty";

describe("whether a form has anything to save", () => {
    it("is clean when a value was edited and put back", () => {
        const loaded = { name: "Backups", port: 8080, tags: ["a", "b"] };
        expect(isDirty(loaded, { name: "Backups", port: 8080, tags: ["a", "b"] })).toBe(false);
        expect(isDirty(loaded, { ...loaded, name: "Backup" })).toBe(true);
    });

    it("forgives what a save would forgive", () => {
        expect(sameValue("  Backups ", "Backups")).toBe(true);
        expect(sameValue("", null)).toBe(true);
        expect(sameValue("   ", undefined)).toBe(true);
        expect(sameValue("8", 8)).toBe(true);
        expect(sameValue("8.0", 8)).toBe(true);
        expect(sameValue({ note: "" }, {})).toBe(true);
        expect(sameValue(new Date(5), new Date(5))).toBe(true);
    });

    it("still sees a real change", () => {
        expect(sameValue("8", 9)).toBe(false);
        expect(sameValue("08", "8")).toBe(false);
        expect(sameValue("", "x")).toBe(false);
        expect(sameValue(0, null)).toBe(false);
        expect(sameValue(false, null)).toBe(false);
        expect(sameValue(true, false)).toBe(false);
        expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });

    it("reads a set without order and a list in order", () => {
        expect(sameValue(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
        expect(sameValue(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
        expect(sameValue(["a", "b"], ["b", "a"])).toBe(false);
        const sorted = (value: { ids: string[] }) => [...value.ids].sort();
        expect(isDirty({ ids: ["a", "b"] }, { ids: ["b", "a"] }, sorted)).toBe(false);
    });

    it("compares through the save's own normalization", () => {
        const email = (value: string) => value.trim().toLowerCase();
        expect(isDirty("ana@example.com", " Ana@Example.com", email)).toBe(false);
        expect(isDirty("ana@example.com", "ann@example.com", email)).toBe(true);
    });
});
