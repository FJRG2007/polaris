import { describe, expect, it } from "vitest";
import { edgeIndex, matchIndex, stepIndex } from "../src/lib/listbox";

/**
 * The keyboard contract of the popup's own dropdown, which replaced a native
 * `<select>`: arrows and Home/End skip what cannot be picked, and typing jumps
 * to the option it spells, cycling when the same letter is pressed again.
 */
const OPTIONS = [
    { label: "1 minute" },
    { label: "5 minutes" },
    { label: "15 minutes", disabled: true },
    { label: "1 hour" },
    { label: "Until the browser closes" }
];

describe("stepIndex", () => {
    it("moves one option and skips a disabled one", () => {
        expect(stepIndex(OPTIONS, 0, 1)).toBe(1);
        expect(stepIndex(OPTIONS, 1, 1)).toBe(3);
        expect(stepIndex(OPTIONS, 3, -1)).toBe(1);
    });

    it("stays put at either end", () => {
        expect(stepIndex(OPTIONS, 4, 1)).toBe(4);
        expect(stepIndex(OPTIONS, 0, -1)).toBe(0);
    });
});

describe("edgeIndex", () => {
    it("finds the first and last enabled option", () => {
        expect(edgeIndex(OPTIONS, "first")).toBe(0);
        expect(edgeIndex(OPTIONS, "last")).toBe(4);
    });

    it("answers -1 when nothing can be picked", () => {
        const none = [{ label: "a", disabled: true }];
        expect(edgeIndex(none, "first")).toBe(-1);
        expect(edgeIndex(none, "last")).toBe(-1);
    });
});

describe("matchIndex", () => {
    it("jumps to the option a prefix spells, ignoring case", () => {
        expect(matchIndex(OPTIONS, 0, "u")).toBe(4);
        expect(matchIndex(OPTIONS, 0, "1 h")).toBe(3);
    });

    it("cycles through options that share a repeated first letter", () => {
        expect(matchIndex(OPTIONS, 0, "1")).toBe(3);
        expect(matchIndex(OPTIONS, 3, "1")).toBe(0);
        expect(matchIndex(OPTIONS, 3, "11")).toBe(0);
    });

    it("stays put when nothing matches", () => {
        expect(matchIndex(OPTIONS, 1, "zz")).toBe(1);
    });
});
