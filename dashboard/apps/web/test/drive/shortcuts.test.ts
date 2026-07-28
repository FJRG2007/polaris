/**
 * Explorer shortcuts. The risk they carry is firing when they should not - a
 * stray "n" while the user is doing something else must never create a folder -
 * so what is pinned here is both the mapping and the refusal to claim any press
 * that carries a modifier.
 */

import { describe, expect, it } from "vitest";
import { matchShortcut, SHORTCUT_HINTS } from "../../src/app/(app)/drive/shortcuts";

describe("matchShortcut", () => {
    it("maps the create and upload keys", () => {
        expect(matchShortcut({ key: "n" })).toBe("new-folder");
        expect(matchShortcut({ key: "f" })).toBe("new-file");
        expect(matchShortcut({ key: "u" })).toBe("upload-files");
        expect(matchShortcut({ key: "r" })).toBe("request-files");
    });

    it("uploads a folder with shift", () => {
        expect(matchShortcut({ key: "U", shiftKey: true })).toBe("upload-folder");
    });

    it("ignores a press that carries a modifier", () => {
        expect(matchShortcut({ key: "n", ctrlKey: true })).toBeNull();
        expect(matchShortcut({ key: "n", metaKey: true })).toBeNull();
        expect(matchShortcut({ key: "u", altKey: true })).toBeNull();
        // Ctrl+A, Ctrl+C and friends stay with the listing's own handler.
        expect(matchShortcut({ key: "a", ctrlKey: true })).toBeNull();
    });

    it("claims nothing else", () => {
        for (const key of ["a", "s", "d", "Enter", "Escape", "F2", "Delete", "ArrowDown"]) {
            expect(matchShortcut({ key })).toBeNull();
        }
    });

    it("names every action in the menu hints", () => {
        const actions = [
            "new-folder",
            "new-file",
            "upload-files",
            "upload-folder",
            "request-files"
        ] as const;
        for (const action of actions) expect(SHORTCUT_HINTS[action]).toBeTruthy();
    });
});
