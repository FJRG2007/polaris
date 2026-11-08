/**
 * The local engine's models: which pairs it can run (through English when
 * neither side is), the route parameters it accepts - only a pinned pair and
 * one of that pair's files - and where it sits among the engines.
 */

import { describe, expect, it } from "vitest";
import { usableEngines } from "@polaris-app/translate/src/model/engines";
import { DEFAULT_SETTINGS } from "@polaris-app/translate/src/model/schemas";
import { LOCAL_MODEL_REVISION } from "@polaris-app/translate/src/model/local-registry";
import { ENGINE_LIMITS, translateInChunks } from "@polaris-app/translate/src/model/chunk";
import {
    LOCAL_PAIRS,
    downloadSize,
    modelFileParams,
    modelsFor,
    pairFiles,
    servedUrl,
    upstreamUrl
} from "@polaris-app/translate/src/model/local-models";

describe("modelsFor", () => {
    it("runs one model to or from English and pivots through it otherwise", () => {
        expect(modelsFor("en", "es")).toEqual([{ from: "en", to: "es" }]);
        expect(modelsFor("de", "en")).toEqual([{ from: "de", to: "en" }]);
        expect(modelsFor("de", "es")).toEqual([
            { from: "de", to: "en" },
            { from: "en", to: "es" }
        ]);
        expect(modelsFor("zh-Hans", "en")).toEqual([{ from: "zh", to: "en" }]);
        expect(modelsFor("en", "pt-BR")).toEqual([{ from: "en", to: "pt" }]);
        expect(modelsFor("es", "es")).toEqual([]);
    });

    it("says no to a pair the registry does not have", () => {
        expect(modelsFor("en", "xx")).toBeNull();
        expect(modelsFor("xx", "es")).toBeNull();
    });

    it("knows every pair's files, sizes and hashes", () => {
        expect(LOCAL_PAIRS.length).toBeGreaterThan(60);
        for (const pair of LOCAL_PAIRS) {
            const roles = pairFiles(pair).map((file) => file.role);
            expect(roles).toContain("model");
            expect(roles).toContain("lex");
            expect(
                roles.includes("vocab") || (roles.includes("srcvocab") && roles.includes("trgvocab"))
            ).toBe(true);
            for (const file of pairFiles(pair)) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(downloadSize("de", "es")).toBeGreaterThan(downloadSize("en", "es"));
    });

    it("fetches from Polaris in the page and from the pinned revision upstream", () => {
        const file = pairFiles("en-es")[0]!;
        expect(servedUrl("en-es", file)).toMatch(
            /^\/api\/translate\/models\/en-es\/[^/]+\?rev=[0-9a-f]{12}$/
        );
        expect(upstreamUrl("en-es", file)).toBe(
            `https://huggingface.co/midudev/firefox-translations/resolve/${LOCAL_MODEL_REVISION}/en-es/${file.name}`
        );
    });
});

describe("modelFileParams", () => {
    it("takes a pinned pair and one of its files", () => {
        const file = pairFiles("en-es")[0]!;
        const parsed = modelFileParams.safeParse({ pair: "en-es", file: file.name });
        expect(parsed.success && parsed.data.file.sha256).toBe(file.sha256);
    });

    it("refuses anything else", () => {
        const own = pairFiles("en-es")[0]!.name;
        for (const params of [
            { pair: "en-xx", file: "model.enxx.intgemm.alphas.bin" },
            { pair: "en-es", file: pairFiles("en-de")[0]!.name },
            { pair: "en-es", file: "../../etc/passwd" },
            { pair: "../en-es", file: own },
            { pair: "constructor", file: "x" },
            { pair: "en-es" },
            { pair: "en-es", file: own, extra: 1 }
        ]) {
            expect(modelFileParams.safeParse(params).success).toBe(false);
        }
    });
});

describe("the local engine in the order", () => {
    const available = { deepl: true, google: false, polar: true };
    const settings = DEFAULT_SETTINGS;

    it("is offered after the browser's translator where the browser can run it", () => {
        expect(usableEngines({ browser: true, local: true, available, settings })).toEqual([
            "browser",
            "local",
            "deepl",
            "polar"
        ]);
        expect(usableEngines({ browser: false, local: true, available, settings })).toEqual([
            "local",
            "deepl",
            "polar"
        ]);
    });

    it("is left out where the browser cannot run it or the owner turned it off", () => {
        expect(usableEngines({ browser: false, local: false, available, settings })).toEqual([
            "deepl",
            "polar"
        ]);
        const off = { ...settings, engines: { ...settings.engines, local: false } };
        expect(usableEngines({ browser: false, local: true, available, settings: off })).toEqual([
            "deepl",
            "polar"
        ]);
    });

    it("gets a long text in pieces it can take", async () => {
        const text = "Una frase corta. ".repeat(2000);
        const sizes: number[] = [];
        const answer = await translateInChunks([text], ENGINE_LIMITS.local, async (batch) => {
            sizes.push(batch.reduce((sum, piece) => sum + piece.length, 0));
            return { texts: batch, detected: null };
        });
        expect(sizes.length).toBeGreaterThan(1);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(ENGINE_LIMITS.local.maxChars);
        expect(answer.texts).toEqual([text]);
    });
});
