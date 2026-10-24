import { describe, expect, it } from "vitest";
import { opensSearch } from "../../src/lib/search-shortcut";

const press = (key: string, extra: Partial<Parameters<typeof opensSearch>[0]> = {}) =>
    opensSearch({ key, ctrlKey: false, metaKey: false, altKey: false, target: null, ...extra });

describe("the docs search shortcut", () => {
    it("opens on Ctrl+K, Cmd+K and a bare slash", () => {
        expect(press("k", { ctrlKey: true })).toBe(true);
        expect(press("K", { metaKey: true })).toBe(true);
        expect(press("/")).toBe(true);
    });

    it("leaves other keys, a plain k and Ctrl+Alt+K alone", () => {
        expect(press("k")).toBe(false);
        expect(press("k", { ctrlKey: true, altKey: true })).toBe(false);
        expect(press("/", { ctrlKey: true })).toBe(false);
        expect(press("Enter")).toBe(false);
    });

    it("lets a slash typed into a field stay a slash", () => {
        for (const tagName of ["INPUT", "TEXTAREA", "SELECT"])
            expect(press("/", { target: { tagName } as unknown as EventTarget })).toBe(false);
        const editable = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
        expect(press("/", { target: editable })).toBe(false);
        expect(
            press("k", { ctrlKey: true, target: { tagName: "INPUT" } as unknown as EventTarget })
        ).toBe(true);
    });
});
