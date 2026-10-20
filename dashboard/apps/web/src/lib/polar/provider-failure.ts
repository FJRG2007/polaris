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

/** One log line for a failed call: provider, status and kind, never the body
 *  or a stack, so a key that keeps failing does not bury the log. */
export function failureLogLine(what: string, provider: string, failure: ProviderFailure): string {
    return `polar: ${what} failed at ${provider} (${failure.status ?? "no status"}, ${failure.kind})`;
}
