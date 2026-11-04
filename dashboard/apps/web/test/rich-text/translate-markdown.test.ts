/**
 * Translating what was typed keeps everything that is not words: formatting,
 * links, mentions of people, a space's emoji, `@everyone`, and code.
 */

import { describe, expect, it, vi } from "vitest";
import type { TranslationOutcome } from "@/lib/text-translation/queue";
import { translateMarkdown } from "@/components/rich-text/translate-markdown";

const USER = "0190a1b2-0000-7000-8000-00000000000a";
const EMOJI = "0190a1b2-0000-7000-8000-00000000000b";

const WORDS: Record<string, string> = {
    Hello: "Hola",
    "and look at": "y mira",
    "the plan": "el plan",
    "before you run": "antes de ejecutar"
};

function dictionary() {
    return vi.fn(async (text: string): Promise<TranslationOutcome> =>
        WORDS[text] ? { kind: "translated", text: WORDS[text]!, detected: "en" } : { kind: "same" }
    );
}

describe("translating written Markdown", () => {
    it("translates the words and keeps the marks, the mention, the emoji and the code", async () => {
        const translate = dictionary();
        const typed = `**Hello** [@Ana Ruiz](polaris:user/${USER}) <:wave:${EMOJI}> @everyone and look at [the plan](https://example.com/plan) before you run \`npm test\``;
        const outcome = await translateMarkdown(typed, translate);

        expect(outcome).toEqual({
            kind: "translated",
            text: `**Hola** [@Ana Ruiz](polaris:user/${USER}) <:wave:${EMOJI}> @everyone y mira [el plan](https://example.com/plan) antes de ejecutar \`npm test\``,
            detected: "en"
        });
        const asked = translate.mock.calls.map(([text]) => text);
        // Nothing that is not words went out to be translated.
        expect(asked).not.toContain("npm test");
        expect(asked.some((text) => text.includes("Ana") || text.includes("wave"))).toBe(false);
        expect(asked.some((text) => text.includes("@everyone"))).toBe(false);
    });

    it("leaves a code block exactly as written", async () => {
        const translate = dictionary();
        const typed = "Hello\n\n```sh\nHello\n```";
        const outcome = await translateMarkdown(typed, translate);
        expect(outcome.kind === "translated" && outcome.text).toBe("Hola\n\n```sh\nHello\n```");
        expect(translate).toHaveBeenCalledTimes(1);
    });

    it("is the same when nothing changed language", async () => {
        const outcome = await translateMarkdown("**Bonjour** tout le monde", dictionary());
        expect(outcome).toEqual({ kind: "same" });
    });

    it("fails whole when any part fails, rather than sending half of it translated", async () => {
        const translate = vi.fn(async (text: string): Promise<TranslationOutcome> =>
            text === "the plan"
                ? { kind: "failed", message: null }
                : { kind: "translated", text: "x", detected: "en" }
        );
        const outcome = await translateMarkdown("Hello **the plan**", translate);
        expect(outcome.kind).toBe("failed");
    });

    it("asks once for words that appear twice", async () => {
        const translate = dictionary();
        await translateMarkdown("Hello\n\n*Hello*", translate);
        expect(translate).toHaveBeenCalledTimes(1);
    });
});
