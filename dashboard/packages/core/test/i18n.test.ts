/**
 * The translation engine and the rules that pick a language.
 *
 * Detection is asserted case by case because each case is a person: a Mexican
 * browser, a Catalan one, a British one, a French one in Madrid. The engine is
 * asserted on what English and Spanish actually differ on - plural rules and
 * number punctuation - and on the two ways a message can fail, which must never
 * take a render down with them.
 */

import { describe, expect, it, vi } from "vitest";
import {
    DEFAULT_LOCALE,
    LOCALE_INFO,
    LOCALES,
    isLocale,
    localeOrDefault
} from "../src/i18n/locales.js";
import {
    detectLocale,
    localeForCountry,
    matchLocale,
    negotiateLocale,
    parseAcceptLanguage
} from "../src/i18n/detect.js";
import {
    createTranslator,
    flattenCatalog,
    formatMessage,
    inspectMessage,
    lookupMessage,
    type MessageProblem
} from "../src/i18n/messages.js";
import { defineCatalogs } from "../src/i18n/catalogs.js";
import {
    createDisplayFormat,
    DISPLAY_DEFAULTS,
    parseDisplayPreferences,
    resolveDisplayPreferences,
    WEEKDAY_NAMES,
    WEEKDAY_SHORT_NAMES,
    weekdayNames
} from "../src/schemas/display.js";

describe("the locale registry", () => {
    it("starts from US English, which every other catalog is checked against", () => {
        expect(LOCALES[0]).toBe("en-US");
        expect(DEFAULT_LOCALE).toBe("en-US");
        expect(LOCALES).toContain("es-ES");
    });

    it("accepts only exact tags it has catalogs for", () => {
        expect(isLocale("es-ES")).toBe(true);
        expect(isLocale("es")).toBe(false);
        expect(isLocale("ES-es")).toBe(false);
        expect(isLocale(null)).toBe(false);
        expect(localeOrDefault("fr-FR")).toBe("en-US");
    });

    it("names each language in itself", () => {
        expect(LOCALE_INFO["es-ES"].name).toBe("Español (España)");
    });
});

describe("reading Accept-Language", () => {
    it("orders by quality, keeping the header's order for ties", () => {
        expect(parseAcceptLanguage("fr-CH, fr;q=0.9, en;q=0.8, de;q=0.7, *;q=0.5")).toEqual([
            { tag: "fr-CH", quality: 1 },
            { tag: "fr", quality: 0.9 },
            { tag: "en", quality: 0.8 },
            { tag: "de", quality: 0.7 }
        ]);
        expect(parseAcceptLanguage("en;q=0.5, es;q=0.9").map((range) => range.tag)).toEqual(["es", "en"]);
        expect(parseAcceptLanguage("de, en").map((range) => range.tag)).toEqual(["de", "en"]);
    });

    it("drops refusals, wildcards and anything that is not a tag", () => {
        expect(parseAcceptLanguage("es;q=0, en")).toEqual([{ tag: "en", quality: 1 }]);
        expect(parseAcceptLanguage("*")).toEqual([]);
        expect(parseAcceptLanguage("<script>, en-US")).toEqual([{ tag: "en-US", quality: 1 }]);
        expect(parseAcceptLanguage("es;q=abc")).toEqual([]);
        expect(parseAcceptLanguage("")).toEqual([]);
        expect(parseAcceptLanguage(null)).toEqual([]);
    });

    it("reads underscores as the hyphens a browser meant", () => {
        expect(parseAcceptLanguage("es_ES")).toEqual([{ tag: "es-ES", quality: 1 }]);
    });

    it("stops reading a header no browser would send", () => {
        expect(parseAcceptLanguage(Array.from({ length: 500 }, () => "en").join(",")).length).toBeLessThanOrEqual(32);
    });
});

describe("matching a language to a locale", () => {
    it.each([
        ["es", "es-ES"],
        ["es-ES", "es-ES"],
        ["es-MX", "es-ES"],
        ["es-419", "es-ES"],
        ["ca-ES", "es-ES"],
        ["gl", "es-ES"],
        ["eu-ES", "es-ES"],
        ["en", "en-US"],
        ["en-GB", "en-US"],
        ["EN-us", "en-US"]
    ])("%s reads %s", (tag, locale) => {
        expect(matchLocale(tag)).toBe(locale);
    });

    it("has nothing for a language without a catalog", () => {
        expect(matchLocale("fr-FR")).toBeNull();
        expect(matchLocale("")).toBeNull();
        expect(matchLocale("not a tag")).toBeNull();
    });

    it("takes the first of several that it has", () => {
        expect(negotiateLocale(["fr-FR", "de", "es-MX", "en"])).toBe("es-ES");
        expect(negotiateLocale(["fr-FR"])).toBeNull();
        expect(negotiateLocale(undefined)).toBeNull();
    });

    it("gives Spanish-speaking countries Spanish and everybody else nothing", () => {
        for (const country of ["ES", "MX", "AR", "CO", "cl", "PE", "UY"]) {
            expect(localeForCountry(country)).toBe("es-ES");
        }
        expect(localeForCountry("US")).toBeNull();
        expect(localeForCountry("FR")).toBeNull();
        expect(localeForCountry(null)).toBeNull();
    });
});

