/**
 * What Translate accepts: bounded text, known language codes, and settings
 * that fall back field by field to working defaults.
 */

import { describe, expect, it } from "vitest";
import { normalizeDetected } from "@polaris-app/translate/src/model/languages";
import {
    DEFAULT_ORDER,
    DEFAULT_SETTINGS,
    TEXT_MAX,
    TEXTS_MAX,
    TOTAL_MAX,
    detectInput,
    readOrder,
    readSettings,
    settingsInput,
    translateInput
} from "@polaris-app/translate/src/model/schemas";

describe("translateInput", () => {
    it("takes texts, a target and detects the source by default", () => {
        const parsed = translateInput.parse({ texts: ["Hola"], to: "en" });
        expect(parsed.from).toBe("auto");
    });

    it.each([
        ["no texts", { texts: [], to: "en" }],
        ["only whitespace", { texts: ["  ", "\n"], to: "en" }],
        ["a text past the limit", { texts: ["a".repeat(TEXT_MAX + 1)], to: "en" }],
        ["too many texts", { texts: Array.from({ length: TEXTS_MAX + 1 }, () => "a"), to: "en" }],
        [
            "too much text in all",
            { texts: Array.from({ length: 5 }, () => "a".repeat(TOTAL_MAX / 4)), to: "en" }
        ],
        ["an unknown target", { texts: ["Hola"], to: "xx" }],
        ["an unknown engine", { texts: ["Hola"], to: "en", engine: "bing" }],
        ["the same language both sides", { texts: ["Hola"], from: "es", to: "es" }],
        ["a field it does not know", { texts: ["Hola"], to: "en", key: "secret" }]
    ])("refuses %s", (_name, body) => {
        expect(translateInput.safeParse(body).success).toBe(false);
    });

    it("refuses an empty text to detect", () => {
        expect(detectInput.safeParse({ text: "   " }).success).toBe(false);
    });
});

describe("readSettings", () => {
    it("is the defaults when nothing is stored", () => {
        expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
        expect(readSettings("garbage")).toEqual(DEFAULT_SETTINGS);
    });

    it("keeps what parses and defaults the rest", () => {
        expect(
            readSettings({ engines: { deepl: false, polar: "no" }, defaultTarget: "xx" })
        ).toEqual({
            engines: {
                browser: true,
                local: true,
                polar: true,
                libretranslate: true,
                deepl: false,
                google: true
            },
            order: ["browser", "local", "libretranslate", "deepl", "google", "polar"],
            defaultTarget: "en",
            charLimit: null
        });
    });

    it("reads the length limit leniently: off unless a whole number in range", () => {
        expect(readSettings({ charLimit: 2000 }).charLimit).toBe(2000);
        for (const raw of ["2000", 99, 1.5, -1, 10_000_001, null, undefined]) {
            expect(readSettings({ charLimit: raw }).charLimit).toBeNull();
        }
    });

    it("accepts settings saved without a limit as no limit, and refuses one out of range", () => {
        const base = {
            engines: DEFAULT_SETTINGS.engines,
            order: DEFAULT_SETTINGS.order,
            defaultTarget: "en"
        };
        const parsed = settingsInput.safeParse(base);
        expect(parsed.success && parsed.data.charLimit).toBeNull();
        expect(settingsInput.safeParse({ ...base, charLimit: 50 }).success).toBe(false);
        expect(settingsInput.safeParse({ ...base, charLimit: 5000 }).success).toBe(true);
    });

    it("keeps a stored order, drops what it does not know, and fills in what it lacks", () => {
        // Nothing before them is kept: the missing ones go first, in the default order.
        expect(readSettings({ order: ["polar", "google"] }).order).toEqual([
            "browser",
            "local",
            "libretranslate",
            "deepl",
            "polar",
            "google"
        ]);
        expect(readSettings({ order: ["polar", "polar", "bing", 3] }).order).toEqual([
            "browser",
            "local",
            "libretranslate",
            "deepl",
            "google",
            "polar"
        ]);
    });

    it("puts the local engine right after the browser's in an order saved before it", () => {
        expect(readOrder(["polar", "browser", "google", "deepl"])).toEqual([
            "polar",
            "browser",
            "local",
            "libretranslate",
            "google",
            "deepl"
        ]);
        expect(readOrder(["deepl", "google", "polar", "browser"])).toEqual([
            "deepl",
            "google",
            "polar",
            "browser",
            "local",
            "libretranslate"
        ]);
        // An order that already places it keeps it where it is.
        expect(readOrder(["local", "polar", "browser", "deepl", "google"])).toEqual([
            "local",
            "libretranslate",
            "polar",
            "browser",
            "deepl",
            "google"
        ]);
        expect(readSettings(null).order).toEqual(DEFAULT_ORDER);
    });

    it("refuses an order that repeats or leaves out an engine", () => {
        const base = { engines: DEFAULT_SETTINGS.engines, defaultTarget: "en" };
        expect(
            settingsInput.safeParse({ ...base, order: ["polar", "google", "deepl", "browser"] })
                .success
        ).toBe(true);
        expect(
            settingsInput.safeParse({ ...base, order: ["polar", "polar", "deepl", "browser"] })
                .success
        ).toBe(false);
        // An order from a client older than an engine is completed, not refused.
        const older = settingsInput.safeParse({
            ...base,
            engines: { browser: true, polar: true, deepl: true, google: true },
            order: ["polar", "google", "deepl", "browser"]
        });
        expect(older.success && older.data.order).toEqual([
            "polar",
            "google",
            "deepl",
            "browser",
            "local",
            "libretranslate"
        ]);
        expect(older.success && older.data.engines.local).toBe(true);
    });
});

describe("normalizeDetected", () => {
    it.each([
        ["EN", "en"],
        ["pt-br", "pt-BR"],
        ["zh-CN", "zh-Hans"],
        ["zh-TW", "zh-Hant"],
        ["iw", "he"],
        ["de-AT", "de"],
        ["und", null],
        [null, null]
    ])("reads %s as %s", (raw, expected) => {
        expect(normalizeDetected(raw)).toBe(expected);
    });
});
