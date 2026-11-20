/**
 * The site moves an English page to Spanish for a reader who reads Spanish,
 * never moves a Spanish address, and stops detecting once the picker is used.
 */

import { describe, expect, it } from "vitest";
import { LOCALE_CHOICE_KEY, localeScript, preferredLocale } from "../src/lib/locale-detect";

function run(path: string, languages: string[], choice: string | null = null): string | null {
    let moved: string | null = null;
    const script = localeScript("/polaris", "en");
    const location = { pathname: path, search: "?a=1", hash: "#h", replace: (to: string) => (moved = to) };
    const navigator = { languages, language: languages[0] ?? "" };
    const localStorage = { getItem: (key: string) => (key === LOCALE_CHOICE_KEY ? choice : null) };
    new Function("location", "navigator", "localStorage", script)(location, navigator, localStorage);
    return moved;
}

describe("the reader's language", () => {
    it("moves an English page to the same page in Spanish for a Spanish reader", () => {
        expect(run("/polaris/en/docs/privacy/", ["es-ES", "en"])).toBe("/polaris/es/docs/privacy/?a=1#h");
        expect(run("/polaris/", ["es"])).toBe("/polaris/es/?a=1#h");
    });

    it("leaves an English reader, and one whose first site language is English, where they are", () => {
        expect(run("/polaris/en/docs/privacy/", ["en-US"])).toBeNull();
        expect(run("/polaris/en/", ["fr", "en", "es"])).toBeNull();
    });

    it("keeps the language picked in the picker over the browser's", () => {
        expect(run("/polaris/en/", ["es-ES"], "en")).toBeNull();
        expect(run("/polaris/en/", ["en-US"], "es")).toBe("/polaris/es/?a=1#h");
    });

    it("never runs on a Spanish page", () => {
        expect(localeScript("/polaris", "es")).toBe("");
    });

    it("reads the browser's first site language", () => {
        expect(preferredLocale(["fr-FR", "es-MX", "en"])).toBe("es");
        expect(preferredLocale(["de"])).toBeNull();
    });
});