describe("detecting a language for somebody new", () => {
    it("believes the browser first", () => {
        expect(detectLocale({ acceptLanguage: "es-MX,es;q=0.9,en;q=0.8", country: "US" })).toEqual({
            locale: "es-ES",
            source: "header"
        });
        expect(detectLocale({ acceptLanguage: "en-GB", country: "ES" })).toEqual({
            locale: "en-US",
            source: "header"
        });
    });

    it("asks the page's language list when the header names nothing it has", () => {
        expect(detectLocale({ acceptLanguage: "fr-FR", languages: ["fr", "es"] })).toEqual({
            locale: "es-ES",
            source: "browser"
        });
    });

    it("falls back to the address's country when no language is one it has", () => {
        expect(detectLocale({ acceptLanguage: "fr-FR,fr;q=0.9", languages: ["fr"], country: "ES" })).toEqual({
            locale: "es-ES",
            source: "country"
        });
        expect(detectLocale({ acceptLanguage: "de", country: "DE" })).toEqual({
            locale: "en-US",
            source: "default"
        });
    });

    it("reads US English when nothing says anything", () => {
        expect(detectLocale({})).toEqual({ locale: "en-US", source: "default" });
    });
});

describe("formatting a message", () => {
    it("follows each language's plural rules", () => {
        const files = "{count, plural, one {# file} other {# files}}";
        const archivos = "{count, plural, one {# archivo} other {# archivos}}";
        expect(formatMessage("en-US", files, { count: 1 })).toBe("1 file");
        expect(formatMessage("en-US", files, { count: 0 })).toBe("0 files");
        expect(formatMessage("es-ES", archivos, { count: 1 })).toBe("1 archivo");
        expect(formatMessage("es-ES", archivos, { count: 2 })).toBe("2 archivos");
    });

    it("writes numbers the way the language does", () => {
        expect(formatMessage("en-US", "{n, number}", { n: 12345.5 })).toBe("12,345.5");
        expect(formatMessage("es-ES", "{n, number}", { n: 12345.5 })).toBe("12.345,5");
    });

    it("chooses between variants with select", () => {
        const message = "{kind, select, file {A file} folder {A folder} other {Something}}";
        expect(formatMessage("en-US", message, { kind: "folder" })).toBe("A folder");
        expect(formatMessage("en-US", message, { kind: "link" })).toBe("Something");
    });

    it("answers with the raw message, and says so once, when a value is missing", () => {
        const problems: MessageProblem[] = [];
        expect(formatMessage("en-US", "Hello {name}", {}, (problem) => problems.push(problem), "greet")).toBe(
            "Hello {name}"
        );
        expect(problems).toEqual([expect.objectContaining({ kind: "format", key: "greet", locale: "en-US" })]);
    });
});

describe("a translator", () => {
    const catalog = {
        title: "Preferences",
        greeting: "Hello {name}",
        link: "Read <link>the guide</link> first.",
        nested: { deep: "Deep" }
    };

    it("finds a message by its dotted key and fills it in", () => {
        const t = createTranslator("en-US", catalog);
        expect(t("title")).toBe("Preferences");
        expect(t("nested.deep")).toBe("Deep");
        expect(t("greeting", { name: "Ada" })).toBe("Hello Ada");
        expect(t.locale).toBe("en-US");
    });

    it("hands the pieces of a message with tags back in order, never glued", () => {
        const t = createTranslator("en-US", catalog);
        const parts = t.rich("link", { link: (chunks) => ({ tag: "a", chunks }) });
        expect(parts).toEqual(["Read ", { tag: "a", chunks: ["the guide"] }, " first."]);
    });

    it("draws the key and reports it when there is no such message", () => {
        const onProblem = vi.fn();
        const t = createTranslator("en-US", catalog, { namespace: "account", onProblem });
        expect(t("missing" as never)).toBe("account.missing");
        expect(onProblem).toHaveBeenCalledWith({ kind: "missing", locale: "en-US", key: "account.missing" });
        // A group is not a message.
        expect(t("nested" as never)).toBe("account.nested");
    });

    it("says whether a message exists without reporting anything", () => {
        const onProblem = vi.fn();
        const t = createTranslator("en-US", catalog, { onProblem });
        expect(t.has("title")).toBe(true);
        expect(t.has("nested")).toBe(false);
        expect(t.has("absent")).toBe(false);
        expect(onProblem).not.toHaveBeenCalled();
    });

    it("works with no catalog at all, which is a screen rendered outside its provider", () => {
        const t = createTranslator("en-US", undefined, { onProblem: () => undefined });
        expect(t("title" as never)).toBe("title");
    });

    it("never reads a key off the object's prototype", () => {
        expect(lookupMessage(catalog, "toString")).toBeUndefined();
        expect(lookupMessage(catalog, "constructor.name")).toBeUndefined();
    });
});

