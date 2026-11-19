/**
 * An answer to `@polar` that is only its own prompt handed back - the
 * transcript continued, the question repeated - is told from a real reply.
 */

import { describe, expect, it } from "vitest";
import { echoesPrompt } from "@/lib/polar/mention-echo";
import { mentionPrompt } from "@/lib/chat/polar-mention";

const history = [
    { name: "Ana", text: "Alguien ha visto el despliegue de ayer?" },
    { name: "Javier", text: "Creo que salió bien" }
];
const prompt = mentionPrompt(history, "Javier", "@polar que tgal?");
const context = { prompt, question: "que tgal?", names: ["Javier", "Ana"] };

describe("an echoed mention answer", () => {
    it("is the asker's line handed back", () => {
        expect(echoesPrompt("Javier: @polar que tgal?", context)).toBe(true);
        expect(echoesPrompt("**Javier:** que tgal?", context)).toBe(true);
    });

    it("is the question repeated, or the conversation copied", () => {
        expect(echoesPrompt("@polar que tgal?", context)).toBe(true);
        expect(echoesPrompt("Ana: Alguien ha visto el despliegue de ayer?\nJavier: Creo que salió bien", context)).toBe(true);
        expect(echoesPrompt("Alguien ha visto el despliegue de ayer?", context)).toBe(true);
    });

    it("is not a real reply, short or long", () => {
        expect(echoesPrompt("¡Todo bien por aquí! ¿Y tú qué tal?", context)).toBe(false);
        expect(echoesPrompt("Hola", context)).toBe(false);
        expect(echoesPrompt("Sí, el despliegue de ayer salió bien según Javier.", context)).toBe(false);
        expect(echoesPrompt("", context)).toBe(false);
    });
});

describe("the mention prompt", () => {
    it("sets the question apart, without the mention, after the conversation", () => {
        expect(prompt).toContain('<question from="Javier">\nque tgal?\n</question>');
        expect(prompt).not.toContain("Javier asks:");
        expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("<question"));
        // The last line is what to do, never a `Name: text` line to continue.
        expect(prompt.trim().split("\n").at(-1)).toMatch(/^Reply to Javier/);
    });

    it("keeps a name from breaking out of the question's attribute", () => {
        expect(mentionPrompt([], 'Eve"><x', "@polar hola")).toContain('<question from="Eve   x">');
    });
});
