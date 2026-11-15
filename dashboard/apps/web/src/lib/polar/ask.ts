/**
 * Polar asking the person a question with options, the way Claude Code's
 * AskUserQuestion does (https://code.claude.com/docs/en/tools-reference): the
 * model calls `polar_ask`, the turn ends on that call, and the card above the
 * composer answers it. The answer is the call's output, added on the client
 * with `addToolOutput`, and the turn then carries on from it.
 *
 * Nothing is kept anywhere but the message itself: a call with no output yet
 * is the question still waiting, so a reload, or the same chat opened on
 * another device, shows the card again. A person who writes a message instead
 * of answering settles the call as unanswered (`settleUnansweredAsks`), so the
 * model never reads a call with no result.
 *
 * Client-safe: no database, no provider.
 */

import { z } from "zod";
import { MAX_ANSWER_CHARS, MAX_QUESTIONS, questionSchema, type AskQuestion } from "@/lib/agents/session-asks";

export const POLAR_ASK_TOOL = "polar_ask";

export const polarAskInputSchema = z.object({
    questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS)
});
export type PolarAskInput = z.infer<typeof polarAskInputSchema>;

export const polarAskOutputSchema = z.discriminatedUnion("status", [
    z.object({
        status: z.literal("answered"),
        /** Question text to the chosen label(s) or typed answer. */
        answers: z.record(z.string().max(500), z.string().trim().max(MAX_ANSWER_CHARS))
    }),
    /** The person pressed Skip. */
    z.object({ status: z.literal("skipped") }),
    /** The person wrote the next message instead of answering. */
    z.object({ status: z.literal("unanswered") })
]);
export type PolarAskOutput = z.infer<typeof polarAskOutputSchema>;

interface PartLike {
    type: string;
    state?: string;
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
}

interface MessageLike {
    role: string;
    parts: readonly unknown[];
}

export function isAskPart(part: { type?: unknown } | null | undefined): boolean {
    return part?.type === `tool-${POLAR_ASK_TOOL}`;
}

/** A call's questions, or null when the model sent something else. */
export function askQuestionsOf(input: unknown): AskQuestion[] | null {
    const parsed = polarAskInputSchema.safeParse(input);
    return parsed.success ? parsed.data.questions : null;
}

/** A call's answer, or null while it waits. */
export function askOutputOf(output: unknown): PolarAskOutput | null {
    const parsed = polarAskOutputSchema.safeParse(output);
    return parsed.success ? parsed.data : null;
}

/** The question waiting on the person: the newest message's open call, or null. */
export function pendingAsk(
    messages: readonly MessageLike[]
): { toolCallId: string; questions: AskQuestion[] } | null {
    const last = messages.at(-1);
    if (last?.role !== "assistant") return null;
    for (const raw of last.parts) {
        const part = raw as PartLike;
        if (!isAskPart(part) || part.state !== "input-available" || !part.toolCallId) continue;
        const questions = askQuestionsOf(part.input);
        if (questions) return { toolCallId: part.toolCallId, questions };
    }
    return null;
}

/**
 * Every open call that a later message has moved past, settled as
 * unanswered. Only the newest message may still hold an open call: that one is
 * the question on screen.
 */
export function settleUnansweredAsks<T extends MessageLike>(messages: readonly T[]): T[] {
    return messages.map((message, index) => {
        if (message.role !== "assistant" || index === messages.length - 1) return message;
        let changed = false;
        const parts = message.parts.map((raw) => {
            const part = raw as PartLike;
            if (!isAskPart(part) || part.state !== "input-available") return raw;
            changed = true;
            const output: PolarAskOutput = { status: "unanswered" };
            return { ...part, state: "output-available", output };
        });
        return changed ? { ...message, parts } : message;
    });
}

/**
 * Whether the newest answer's last step ended on a question that now has its
 * answer and nothing else in that step still waits: the turn goes on from it.
 * Narrower than the SDK's `lastAssistantMessageIsCompleteWithToolCalls`, which
 * would also resend a turn that merely ran out of steps on a finished tool.
 */
export function askAnswered(messages: readonly MessageLike[]): boolean {
    const last = messages.at(-1);
    if (last?.role !== "assistant") return false;
    const parts = last.parts as readonly PartLike[];
    let start = -1;
    for (let index = parts.length - 1; index >= 0; index--) {
        if (parts[index]?.type === "step-start") {
            start = index;
            break;
        }
    }
    const step = parts.slice(start + 1);
    const tools = step.filter((part) => part.type.startsWith("tool-") || part.type === "dynamic-tool");
    return (
        tools.some((part) => isAskPart(part) && part.state === "output-available") &&
        tools.every((part) => part.state === "output-available" || part.state === "output-error")
    );
}
