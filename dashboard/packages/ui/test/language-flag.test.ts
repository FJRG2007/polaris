import { describe, expect, it } from "vitest";
import { FLAG_LOADERS } from "../src/flags";
import { languageFlagCode } from "../src/components/language-flag";

/**
 * A language is shown with a flag only when one plainly fits: the region in the
 * tag, or the country its readers expect. Anything else gets none - a missing
 * flag reads as nothing, a wrong one reads as a mistake.
 */
describe("languageFlagCode", () => {
    it.each([
        ["en-US", "us"],
        ["en-GB", "gb"],
        ["es", "es"],
        ["es-ES", "es"],
        ["pt-BR", "br"],
        ["pt", "pt"],
        ["zh-Hans", "cn"],
        ["zh-Hant", "tw"],
        ["ar", "sa"],
        ["he", "il"],
        ["ja", "jp"],
        ["ko", "kr"],
        ["uk", "ua"],
        ["el", "gr"],
        ["cs", "cz"],
        ["da", "dk"],
        ["sv", "se"],
        ["nb", "no"],
        ["hi", "in"],
        ["vi", "vn"],
        ["et", "ee"],
        ["sl", "si"],
        ["ca", "es-ct"],
        ["eu", "es-pv"],
        ["gl", "es-ga"]
    ])("%s -> %s", (tag, flag) => {
        expect(languageFlagCode(tag)).toBe(flag);
    });

    it("uses the region in the tag over the language's usual country", () => {
        expect(languageFlagCode("pt-PT")).toBe("pt");
        expect(languageFlagCode("es-US")).toBe("us");
        expect(languageFlagCode("zh-Hant-TW")).toBe("tw");
    });

    it("shows no flag rather than a guess", () => {
        // A language spoken across many countries, with no region to say which.
        expect(languageFlagCode("en")).toBeNull();
        expect(languageFlagCode("zh")).toBeNull();
        // Codes that look like a country but are not that country's language.
        expect(languageFlagCode("be")).toBeNull();
        expect(languageFlagCode("bn")).toBeNull();
        // A region with no flag here, and a region that is not a country.
        expect(languageFlagCode("es-MX")).toBeNull();
        expect(languageFlagCode("es-419")).toBeNull();
        expect(languageFlagCode("not a tag")).toBeNull();
    });

    it("loads every flag it names from the app itself", async () => {
        for (const load of Object.values(FLAG_LOADERS)) {
            const svg = (await load()).default;
            expect(svg.startsWith("<svg")).toBe(true);
            expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
        }
    });
});
