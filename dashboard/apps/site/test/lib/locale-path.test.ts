import { describe, expect, it } from "vitest";
import { pathInLocale } from "../../src/lib/locale-path";

const L = ["en", "es"] as const;

describe("pathInLocale", () => {
    it("keeps the page being read", () => {
        expect(pathInLocale("/en/docs/drive/", "es", L)).toBe("/es/docs/drive/");
        expect(pathInLocale("/es/marketplace", "en", L)).toBe("/en/marketplace/");
    });
    it("moves an English page at the root under the locale", () => {
        expect(pathInLocale("/", "es", L)).toBe("/es/");
    });
});
