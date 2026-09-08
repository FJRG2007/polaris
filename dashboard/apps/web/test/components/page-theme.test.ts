import { pageIsDark } from "@/lib/page-theme";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Which way round the page is, for the code that has to be told.
 *
 * A canvas and an embedded editor cannot read a CSS variable, so they are handed
 * the word - and three components were reading a `data-theme` attribute Polaris
 * has never written. It is null on every page, so every one of them concluded
 * "light", which on the default theme is exactly backwards: a white spreadsheet
 * and a white canvas in the middle of a dark screen.
 *
 * The theme is a class on the root. Dark carries none at all, which is the case
 * worth pinning: "no class" has to mean dark rather than "nothing chosen".
 */
describe("which way round the page is", () => {
    const withRoot = (classes: string, prefersDark = true): void => {
        vi.stubGlobal("document", { documentElement: { classList: tokens(classes) } });
        vi.stubGlobal("window", {
            matchMedia: (query: string) => ({ matches: query.includes("dark") && prefersDark })
        });
    };

    /** Just enough of a `DOMTokenList` for the question being asked. */
    const tokens = (classes: string) => {
        const held = new Set(classes.split(" ").filter(Boolean));
        return { contains: (name: string) => held.has(name) };
    };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("is dark when nothing says otherwise, because dark is the default", () => {
        withRoot("");
        expect(pageIsDark()).toBe(true);
    });

    it("is light when the light class is on", () => {
        withRoot("light");
        expect(pageIsDark()).toBe(false);
    });

    it("follows the browser when the page is set to", () => {
        withRoot("system", true);
        expect(pageIsDark()).toBe(true);
        withRoot("system", false);
        expect(pageIsDark()).toBe(false);
    });

    it("stays dark on a browser that cannot be asked", () => {
        // No `matchMedia` at all. Dark is what the page is without one, so
        // answering light here would be the same backwards default in a
        // different disguise.
        vi.stubGlobal("document", { documentElement: { classList: tokens("system") } });
        vi.stubGlobal("window", {});
        expect(pageIsDark()).toBe(true);
    });
});
