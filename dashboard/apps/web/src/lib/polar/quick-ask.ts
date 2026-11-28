/**
 * Quick AI: a question typed in the search panel (the dashboard's palette and
 * Polaris Desktop's launcher) answered inside the panel, as Raycast's Quick AI
 * answers in its root search (https://manual.raycast.com/ai/quick-ai): Tab asks,
 * the answer streams in place, typing again asks a follow-up, and the exchange
 * can be carried into a real chat. Nothing is stored until it is.
 *
 * The model is Polar's own resolution (`resolvePolarModel`, the default free
 * model for somebody with no key) and there are no tools: a quick answer
 * never waits on an approval the panel has no room to ask for.
 *
 * Client-safe: the panel builds the request, the route validates it with the
 * same schema.
 */

import { z } from "zod";
import { modelChoiceSchema } from "@/lib/polar/shared";
import { decodePolarFailure, type FailureKind } from "@/lib/polar/provider-failure";

export const QUICK_ASK_QUESTION_MAX = 4000;
/** Longest answer kept from one turn, in characters. */
export const QUICK_ASK_ANSWER_MAX = 20_000;
/** Most turns of one quick conversation sent back with a follow-up. */
export const QUICK_ASK_TURNS_MAX = 40;

export const quickTurnSchema = z
    .object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(QUICK_ASK_ANSWER_MAX)
    })
    .strict();
export type QuickTurn = z.infer<typeof quickTurnSchema>;

export const quickAskRequestSchema = z
    .object({
        /** The conversation so far, oldest first, ending on the question asked. */
        turns: z
            .array(quickTurnSchema)
            .min(1)
            .max(QUICK_ASK_TURNS_MAX)
            .refine((turns) => {
                const last = turns.at(-1);
                return last?.role === "user" && last.text.trim().length > 0 && last.text.length <= QUICK_ASK_QUESTION_MAX;
            }),
        choice: modelChoiceSchema
    })
    .strict();
export type QuickAskRequest = z.input<typeof quickAskRequestSchema>;

/** "Continue in chat": the exchange, saved as a new chat of the caller's. */
export const quickContinueSchema = z
    .object({
        turns: z
            .array(quickTurnSchema)
            .min(1)
            .max(QUICK_ASK_TURNS_MAX)
            .refine((turns) => turns.some((turn) => turn.text.trim().length > 0))
    })
    .strict();

/** The instructions a quick answer runs under. */
export function quickAskSystem(): string {
    return [
        "You are Polar, answering a quick question somebody typed into their search bar.",
        "Answer directly and briefly: lead with the answer, then only the detail that helps.",
        "You have no tools for this answer: you cannot browse, search, read files or run commands.",
        "If the answer needs something you cannot know, say so plainly; never write out a tool call.",
        "Use Markdown where it helps, and fenced code blocks with a language for code."
    ].join(" ");
}

/** What a quick answer could not do, each with its own words on screen. */
export const QUICK_ASK_ERRORS = [
    "no_key",
    "unknown_model",
    "rate_limited",
    "usage_limit",
    "not_allowed",
    "offline",
    "failed",
    "provider_key",
    "provider_credit",
    "provider_paid",
    "provider_rate",
    "provider_busy",
    "provider_down",
    "provider_model",
    "subscription",
    "local"
] as const;
export type QuickAskError = (typeof QUICK_ASK_ERRORS)[number];

const PROVIDER_KINDS: Readonly<Record<FailureKind, QuickAskError>> = {
    key: "provider_key",
    credit: "provider_credit",
    paid: "provider_paid",
    rate: "provider_rate",
    busy: "provider_busy",
    down: "provider_down",
    model: "provider_model",
    other: "failed"
};

/** The error a route refusal names in its JSON body (`{ "error": code }`). */
const REFUSALS: Readonly<Record<string, QuickAskError>> = {
    no_key: "no_key",
    unknown_model: "unknown_model",
    unsupported_kind: "unknown_model",
    rate_limited: "rate_limited",
    usage_limit: "usage_limit",
    polar_not_allowed: "not_allowed",
    view_as: "not_allowed",
    unauthorized: "not_allowed"
};

/**
 * Why a quick answer failed, from what the chat client reports: a refusal's
 * JSON body before the stream, a provider failure encoded the way Polar's chat
 * encodes it (`encodePolarFailure`) during it, or nothing readable. Pure.
 */
export function quickAskErrorOf(message: string | undefined): { code: QuickAskError; provider: string | null } {
    const text = message?.trim() ?? "";
    const failure = decodePolarFailure(text);
    if (failure?.code === "provider") return { code: PROVIDER_KINDS[failure.kind], provider: failure.provider };
    try {
        const body = JSON.parse(text) as { error?: unknown; code?: unknown };
        // The person's own Claude subscription, or a model on their own computer.
        if (body.code === "subscription" || body.code === "local") return { code: body.code, provider: null };
        if (typeof body.error === "string" && REFUSALS[body.error]) return { code: REFUSALS[body.error]!, provider: null };
    } catch {
        // Not a JSON refusal.
    }
    if (/failed to fetch|network|load failed/i.test(text)) return { code: "offline", provider: null };
    return { code: "failed", provider: null };
}

/** The question and answers of a conversation as the route takes them. Pure. */
export function quickTurns(messages: readonly { role: string; parts: readonly { type: string; text?: string }[] }[]): QuickTurn[] {
    return messages
        .filter((message): message is typeof message & { role: QuickTurn["role"] } => message.role === "user" || message.role === "assistant")
        .map((message) => ({
            role: message.role,
            text: message.parts
                .filter((part) => part.type === "text" && typeof part.text === "string")
                .map((part) => part.text)
                .join("")
                .slice(0, QUICK_ASK_ANSWER_MAX)
        }))
        .filter((turn) => turn.text.trim().length > 0)
        .slice(-QUICK_ASK_TURNS_MAX);
}
