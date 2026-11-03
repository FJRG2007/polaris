/**
 * A long text sends only the paragraphs not translated yet, and a server
 * refusal reaches the caller with its code and the wait it asked for.
 */

import { describe, expect, it, vi } from "vitest";
import { ServerEngineError } from "@polaris-app/translate/src/screens/server-engine";
import {
    runTranslation,
    translateReusing,
    type PieceCache,
    type Translate
} from "@polaris-app/translate/src/screens/run";
import type { TranslateEngine } from "@polaris-app/translate/src/model/engines";

function upper(): Translate & ReturnType<typeof vi.fn> {
    return vi.fn(async (texts: string[]) => ({
        texts: texts.map((text) => text.toUpperCase()),
        detected: "en",
        engine: "deepl" as const
    }));
}

describe("translateReusing", () => {
    it("sends only the paragraphs an edit changed and keeps the spacing", async () => {
        const translate = upper();
        const cache: PieceCache = { owner: null, pieces: new Map() };
        const first = await translateReusing("one\n\ntwo\n\n\nthree", cache, translate);
        expect(first.text).toBe("ONE\n\nTWO\n\n\nTHREE");
        expect(translate).toHaveBeenLastCalledWith(["one", "two", "three"], undefined);

        const second = await translateReusing("one\n\ntwo!\n\n\nthree", cache, translate);
        expect(second.text).toBe("ONE\n\nTWO!\n\n\nTHREE");
        expect(translate).toHaveBeenLastCalledWith(["two!"], undefined);
        expect(second.answer?.engine).toBe("deepl");

        const third = await translateReusing("one\n\nthree", cache, translate);
        expect(third.text).toBe("ONE\n\nTHREE");
        expect(third.answer).toBeNull();
        expect(translate).toHaveBeenCalledTimes(2);
    });

    it("starts over for another way of translating", async () => {
        const cache: PieceCache = { owner: null, pieces: new Map() };
        await translateReusing("one", cache, upper());
        const other = upper();
        await translateReusing("one", cache, other);
        expect(other).toHaveBeenCalledWith(["one"], undefined);
    });
});

describe("runTranslation", () => {
    it("throws the server's refusal itself, with its code and wait", async () => {
        const engine: TranslateEngine = {
            id: "deepl",
            translate: async () => {
                throw new ServerEngineError("rate", "Too many", 60);
            },
            detect: async () => null
        };
        const failed = runTranslation(["hi"], {
            engines: new Map([["deepl", engine]]),
            order: ["deepl"],
            from: null,
            to: "es",
            charLimit: null,
            fallback: "Failed",
            overLimit: () => "Over"
        });
        await expect(failed).rejects.toMatchObject({ code: "rate", retryAfter: 60, message: "Too many" });
    });
});
