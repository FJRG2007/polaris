/**
 * What Translate accepts: bounded text, known language codes, and settings
 * that fall back field by field to working defaults.
 */

import { describe, expect, it } from "vitest";
import { normalizeDetected } from "@polaris-app/translate/src/model/languages";
import {
    DEFAULT_SETTINGS,
    TEXT_MAX,
    TEXTS_MAX,
    TOTAL_MAX,
    detectInput,
    readSettings,
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
        ["too much text in all", { texts: Array.from({ length: 5 }, () => "a".repeat(TOTAL_MAX / 4)), to: "en" }],
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
        expect(readSettings({ engines: { deepl: false, polar: "no" }, defaultTarget: "xx" })).toEqual({
            engines: { browser: true, polar: true, deepl: false, google: true },
            defaultTarget: "en"
        });
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
