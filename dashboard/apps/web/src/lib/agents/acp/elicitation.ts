/**
 * Claude Code's AskUserQuestion over the Agent Client Protocol: the adapter
 * (@agentclientprotocol/claude-agent-acp, src/elicitation.ts
 * `askUserQuestionsToCreateRequest` / `applyAskElicitationResponse`) enables
 * the tool only for a client that advertises form elicitation, and then puts
 * the questions as one `elicitation/create` form:
 *
 * - `question_N`: a string with `oneOf` options, or an array whose
 *   `items.anyOf` are the options for a multiple choice. Each option is
 *   `{ const: label, title: label, description? }`. Its `title` is the
 *   question's header; its `description` the question, except for a single
 *   question, which is the form's `message`.
 * - `question_N_custom`: the "Other" free text, beside or instead of a pick.
 *
 * The answer is `accept` with those fields, `decline` (the questions skipped,
 * the agent carries on) or `cancel` (the tool call aborted).
 *
 * Here the form is read back into the questions the session already shows
 * for a terminal session's AskUserQuestion hook (`session-asks.ts`), so one
 * card answers both, and the card's answer is turned back into the form's
 * fields. Any other form (an MCP server's own) is not one Polaris can draw,
 * and is cancelled. Pure.
 */

import { z } from "zod";
import type { PermissionStatus } from "../session-permissions";
import { MAX_OPTIONS, MAX_QUESTIONS, questionSchema, type AskQuestion } from "../session-asks";

/** What the agent gets back: the protocol's `CreateElicitationResponse`. */
export type ElicitationReply =
    | { action: "accept"; content: Record<string, string | string[]> }
    | { action: "decline" }
    | { action: "cancel" };

const optionSchema = z.object({
    const: z.string(),
    title: z.string().optional(),
    description: z.string().optional()
});

const fieldSchema = z.object({
    type: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    oneOf: z.array(optionSchema).optional(),
    items: z.object({ anyOf: z.array(optionSchema) }).optional()
});

const formSchema = z.object({
    mode: z.literal("form"),
    message: z.string(),
    requestedSchema: z.object({ properties: z.record(z.string(), z.unknown()) })
});

const FIELD = /^question_(\d+)(_custom)?$/;

/**
 * The questions an `elicitation/create` request asks, or null when it is not
 * an AskUserQuestion form (another shape, a URL elicitation, or more than the
 * card holds). Pure.
 */
export function elicitationQuestions(params: unknown): AskQuestion[] | null {
    const form = formSchema.safeParse(params);
    if (!form.success) return null;
    const properties = form.data.requestedSchema.properties;
    const keys = Object.keys(properties);
    if (keys.length === 0 || keys.some((key) => !FIELD.test(key))) return null;
    const count = keys.filter((key) => !key.endsWith("_custom")).length;
    if (count === 0 || count > MAX_QUESTIONS) return null;
    const questions: AskQuestion[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < count; index++) {
        const field = fieldSchema.safeParse(properties[`question_${index}`]);
        if (!field.success) return null;
        const multiSelect = field.data.type === "array";
        const options = multiSelect ? field.data.items?.anyOf : field.data.oneOf;
        if (!options || options.length === 0 || options.length > MAX_OPTIONS) return null;
        let text = (field.data.description ?? (count === 1 ? form.data.message : field.data.title ?? form.data.message)).trim();
        // The card keys its answers by the question's text.
        if (seen.has(text)) text = `${text} (${index + 1})`;
        seen.add(text);
        const parsed = questionSchema.safeParse({
            question: text.slice(0, 500),
            ...(field.data.title?.trim() ? { header: field.data.title.trim().slice(0, 60) } : {}),
            multiSelect,
            options: options.map((option) => ({
                label: option.const.slice(0, 200),
                ...(option.description ? { description: option.description.slice(0, 500) } : {})
            }))
        });
        if (!parsed.success) return null;
        questions.push(parsed.data);
    }
    return questions;
}

/** A multiple choice's answer read back into its picks and what was typed:
 *  the card joins both with ", " (`answerText`). Pure. */
function splitPicks(answer: string, labels: readonly string[]): { picks: string[]; custom: string } {
    const picks: string[] = [];
    const rest: string[] = [];
    for (const part of answer.split(", ")) {
        const piece = part.trim();
        if (!piece) continue;
        if (labels.includes(piece) && !picks.includes(piece)) picks.push(piece);
        else rest.push(piece);
    }
    return { picks, custom: rest.join(", ") };
}

/**
 * The form's answer for the person's answer on the card. An answer is
 * `accept`; a skip is `decline`, unless it carries what the person typed
 * instead and there is one question - then that text is the question's
 * "Other" answer, as Claude Code takes a message typed at its question. No
 * answer in time is `cancel`. Pure.
 */
export function elicitationReply(
    questions: readonly AskQuestion[],
    status: PermissionStatus,
    answer: unknown
): ElicitationReply {
    const given = answer && typeof answer === "object" ? (answer as { answers?: unknown; feedback?: unknown }) : {};
    if (status === "deny") {
        const feedback = typeof given.feedback === "string" ? given.feedback.trim() : "";
        if (feedback && questions.length === 1) return { action: "accept", content: { question_0_custom: feedback } };
        return { action: "decline" };
    }
    if (status !== "allow" && status !== "always") return { action: "cancel" };
    const answers =
        given.answers && typeof given.answers === "object" ? (given.answers as Record<string, unknown>) : {};
    const content: Record<string, string | string[]> = {};
    questions.forEach((question, index) => {
        const raw = answers[question.question];
        const text = typeof raw === "string" ? raw.trim() : "";
        if (!text) return;
        const labels = question.options.map((option) => option.label);
        if (question.multiSelect) {
            const { picks, custom } = splitPicks(text, labels);
            if (picks.length > 0) content[`question_${index}`] = picks;
            if (custom) content[`question_${index}_custom`] = custom;
            return;
        }
        if (labels.includes(text)) content[`question_${index}`] = text;
        else content[`question_${index}_custom`] = text;
    });
    return { action: "accept", content };
}
