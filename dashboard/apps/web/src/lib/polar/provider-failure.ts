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

/** `key`: the key is refused. `credit`: the account behind it cannot pay.
 *  `paid`: it has no credit and the model has no free variant to fall back on
 *  (`credit.ts`). `rate`: this key's own limit. `busy`: the provider or the
 *  model is saturated for everybody, so another model answers where this one
 *  cannot. `down`: the provider failed. `model`: it does not serve this model
 *  to this key. */
export const FAILURE_KINDS = [
    "key",
    "credit",
    "paid",
    "rate",
    "busy",
    "down",
    "model",
    "other"
] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface ProviderFailure {
    kind: FailureKind;
    status: number | null;
}

/**
 * What each provider calls each refusal, from its own error reference. A body
 * names the reason in a structured field - OpenAI's and Groq's `error.code`,
 * Anthropic's, Cerebras's and Moonshot's `error.type`, Gemini's `error.status`,
 * OpenRouter's `error.metadata.error_type` - and that field decides before the
 * status or the message does: Gemini's and Groq's rate-limit messages both
 * mention billing, and OpenAI says "no credit" with a 429.
 *
 * - OpenAI: developers.openai.com/api/docs/guides/error-codes
 * - Anthropic: platform.claude.com/docs/en/api/errors
 * - Gemini: aistudio.google.com/docs/api-errors
 * - Groq: console.groq.com/docs/errors
 * - DeepSeek: api-docs.deepseek.com/quick_start/error_codes
 * - Cerebras: inference-docs.cerebras.ai/support/error
 * - xAI: docs.x.ai/docs/key-information/debugging
 * - Together: docs.together.ai/docs/error-codes
 * - OpenRouter: openrouter.ai/docs/api-reference/errors
 * - LiteLLM: docs.litellm.ai/docs/exception_mapping
 */
const CODES: Readonly<Record<string, FailureKind>> = {
    // No credit, or a spend ceiling the account set itself.
    insufficient_quota: "credit",
    credit_balance_exhausted: "credit",
    organization_spend_limit_exceeded: "credit",
    project_spend_limit_exceeded: "credit",
    organization_usage_limit_exceeded: "credit",
    billing_error: "credit",
    payment_required: "credit",
    payment_required_error: "credit",
    insufficient_funds: "credit",
    insufficient_balance: "credit",
    budget_exceeded: "credit",
    exceeded_current_quota_error: "credit",
    failed_precondition: "credit",
    openrouter_guardrail_budget: "credit",
    openrouter_in_flight_budget: "credit",
    // The provider or the model is saturated for everybody.
    overloaded_error: "busy",
    server_is_overloaded: "busy",
    engine_overloaded_error: "busy",
    provider_overloaded: "busy",
    service_tier_capacity_exceeded: "busy",
    queue_exceeded: "busy",
    model_rate_limit_exceeded: "busy",
    upstream_provider: "busy",
    unavailable: "busy",
    service_unavailable: "busy",
    // This key's own limit.
    rate_limit_exceeded: "rate",
    rate_limit_error: "rate",
    rate_limit_reached_error: "rate",
    rate_limited: "rate",
    too_many_requests_error: "rate",
    token_quota_exceeded: "rate",
    request_quota_exceeded: "rate",
    resource_exhausted: "rate",
    quota_exceeded: "rate",
    slow_down: "rate",
    // A model this key cannot have.
    model_not_found: "model",
    model_decommissioned: "model",
    model_not_available: "model",
    deploymentnotfound: "model",
    not_found_error: "model",
    not_found: "model",
    // The key itself.
    authentication_error: "key",
    invalid_api_key: "key",
    api_key_invalid: "key",
    invalid_authentication_error: "key",
    unauthenticated: "key",
    permission_error: "key",
    permission_denied: "key",
    permission_denied_error: "key",
    // Down, not busy: the model failed rather than refused.
    provider_unavailable: "down",
    api_error: "down",
    internal_server_error: "down",
    timeout_error: "down",
    deadline_exceeded: "down"
};

/** Which kind wins when a body names more than one: a credit refusal is often
 *  worded as a quota, and a model's upstream limit as a rate limit. */
const RANK: readonly FailureKind[] = ["credit", "busy", "rate", "model", "key", "down"];

/** Out of credit, in the words of a body with no structured reason: Anthropic's
 *  400 "credit balance is too low", xAI's credits and spending limits,
 *  DeepSeek's "Insufficient Balance", LiteLLM's budget. Never plain "billing":
 *  Gemini's and Groq's rate limits say that word too. */
const CREDIT =
    /payment[_ ]required|insufficient[_ ](quota|funds|balance|credits?)|credit balance|out of (credits?|balance)|(no|any) credits\b|used all (available )?credits|spend(ing)? (limit|cap)|budget has been exceeded/i;
/** Saturated for everybody, in words: OpenRouter's shared `:free` models
 *  "rate-limited upstream", an engine "overloaded". */
const BUSY = /upstream|model[_ ]rate[_ ]limit|overloaded|over capacity|at capacity/i;
/** The model asked for is not one the provider serves to this key: Ollama's
 *  model "not found, try pulling it first", OpenAI's "does not exist or you do
 *  not have access to it", Groq's decommissioned models. */
const MODEL =
    /model[_ ]not[_ ]found|no such model|unknown model|decommissioned|no endpoints found|model\b[^.]{0,80}\b(not found|does not exist|is not supported)/i;
/** Refused for what the request said, not for who sent it: OpenRouter's
 *  moderation flag and guardrail block are 403s that are not about the key. */
const CONTENT = /flagged|moderation|guardrail|request blocked/i;

