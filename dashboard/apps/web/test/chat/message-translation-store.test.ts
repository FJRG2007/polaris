/**
 * A translation the reader asked for from a message's menu stays the one on
 * screen. Live translation reads into the reader's own language, the menu into
 * the language last picked; when those differ, the message coming back into
 * view used to swap the asked translation for a live one - the text was shown,
 * taken away and translated again.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslationOutcome } from "@/lib/text-translation/queue";
import {
    resetMessageTranslations,
    translateMessage,
    translationOf
} from "@/app/(app)/chat/message-translation";

const settle = () => new Promise((done) => setTimeout(done, 0));

function translator() {
    return vi.fn(
        async (text: string, to: string): Promise<TranslationOutcome> => ({
            kind: "translated",
            text: `${to}:${text}`,
            detected: "es"
        })
    );
}

afterEach(() => resetMessageTranslations());

describe("a translation asked for from the menu", () => {
    it("is not replaced by live translation into another language", async () => {
        const translate = translator();
        translateMessage("m1", "hola", "hola", "en", translate, "menu");
        await settle();
        translateMessage("m1", "hola", "hola", "fr", translate, "live");
        await settle();
        expect(translate).toHaveBeenCalledTimes(1);
        const entry = translationOf("m1", "hola");
        expect(entry?.to).toBe("en");
        expect(entry?.state).toEqual({
            phase: "done",
            outcome: { kind: "translated", text: "en:hola", detected: "es" }
        });
    });

    it("is not replaced while it is still out either", async () => {
        const translate = translator();
        translateMessage("m1", "hola", "hola", "en", translate, "menu");
        translateMessage("m1", "hola", "hola", "fr", translate, "live");
        await settle();
        expect(translate).toHaveBeenCalledTimes(1);
        expect(translationOf("m1", "hola")?.to).toBe("en");
    });

    it("can still be asked again from the menu in another language", async () => {
        const translate = translator();
        translateMessage("m1", "hola", "hola", "en", translate, "menu");
        await settle();
        translateMessage("m1", "hola", "hola", "fr", translate, "menu");
        await settle();
        expect(translate).toHaveBeenCalledTimes(2);
        expect(translationOf("m1", "hola")?.to).toBe("fr");
    });
});
