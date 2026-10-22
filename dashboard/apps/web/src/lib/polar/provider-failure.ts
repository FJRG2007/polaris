/**
 * What a provider's refusal means, in words the person reading Polar can act on.
 *
 * A provider that refuses a call answers with a status and a body of its own
 * making - Cerebras's 402 `payment_required_error` that says "Visit your billing
 * tab", OpenAI's 429 `insufficient_quota`, Anthropic's 400 "credit balance is
 * too low". The body is read here only to tell those apart and is never shown:
 * it names internals, and sometimes the account it belongs to.
 *
 * Isomorphic: the route classifies and encodes, the panel decodes and words it.
 */

import { z } from "zod";
import type { UIMessage } from "ai";

export const FAILURE_KINDS = ["key", "credit", "rate", "down", "model", "other"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface ProviderFailure {
    kind: FailureKind;
    status: number | null;
}

/** Out of credit, whatever status the provider chose to say it with. */
const CREDIT =
    /payment[_ ]required|insufficient[_ ](quota|funds|balance|credits?)|credit balance|billing|out of credits/i;
/** The model asked for is not one the provider serves. */
const MODEL =
    /model[_ ]not[_ ]found|no such model|unknown model|model\b[^.]{0,80}\b(not found|does not exist|is not supported)/i;

interface CallErrorShape {
    statusCode?: unknown;
    responseBody?: unknown;
    message?: unknown;
    lastError?: unknown;
    cause?: unknown;
}

/** The innermost error that carries a status: a retry wraps its last attempt. */
function callError(error: unknown, depth = 0): CallErrorShape | null {
    if (typeof error !== "object" || error === null || depth > 4) return null;
    const shape = error as CallErrorShape;
    if (typeof shape.statusCode === "number") return shape;
    return callError(shape.lastError, depth + 1) ?? callError(shape.cause, depth + 1);
}

/** Pure. Anything that is not a provider's answer is `other`. */
export function classifyProviderFailure(error: unknown): ProviderFailure {
    const found = callError(error);
    if (!found) return { kind: "other", status: null };
    const status = found.statusCode as number;
    const said = `${typeof found.responseBody === "string" ? found.responseBody : ""} ${
        typeof found.message === "string" ? found.message : ""
    }`;
    if (status === 402 || CREDIT.test(said)) return { kind: "credit", status };
    if (status === 401 || status === 403) return { kind: "key", status };
    if (status === 404 || MODEL.test(said)) return { kind: "model", status };
    if (status === 429) return { kind: "rate", status };
    if (status >= 500) return { kind: "down", status };
    return { kind: "other", status };
}

/** What the stream's error part carries to the panel. */
export const polarFailureSchema = z.object({
    code: z.literal("provider"),
    kind: z.enum(FAILURE_KINDS),
    /** The provider's display name, as the picker shows it. */
    provider: z.string().max(80),
    /** Its integration slug, so the panel can offer a model elsewhere. */
    slug: z.string().max(64),
    /** Whose key was spent: the reader's own, or the deployment's. */
    payer: z.enum(["own", "instance"])
});
export type PolarFailure = z.infer<typeof polarFailureSchema>;

export function encodePolarFailure(failure: PolarFailure): string {
    return JSON.stringify(failure);
}

/** The failure a stream reported, or null for anything else - an older build's
 *  bare `polar_failed`, a dropped connection. */
export function decodePolarFailure(text: string | undefined): PolarFailure | null {
    if (!text) return null;
    try {
        const parsed = polarFailureSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** A turn refused because its chat is still answering the one before (409 `running`). */
export interface RunningRefusal {
    code: "running";
}

const runningRefusalSchema = z.object({ error: z.literal("running") });

/** Why a send got no answer at all: a provider's refusal, the chat still
 *  answering, or null for anything else. */
export function decodeLooseFailure(text: string | undefined): PolarFailure | RunningRefusal | null {
    const failure = decodePolarFailure(text);
    if (failure || !text) return failure;
    try {
        return runningRefusalSchema.safeParse(JSON.parse(text)).success
            ? { code: "running" }
            : null;
    } catch {
        return null;
    }
}

/**
 * Why a turn has no answer, kept in the conversation as a part of the answer it
 * replaced, so a reload, another device and the chat's history all show it.
 * A provider's refusal, the shared key's ceiling, or a file the model could not
 * be handed.
 */
export const storedFailureSchema = z.discriminatedUnion("code", [
    polarFailureSchema,
    z.object({
        code: z.literal("usage_limit"),
        used: z.number().nonnegative(),
        amount: z.number().nonnegative(),
        period: z.enum(["day", "week", "month"])
    }),
    z.object({ code: z.literal("file_unreadable"), name: z.string().max(255) }),
    z.object({ code: z.literal("too_many_runs"), max: z.number().int().min(1).max(100) })
]);
export type StoredFailure = z.infer<typeof storedFailureSchema>;

/** The message part a failure is stored as. */
export const FAILURE_PART = "data-polar-failure";

type Part = UIMessage["parts"][number];

function isFailurePart(part: Part): boolean {
    return part.type === FAILURE_PART;
}

/** The failure a message part carries, or null for any other part or a stored
 *  one that no longer reads. */
export function failureOf(part: Part): StoredFailure | null {
    if (!isFailurePart(part)) return null;
    const parsed = storedFailureSchema.safeParse((part as { data?: unknown }).data);
    return parsed.success ? parsed.data : null;
}

/** The failure a message ends with, if any. */
export function messageFailure(message: UIMessage | undefined): StoredFailure | null {
    for (const part of [...(message?.parts ?? [])].reverse()) {
        const failure = failureOf(part);
        if (failure) return failure;
    }
    return null;
}

/**
 * The conversation as a model may read it: failures are for the person, not the
 * model, and an answer that held nothing but one is left out entirely - a
 * provider refuses an empty assistant message.
 */
export function withoutFailures<T extends UIMessage>(messages: readonly T[]): T[] {
    return messages.flatMap((message) => {
        if (!message.parts.some(isFailurePart)) return [message];
        const parts = message.parts.filter((part) => !isFailurePart(part));
        const empty = parts.every((part) => part.type === "step-start");
        return message.role === "assistant" && empty ? [] : [{ ...message, parts }];
    });
}

/**
 * The parts to store for a message whose row already holds `stored`: a failure
 * the row keeps survives a later turn re-sending the message without it, from a
 * screen that never received it.
 */
export function keepStoredFailures(incoming: readonly Part[], stored: unknown): Part[] {
    if (incoming.some(isFailurePart) || !Array.isArray(stored)) return [...incoming];
    const kept = (stored as Part[]).filter(
        (part) => !!part && typeof part === "object" && failureOf(part) !== null
    );
    return [...incoming, ...kept];
}

/** One log line for a failed call: provider, status and kind, never the body
 *  or a stack, so a key that keeps failing does not bury the log. */
export function failureLogLine(what: string, provider: string, failure: ProviderFailure): string {
    return `polar: ${what} failed at ${provider} (${failure.status ?? "no status"}, ${failure.kind})`;
}
