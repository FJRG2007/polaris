import { describe, expect, it } from "vitest";
import { isAttachShortcut } from "@/components/polar/composer-plus-menu";

const key = (overrides: Partial<Parameters<typeof isAttachShortcut>[0]>) => ({
    key: "u",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides
});

describe("the composer's attach shortcut", () => {
    it("is Ctrl+U, or Cmd+U on a Mac, in either case", () => {
        expect(isAttachShortcut(key({ ctrlKey: true }))).toBe(true);
        expect(isAttachShortcut(key({ metaKey: true, key: "U" }))).toBe(true);
    });

    it("is nothing else", () => {
        expect(isAttachShortcut(key({}))).toBe(false);
        expect(isAttachShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
        expect(isAttachShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
        expect(isAttachShortcut(key({ ctrlKey: true, key: "y" }))).toBe(false);
    });
});
