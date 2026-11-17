/**
 * The browser's own translator is offered only where it exists, reuses one
 * translator per language pair, and gives way when a pair is unavailable.
 */

import { describe, expect, it, vi } from "vitest";
import {
    BrowserEngineUnavailable,
    browserCode,
    createBrowserEngine,
    hasBrowserTranslator
} from "@polaris-app/translate/src/screens/browser-engine";

function chrome(availability = "available") {
    const translate = vi.fn(async (text: string) => `[${text}]`);
    const create = vi.fn(async () => ({ translate }));
    const scope = {
        Translator: { availability: vi.fn(async () => availability), create },
        LanguageDetector: {
            create: async () => ({
                detect: async () => [
                    { detectedLanguage: "und", confidence: 0.9 },
                    { detectedLanguage: "es", confidence: 0.8 }
                ]
            })
        }
    };
    return { scope, create, translate };
}

describe("feature detection", () => {
    it("finds the translator only when the API is there", () => {
        expect(hasBrowserTranslator(chrome().scope)).toBe(true);
        expect(hasBrowserTranslator({})).toBe(false);
        expect(hasBrowserTranslator({ Translator: {} })).toBe(false);
        expect(hasBrowserTranslator(undefined)).toBe(false);
    });
});

describe("the browser engine", () => {
    it("translates each text and keeps one translator per pair", async () => {
        const { scope, create } = chrome();
        const engine = createBrowserEngine(scope);
        const first = await engine.translate(["hola", " "], "es", "en");
        await engine.translate(["adios"], "es", "en");
        expect(first.texts).toEqual(["[hola]", " "]);
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("detects the source when none is given, skipping an undetermined guess", async () => {
        const engine = createBrowserEngine(chrome().scope);
        const answer = await engine.translate(["hola"], null, "en");
        expect(answer.detected).toBe("es");
        expect(await engine.detect("hola")).toBe("es");
    });

    it("gives way when the pair is unavailable", async () => {
        const engine = createBrowserEngine(chrome("unavailable").scope);
        await expect(engine.translate(["hola"], "es", "en")).rejects.toBeInstanceOf(
            BrowserEngineUnavailable
        );
    });

    it("waits on no model download when it must answer at once", async () => {
        for (const state of ["downloadable", "downloading"]) {
            const { scope, create } = chrome(state);
            const engine = createBrowserEngine(scope, undefined, true);
            await expect(engine.translate(["hola"], "es", "en")).rejects.toBeInstanceOf(
                BrowserEngineUnavailable
            );
            expect(create).not.toHaveBeenCalled();
        }
        const { scope, create } = chrome("available");
        await createBrowserEngine(scope, undefined, true).translate(["hola"], "es", "en");
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("downloads a model when the reader can wait for it", async () => {
        const { scope, create } = chrome("downloadable");
        await createBrowserEngine(scope).translate(["hola"], "es", "en");
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("detects nothing through a detector it would have to download", async () => {
        const { scope } = chrome();
        const detectorCreate = vi.fn(scope.LanguageDetector.create);
        const waiting = {
            ...scope,
            LanguageDetector: { availability: async () => "downloadable", create: detectorCreate }
        };
        await expect(createBrowserEngine(waiting, undefined, true).detect("hola")).rejects.toBeInstanceOf(
            BrowserEngineUnavailable
        );
        expect(detectorCreate).not.toHaveBeenCalled();
    });

    it("spells Simplified Chinese the way the browser does", () => {
        expect(browserCode("zh-Hans")).toBe("zh");
        expect(browserCode("zh-Hant")).toBe("zh-Hant");
    });
});
