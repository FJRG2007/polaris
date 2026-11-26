import { describe, expect, it } from "vitest";
import { elicitationQuestions, elicitationReply } from "@/lib/agents/acp/elicitation";

/** One question, as the adapter sends it: the question is the form's message. */
const SINGLE = {
    mode: "form",
    sessionId: "sess-1",
    message: "Which framework?",
    requestedSchema: {
        type: "object",
        properties: {
            question_0: {
                type: "string",
                title: "Framework",
                oneOf: [
                    { const: "React", title: "React", description: "Components", _meta: { "_claude/askUserQuestionOption": { preview: "jsx" } } },
                    { const: "Vue", title: "Vue" }
                ]
            },
            question_0_custom: { type: "string", title: "Other" }
        }
    }
};

describe("AskUserQuestion forms", () => {
    it("reads a single question from the form's message, an option's preview from its _meta", () => {
        expect(elicitationQuestions(SINGLE)).toEqual([
            {
                question: "Which framework?",
                header: "Framework",
                multiSelect: false,
                options: [{ label: "React", description: "Components", preview: "jsx" }, { label: "Vue" }]
            }
        ]);
    });

    it("refuses URL forms, other fields and empty options", () => {
        expect(elicitationQuestions({ ...SINGLE, mode: "url" })).toBeNull();
        expect(
            elicitationQuestions({ ...SINGLE, requestedSchema: { type: "object", properties: { token: { type: "string" } } } })
        ).toBeNull();
        expect(
            elicitationQuestions({
                ...SINGLE,
                requestedSchema: { type: "object", properties: { question_0: { type: "string", oneOf: [] } } }
            })
        ).toBeNull();
        expect(elicitationQuestions(null)).toBeNull();
    });

    it("answers a pick, an Other text, a skip, a message sent instead, and no answer", () => {
        const questions = elicitationQuestions(SINGLE)!;
        expect(elicitationReply(questions, "allow", { answers: { "Which framework?": "Vue" } })).toEqual({
            action: "accept",
            content: { question_0: "Vue" }
        });
        expect(elicitationReply(questions, "allow", { answers: { "Which framework?": "Svelte" } })).toEqual({
            action: "accept",
            content: { question_0_custom: "Svelte" }
        });
        expect(elicitationReply(questions, "deny", {})).toEqual({ action: "decline" });
        expect(elicitationReply(questions, "deny", { feedback: "Use Svelte" })).toEqual({
            action: "accept",
            content: { question_0_custom: "Use Svelte" }
        });
        expect(elicitationReply(questions, "expired", undefined)).toEqual({ action: "cancel" });
    });

    it("skips several questions set aside by a message, which follows as its own", () => {
        const two = [
            { question: "A?", options: [{ label: "x" }] },
            { question: "B?", options: [{ label: "y" }] }
        ];
        expect(elicitationReply(two, "deny", { feedback: "neither" })).toEqual({ action: "decline" });
    });
});