/** Most characters of a body read for its reasons. */
const BODY_MOST = 16_384;

/** The short strings a body names its reason with, lower-cased, and its
 *  messages. Reads `error`, `metadata` and Gemini's `details` a few levels
 *  deep, an array's first entry (Gemini's streaming errors), and a body that
 *  is not JSON as text. */
function reasonsOf(body: unknown): { reasons: string[]; text: string; forwarded: boolean } {
    const reasons: string[] = [];
    const texts: string[] = [];
    let forwarded = false;
    const read = (value: unknown, depth: number) => {
        if (typeof value !== "object" || value === null || depth > 3) return;
        const entry = value as Record<string, unknown>;
        for (const key of ["type", "code", "status", "error_type", "limit_source", "reason"]) {
            const named = entry[key];
            if (typeof named === "string" && named.length <= 80) reasons.push(named.toLowerCase());
        }
        // OpenRouter names the upstream provider whose own refusal it passes on.
        if (typeof entry.provider_name === "string" || typeof entry.provider_code === "string") {
            forwarded = true;
        }
        // xAI puts its sentence in `error` itself.
        if (typeof entry.error === "string") texts.push(entry.error);
        for (const key of ["message", "raw"]) {
            const said = entry[key];
            if (typeof said === "string") texts.push(said);
        }
        read(entry.error, depth + 1);
        read(entry.metadata, depth + 1);
        if (Array.isArray(entry.details)) {
            for (const item of entry.details.slice(0, 8)) read(item, depth + 1);
        }
    };
    let parsed: unknown = body;
    if (typeof body === "string") {
        const capped = body.slice(0, BODY_MOST);
        try {
            parsed = JSON.parse(capped);
        } catch {
            parsed = null;
            texts.push(capped);
        }
    }
    read(Array.isArray(parsed) ? parsed[0] : parsed, 0);
    return { reasons, text: texts.join(" "), forwarded };
}

/** The kind a body's structured reasons name, the strongest first. */
function kindOfReasons(reasons: readonly string[]): FailureKind | null {
    const named = new Set(reasons.map((reason) => CODES[reason]).filter(Boolean));
    return RANK.find((kind) => named.has(kind)) ?? null;
}

/** The kind a status says, for a body that names no reason. */
function kindOfStatus(status: number, text: string): FailureKind {
    if (status === 402) return "credit";
    if (status === 401 || status === 403) return CONTENT.test(text) ? "other" : "key";
    if (status === 404) return "model";
    // Groq's 498 is its flex tier at capacity; Anthropic's and Together's 529
    // and the 503 every provider documents are an overloaded service.
    if (status === 498 || status === 503 || status === 529) return "busy";
    if (status === 429) return BUSY.test(text) ? "busy" : "rate";
    if (status === 408 || status >= 500) return "down";
    return "other";
}

export interface CallErrorShape {
    statusCode?: unknown;
    responseBody?: unknown;
    message?: unknown;
    lastError?: unknown;
    cause?: unknown;
}

/** The innermost error that carries a status: a retry wraps its last attempt. */
export function callError(error: unknown, depth = 0): CallErrorShape | null {
    if (typeof error !== "object" || error === null || depth > 4) return null;
    const shape = error as CallErrorShape;
    if (typeof shape.statusCode === "number") return shape;
    return callError(shape.lastError, depth + 1) ?? callError(shape.cause, depth + 1);
}

/** What `credit.ts` marks a refusal with when the model needs credit the
 *  account does not have and has no free variant. */
export const PAID_MODEL_MARK = "polarPaidModel";

/** Whether an error, or one it wraps, carries that mark. */
export function isPaidModelError(error: unknown, depth = 0): boolean {
    if (typeof error !== "object" || error === null || depth > 4) return false;
    const shape = error as { [PAID_MODEL_MARK]?: unknown; lastError?: unknown; cause?: unknown };
    if (shape[PAID_MODEL_MARK] === true) return true;
    return isPaidModelError(shape.lastError, depth + 1) || isPaidModelError(shape.cause, depth + 1);
}

/**
 * Pure. Structured reasons first, then credit in the message (a 400 or a 429
 * that says the account cannot pay), then the status, then the message. A
 * stream that failed after it started carries no status, only the provider's
 * error object (Anthropic's mid-stream `overloaded_error`): its reasons decide.
 * Anything else is `other`.
 */
export function classifyProviderFailure(error: unknown): ProviderFailure {
    if (isPaidModelError(error)) return { kind: "paid", status: 402 };
    const found = callError(error);
    if (!found) return { kind: kindOfReasons(reasonsOf(error).reasons) ?? "other", status: null };
    const status = found.statusCode as number;
    const { reasons, text: said, forwarded } = reasonsOf(found.responseBody);
    const text = `${said} ${typeof found.message === "string" ? found.message : ""}`;
    const named = kindOfReasons(reasons);
    if (named === "credit" || (named !== "busy" && CREDIT.test(text))) {
        return { kind: "credit", status };
    }
    // OpenRouter forwards an upstream provider's own 429 with the provider's
    // name on it: that limit is the provider's, shared by everyone routed there.
    if (status === 429 && forwarded) {
        return { kind: "busy", status };
    }
    // A generic server-error type on a 4xx (Ollama's 404 `api_error`) says
    // less than the status does.
    if (named && !(named === "down" && status < 500)) return { kind: named, status };
    if (status === 429 && BUSY.test(text)) return { kind: "busy", status };
    if (status < 500 && status !== 404 && MODEL.test(text)) return { kind: "model", status };
    return { kind: kindOfStatus(status, text), status };
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
