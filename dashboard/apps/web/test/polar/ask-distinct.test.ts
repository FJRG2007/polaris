import { describe, expect, it } from "vitest";
import { distinctQuestions, polarAskInputSchema } from "@/lib/polar/ask";
import { polarInputSchema } from "@/lib/polar/tool-input";

// The tool input Mistral Nemo streamed for "dame opciones de prueba a elegir",
// joined from its argument deltas: the same question twice, escapes as JSON.
const DELTAS = [
    '{"questions":[{"question":"\u00bfQu\u00e9 opci',
    '\u00f3n prefieres?","options":[{"label":"A"},{"label":"B"}]},',
    '{"question":"\u00bfQu\u00e9 opci\u00f3n prefieres?","options":[{"label":"A"},{"label":"B"}]}]}'
];

describe("the questions of one call", () => {
    it("decodes the escapes once and keeps a question asked twice once", async () => {
        const written = JSON.parse(DELTAS.join(""));
        const checked = await polarInputSchema(polarAskInputSchema, distinctQuestions).validate!(written);
        expect(checked.success).toBe(true);
        const questions = (checked as { value: { questions: Array<{ question: string }> } }).value.questions;
        expect(questions).toHaveLength(1);
        expect(questions[0]!.question).toBe("¿Qué opción prefieres?");
    });

    it("keeps different questions and the call untouched when nothing repeats", () => {
        const call = { questions: [{ question: "Uno" }, { question: "Dos" }] };
        expect(distinctQuestions(call)).toBe(call);
        expect(distinctQuestions({ questions: [{ question: "Uno" }, { question: " uno " }] })).toEqual({
            questions: [{ question: "Uno" }]
        });
    });
});
