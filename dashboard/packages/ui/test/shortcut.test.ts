import { describe, expect, it } from "vitest";
import { formatShortcut } from "../src/lib/shortcut";

describe("formatShortcut", () => {
    it("prints the neutral modifier as the one that machine actually has", () => {
        expect(formatShortcut("Mod+C", false)).toBe("Ctrl+C");
        expect(formatShortcut("Mod+C", true)).toBe("⌘C");
    });

    it("uppercases a single letter so the same press reads the same way", () => {
        expect(formatShortcut("Mod+c", false)).toBe("Ctrl+C");
    });

    it("keeps a named key as it was written", () => {
        expect(formatShortcut("F2", false)).toBe("F2");
        expect(formatShortcut("F2", true)).toBe("F2");
    });

    it("shortens the keys whose full name is longer than the column", () => {
        expect(formatShortcut("Delete", false)).toBe("Del");
        expect(formatShortcut("Delete", true)).toBe("⌫");
        expect(formatShortcut("Enter", false)).toBe("Enter");
        expect(formatShortcut("Escape", false)).toBe("Esc");
    });

    it("stacks apple modifiers with no separator, in the order given", () => {
        expect(formatShortcut("Mod+Shift+K", true)).toBe("⌘⇧K");
        expect(formatShortcut("Mod+Shift+K", false)).toBe("Ctrl+Shift+K");
    });

    it("survives a key that is itself a plus or a minus", () => {
        expect(formatShortcut("Mod++", false)).toBe("Ctrl++");
        expect(formatShortcut("Mod+-", false)).toBe("Ctrl+-");
    });
});
