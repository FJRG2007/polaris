/**
 * A locale that ships with only some of its messages.
 *
 * Nothing in the registry is partial today, so the locales here are ones the
 * registry does not know - which is exactly how a locale not marked complete is
 * treated. What is asserted is what a reader of one would see: their words where
 * they exist, the source's everywhere else, never a key; and an English plural
 * chosen by English rules even when the reader's language counts differently.
 */

import { describe, expect, it } from "vitest";
import { defineCatalogs } from "../src/i18n/catalogs.js";
import { isCompleteLocale, LOCALES, wordsFor, type Locale } from "../src/i18n/locales.js";
import { catalogCoverage, createTranslator, mergeCatalog, type Catalog } from "../src/i18n/messages.js";

const english = {
    screen: {
        title: "Files",
        empty: "Nothing here yet",
        count: "{count, plural, one {# file} other {# files}}",
        size: "{bytes, number} bytes"
    }
} satisfies Catalog;

const GERMAN = "de-DE" as Locale;
const RUSSIAN = "ru-RU" as Locale;

describe("a partial locale", () => {
    const set = defineCatalogs({
        "en-US": { files: english },
        "es-ES": { files: english },
        [GERMAN]: { files: { screen: { title: "Dateien" } } }
    } as never);

    it("is anything the registry does not mark complete", () => {
        for (const locale of LOCALES) expect(isCompleteLocale(locale)).toBe(true);
        expect(isCompleteLocale(GERMAN)).toBe(false);
    });

    it("reads its own words, and the source's for the rest, never a key", () => {
        const t = set.translator(GERMAN, "files" as never) as (key: string) => string;
        expect(t("screen.title")).toBe("Dateien");
        expect(t("screen.empty")).toBe("Nothing here yet");
        expect(set.translate(GERMAN, "files.screen.empty" as never)).toBe("Nothing here yet");
    });

    it("hands the browser every key, filled in", () => {
        const picked = set.pick(GERMAN, ["files"] as never) as { files: typeof english };
        expect(picked.files.screen).toEqual({ ...english.screen, title: "Dateien" });
    });

    it("formats a fallback's numbers in the reader's locale", () => {
        expect(set.translate(GERMAN, "files.screen.size" as never, { bytes: 1234.5 })).toBe(
            "1.234,5 bytes"
        );
    });

    it("chooses a fallback's plural by the source's rules when the reader's language counts differently", () => {
        const t = createTranslator(RUSSIAN, mergeCatalog(english, {}));
        // Russian picks "one" for 21 and has "few"/"many" the English message lacks.
        expect(t("screen.count", { count: 21 })).toBe("21 files");
        expect(t("screen.count", { count: 3 })).toBe("3 files");
        expect(t("screen.count", { count: 1 })).toBe("1 file");
    });

    it("keeps its own plural rules for a message translated with every category", () => {
        const t = createTranslator(RUSSIAN, {
            n: "{count, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}"
        });
        expect(t("n", { count: 21 })).toBe("21 файл");
        expect(t("n", { count: 3 })).toBe("3 файла");
    });

    it("reports its coverage per namespace", () => {
        expect(set.coverage(GERMAN)).toEqual([{ namespace: "files", translated: 1, total: 4 }]);
        expect(set.coverage("es-ES")).toEqual([{ namespace: "files", translated: 4, total: 4 }]);
        expect(catalogCoverage(english, undefined)).toEqual({ translated: 0, total: 4 });
    });

    it("drops a key only the translation has", () => {
        expect(mergeCatalog({ a: "A" }, { a: "a", stray: "x" })).toEqual({ a: "a" });
    });
});

describe("inline words", () => {
    it("fall back to the source's", () => {
        expect(wordsFor({ "en-US": "Done", "es-ES": "Hecho" }, "es-ES")).toBe("Hecho");
        expect(wordsFor({ "en-US": "Done" }, GERMAN)).toBe("Done");
    });
});