describe("a catalog set", () => {
    const set = defineCatalogs({
        "en-US": { shop: { items: "{count, plural, one {# item} other {# items}}", title: "Shop" } },
        "es-ES": { shop: { items: "{count, plural, one {# artículo} other {# artículos}}", title: "Tienda" } }
    });

    it("translates by qualified key with no translator in hand", () => {
        expect(set.translate("es-ES", "shop.items", { count: 3 })).toBe("3 artículos");
        expect(set.translate("en-US", "shop.title")).toBe("Shop");
    });

    it("keeps one translator per locale and namespace", () => {
        expect(set.translator("es-ES", "shop")).toBe(set.translator("es-ES", "shop"));
        expect(set.translator("es-ES", "shop")("title")).toBe("Tienda");
    });

    it("hands out only the namespaces asked for", () => {
        expect(Object.keys(set.pick("es-ES", ["shop"]))).toEqual(["shop"]);
        expect(set.pick("es-ES", [])).toEqual({});
        expect(set.namespaces).toEqual(["shop"]);
    });
});

describe("inspecting a message", () => {
    it("lists the arguments and tags a message uses", () => {
        expect(
            inspectMessage("en-US", "{name} has {count, plural, one {# <b>file</b>} other {# files in {place}}}")
        ).toEqual({ ok: true, args: ["count", "name", "place"], tags: ["b"] });
    });

    it("refuses a message that is not valid ICU", () => {
        expect(inspectMessage("en-US", "Hello {name").ok).toBe(false);
        expect(inspectMessage("en-US", "{count, plural, one {x}}").ok).toBe(false);
    });

    it("flattens a catalog to its dotted keys", () => {
        expect([...flattenCatalog({ a: "1", b: { c: "2", d: { e: "3" } } }).keys()]).toEqual(["a", "b.c", "b.d.e"]);
    });
});

describe("formats a language implies", () => {
    it("changes nothing for US English", () => {
        expect(resolveDisplayPreferences({}, {}, "en-US")).toEqual(DISPLAY_DEFAULTS);
        expect(resolveDisplayPreferences({ clock: "12h" }, {})).toEqual({ ...DISPLAY_DEFAULTS, clock: "12h" });
    });

    it("gives a Spanish reader day-first dates and a Monday week, under the platform's choice", () => {
        const spanish = resolveDisplayPreferences({}, {}, "es-ES");
        expect(spanish).toMatchObject({ dateOrder: "dmy", weekStart: "mon", language: "es-ES" });
        // An operator's house style still wins, and the account's own over that.
        expect(resolveDisplayPreferences({ dateOrder: "mdy" }, {}, "es-ES").dateOrder).toBe("mdy");
        expect(resolveDisplayPreferences({ dateOrder: "mdy" }, { dateOrder: "dmy" }, "es-ES").dateOrder).toBe("dmy");
    });

    it("reads the English a stored blob held before there was a second language", () => {
        expect(parseDisplayPreferences(JSON.stringify({ language: "en", clock: "12h" }))).toEqual({
            language: "en-US",
            clock: "12h"
        });
    });

    it("writes numbers and money in the reader's language", () => {
        const spanish = createDisplayFormat(resolveDisplayPreferences({}, {}, "es-ES"));
        expect(spanish.number(12345.5)).toBe("12.345,5");
        expect(spanish.currency(1234.5)).toBe("1234,50 €");
        const english = createDisplayFormat(DISPLAY_DEFAULTS);
        expect(english.number(12345.5)).toBe("12,345.5");
        expect(english.currency(1234.5)).toBe("€1,234.50");
        expect(english.number(null)).toBe("-");
    });

    it("names the days in the reader's language, and exactly as before in English", () => {
        expect(weekdayNames("en-US", "long")).toEqual([...WEEKDAY_NAMES]);
        expect(weekdayNames("en-US", "short")).toEqual([...WEEKDAY_SHORT_NAMES]);
        expect(weekdayNames("es-ES", "long")[1]).toBe("lunes");
    });
});
