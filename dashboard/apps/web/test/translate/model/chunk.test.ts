/**
 * Long text is cut where it reads naturally, sent in batches each engine
 * takes, and joined back exactly: the reader never meets a length.
 */

import { describe, expect, it, vi } from "vitest";
import {
    ENGINE_LIMITS,
    batchesOf,
    splitText,
    translateInChunks
} from "@polaris-app/translate/src/model/chunk";

describe("splitText", () => {
    it("leaves a short text whole", () => {
        expect(splitText("hola", 10)).toEqual(["hola"]);
        expect(splitText("", 10)).toEqual([""]);
    });

    it("cuts at a blank line, then a sentence, and joins back exactly", () => {
        const text = `${"a".repeat(30)}.\n\n${"b".repeat(30)}. ${"c".repeat(30)}.`;
        const pieces = splitText(text, 40);
        expect(pieces.join("")).toBe(text);
        expect(pieces.every((piece) => piece.length <= 40)).toBe(true);
        expect(pieces[0]!.endsWith("\n\n")).toBe(true);
    });

    it("cuts a text with no break at the cap, never through a surrogate pair", () => {
        const text = `${"x".repeat(9)}${"\u{1F600}".repeat(5)}`;
        const pieces = splitText(text, 10);
        expect(pieces.join("")).toBe(text);
        for (const piece of pieces) expect(piece).not.toMatch(/[\ud800-\udbff]$/);
    });
});

describe("batchesOf", () => {
    it("keeps each batch under the engine's text count and characters", () => {
        const batches = batchesOf(["aaaa", "bbbb", "cc", "d"], { maxTexts: 2, maxChars: 6 });
        expect(batches).toEqual([[0], [1, 2], [3]]);
    });
});

describe("translateInChunks", () => {
    it("translates a text far past any engine's limit in requests that fit it", async () => {
        const paragraph = "Una frase corta. ".repeat(200).trim();
        const text = Array.from({ length: 10 }, () => paragraph).join("\n\n");
        const limit = ENGINE_LIMITS.google;
        const send = vi.fn(async (batch: string[]) => {
            expect(batch.length).toBeLessThanOrEqual(limit.maxTexts);
            expect(batch.join("").length).toBeLessThanOrEqual(limit.maxChars);
            return { texts: batch.map((piece) => piece.toUpperCase()), detected: "es" };
        });
        const answer = await translateInChunks([text], limit, send);
        expect(send.mock.calls.length).toBeGreaterThan(1);
        expect(answer.texts[0]).toBe(text.toUpperCase());
        expect(answer.detected).toBe("es");
    });

    it("never sends blank texts and keeps their spacing", async () => {
        const send = vi.fn(async (batch: string[]) => ({
            texts: batch.map((text) => `<${text}>`),
            detected: null
        }));
        const answer = await translateInChunks(
            ["  hola \n", "   ", "adiós"],
            ENGINE_LIMITS.deepl,
            send
        );
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]![0]).toEqual(["hola", "adiós"]);
        expect(answer.texts).toEqual(["  <hola> \n", "   ", "<adiós>"]);
    });

    it("refuses an answer with the wrong number of texts", async () => {
        await expect(
            translateInChunks(["a", "b"], ENGINE_LIMITS.deepl, async () => ({
                texts: ["x"],
                detected: null
            }))
        ).rejects.toThrow();
    });
});
