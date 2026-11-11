/**
 * A tool call a small model wrote as text is taken out of what the answer
 * shows; every other tag an answer means stays.
 */

import { describe, expect, it } from "vitest";
import { withoutPseudoToolCalls } from "@/lib/polar/pseudo-tools";

describe("tool calls written as text", () => {
    it("are taken out with their arguments, closed or not", () => {
        expect(
            withoutPseudoToolCalls(
                '<polar_remember>{"text": "Hola a Javier"}</polar_remember>\n\n¡Hola! ¿En qué puedo ayudarte?'
            )
        ).toBe("¡Hola! ¿En qué puedo ayudarte?");
        expect(
            withoutPseudoToolCalls('<polar_remember> {"text": "La conversación empezó en español"}')
        ).toBe("");
        expect(withoutPseudoToolCalls('Done.\n<polar_forget>\n{"id": "x"}\n</polar_forget>')).toBe(
            "Done."
        );
    });

    it("hold back a tag still arriving at the end", () => {
        expect(withoutPseudoToolCalls("Hola <polar_rem")).toBe("Hola");
        expect(withoutPseudoToolCalls("Hola <")).toBe("Hola");
    });

    it("keep every other tag and plain text as it is", () => {
        const html = 'Use <div> and <span class="x"> here, or <polarity>.';
        expect(withoutPseudoToolCalls(html)).toBe(html);
        expect(withoutPseudoToolCalls("a < b and c > d")).toBe("a < b and c > d");
        expect(withoutPseudoToolCalls("plain")).toBe("plain");
    });
});
