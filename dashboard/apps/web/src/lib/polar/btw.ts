/**
 * `/btw`: a side question about the chat, answered from what the conversation
 * already holds, as Claude Code's is
 * (https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw):
 * it runs while a turn is on its way without interrupting it, sees everything
 * so far except the reply still being written, has no tools, and neither the
 * question nor the answer enters the conversation. Earlier side questions are
 * replayed with each ask, newest 20, until they are cleared.
 *
 * Client-safe: the screen builds the context it holds (the turn on its way is
 * not stored until it ends), the route validates it with the same schema.
 */

import { z } from "zod";
import { modelChoiceSchema } from "@/lib/polar/shared";
import { compactionTranscript, splitAtCompaction } from "@/lib/polar/compaction";

export const POLAR_BTW_QUESTION_MAX = 4000;
/** Longest answer kept, in characters. */
export const POLAR_BTW_ANSWER_MAX = 20_000;
/** Earlier side questions replayed with each ask, as Claude Code does. */
export const POLAR_BTW_EARLIER_MOST = 20;
/** Earlier side questions listed above the current answer. */
export const POLAR_BTW_EARLIER_SHOWN = 5;
/** Longest conversation context one side question sends, in characters. */
export const POLAR_BTW_CONTEXT_MAX = 200_000;

/** The question Polar asks itself for `/recap`, answered the same way. */
export const POLAR_RECAP_QUESTION =
    "Recap this conversation so far in one or two short sentences: what was asked, what was done and what is still open.";

export const btwExchangeSchema = z
    .object({
        question: z.string().trim().min(1).max(POLAR_BTW_QUESTION_MAX),
        answer: z.string().max(POLAR_BTW_ANSWER_MAX)
    })
    .strict();
export type BtwExchange = z.infer<typeof btwExchangeSchema>;

export const btwRequestSchema = z
    .object({
        question: z.string().trim().min(1).max(POLAR_BTW_QUESTION_MAX),
        /** The chat's transcript as the screen holds it (`btwContext`). */
        context: z.string().max(POLAR_BTW_CONTEXT_MAX),
        earlier: z.array(btwExchangeSchema).max(POLAR_BTW_EARLIER_MOST).default([]),
        choice: modelChoiceSchema,
        threadId: z.string().uuid().nullable().default(null)
    })
    .strict();
export type BtwRequest = z.input<typeof btwRequestSchema>;

type Part = { type: string; [key: string]: unknown };
type MessageLike = { role: string; parts: readonly Part[]; metadata?: unknown };

/** What a reply still being written leaves out: its words. The tool results it
 *  has gathered so far stay, as Claude Code's side question sees them. */
const WRITING = new Set(["text", "reasoning"]);

/**
 * The conversation a side question reads: the visible path from its newest
 * compaction on, the reply still on its way without its words, cut to the
 * newest `POLAR_BTW_CONTEXT_MAX` characters. Pure.
 */
export function btwContext(messages: readonly MessageLike[], writing: boolean): string {
    const last = messages.at(-1);
    const held =
        writing && last?.role === "assistant"
            ? [...messages.slice(0, -1), { ...last, parts: last.parts.filter((part) => !WRITING.has(part.type)) }]
            : [...messages];
    const { summary, messages: since } = splitAtCompaction(held.filter((message) => message.parts.length > 0));
    const text = compactionTranscript(summary, since);
    return text.length > POLAR_BTW_CONTEXT_MAX ? text.slice(-POLAR_BTW_CONTEXT_MAX) : text;
}

/** The newest exchanges replayed with the next ask. */
export function replayed<T extends BtwExchange>(earlier: readonly T[]): T[] {
    return earlier.slice(-POLAR_BTW_EARLIER_MOST);
}

/** The instructions a side question runs under. */
export function btwSystem(): string {
    return [
        "You are Polar, answering a side question the person asked while looking at the conversation below.",
        "You have no tools for this answer: you cannot read files, run commands, browse or search.",
        "Answer only from what the conversation and the earlier side questions already hold.",
        "If the answer is not there, say so plainly and say what would have to be looked up; never write out a tool call.",
        "Be brief and direct. Use Markdown only where it helps."
    ].join(" ");
}

/** The prompt a side question sends: the conversation, the earlier side
 *  questions, then this one. */
export function btwPrompt(context: string, earlier: readonly BtwExchange[], question: string): string {
    const pieces = [`Conversation so far:\n${context.trim() || "(nothing yet)"}`];
    if (earlier.length > 0) {
        const lines = earlier.map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`);
        pieces.push(`Earlier side questions:\n${lines.join("\n\n")}`);
    }
    pieces.push(`Side question:\n${question}`);
    return pieces.join("\n\n");
}
