/**
 * The error envelopes the compatible API answers with, one per wire. A coding
 * tool reads the type and the status to decide whether to retry, ask for a
 * new key or show the message, so both follow the reference exactly:
 *
 * - Anthropic: `{type: "error", error: {type, message}}`, status by type
 *   (platform.claude.com/docs/en/api/errors; free-claude-code
 *   `core/anthropic/errors.py`).
 * - OpenAI: `{error: {message, type, param, code}}` (free-claude-code
 *   `core/openai_responses/errors.py`).
 *
 * A provider's own body is never forwarded: it names the account, the key's
 * owner or the upstream route. The message is a sentence of ours, chosen from
 * the kind of refusal `classifyProviderFailure` reads.
 *
 * Pure.
 */

import { classifyProviderFailure } from "@/lib/polar/provider-failure";

/** The Anthropic error types and the status each is sent with. */
export const ERROR_STATUS = {
    invalid_request_error: 400,
    authentication_error: 401,
    billing_error: 402,
    permission_error: 403,
    not_found_error: 404,
    request_too_large: 413,
    rate_limit_error: 429,
    api_error: 500,
    timeout_error: 504,
    overloaded_error: 529
} as const;
export type CompatErrorType = keyof typeof ERROR_STATUS;

/** One failure, before it is put on a wire. */
export interface CompatError {
    type: CompatErrorType;
    message: string;
    /** Seconds a rate-limited caller should wait, when known. */
    retryAfter?: number;
}

export function compatError(type: CompatErrorType, message: string, retryAfter?: number): CompatError {
    return retryAfter === undefined ? { type, message } : { type, message, retryAfter };
}

const ERROR_KEYS = new Set(["type", "message", "retryAfter"]);

/** Whether a value is a `CompatError` rather than what a step returns on success. */
export function isCompatError(value: unknown): value is CompatError {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    return (
        typeof entry.type === "string" &&
        entry.type in ERROR_STATUS &&
        typeof entry.message === "string" &&
        Object.keys(entry).every((key) => ERROR_KEYS.has(key))
    );
}

/** The Anthropic envelope. */
export function anthropicErrorBody(error: CompatError) {
    return { type: "error", error: { type: error.type, message: error.message } };
}

/** The OpenAI envelope. OpenAI has no 529; an overloaded upstream is a 503. */
export function openaiErrorBody(error: CompatError) {
    return { error: { message: error.message, type: error.type, param: null, code: null } };
}

export function errorStatus(error: CompatError, wire: "anthropic" | "openai"): number {
    const status = ERROR_STATUS[error.type];
    return wire === "openai" && status === 529 ? 503 : status;
}

/** The error as an HTTP response on one wire. */
export function errorResponse(error: CompatError, wire: "anthropic" | "openai"): Response {
    const headers: Record<string, string> = {};
    if (error.retryAfter !== undefined) headers["retry-after"] = String(error.retryAfter);
    return Response.json(wire === "anthropic" ? anthropicErrorBody(error) : openaiErrorBody(error), {
        status: errorStatus(error, wire),
        headers
    });
}

/**
 * What a provider's refusal becomes. A refused provider key is not the
 * caller's key failing: answering 401 would make Claude Code ask its user to
 * sign in again, so it is a permission error that names where to fix it. A
 * refusal for want of credit is `billing_error`, as free-claude-code maps a 402.
 */
export function providerError(error: unknown): CompatError {
    const failure = classifyProviderFailure(error);
    switch (failure.kind) {
        case "key":
            return compatError(
                "permission_error",
                "The model provider refused the key stored in Polaris. Check the key in Polar's settings."
            );
        case "credit":
        case "paid":
            return compatError(
                "billing_error",
                "The model provider's account has no credit left for this model."
            );
        case "rate":
            return compatError("rate_limit_error", "The model provider is rate limiting this key. Try again shortly.");
        case "busy":
            return compatError("overloaded_error", "The model is overloaded right now. Try again shortly.");
        case "model":
            return compatError("not_found_error", "The model provider does not serve this model to this key.");
        case "down":
            return compatError("api_error", "The model provider failed to answer.");
        default:
            if (failure.status === 400 || failure.status === 422) {
                return compatError("invalid_request_error", "The model provider rejected the request.");
            }
            if (failure.status === 413) {
                return compatError("request_too_large", "The request is too large for this model.");
            }
            if (failure.status === 504 || failure.status === 408) {
                return compatError("timeout_error", "The model provider took too long to answer.");
            }
            return compatError("api_error", "The model could not answer.");
    }
}

/** Why resolving the model refused, in words the caller can act on. */
export function refusalError(refusal: "no_key" | "unknown_model" | "unsupported_kind"): CompatError {
    switch (refusal) {
        case "no_key":
            return compatError(
                "permission_error",
                "No model key is set up in Polaris for this model. Add one in Polar's settings, or ask an administrator to share one."
            );
        case "unknown_model":
            return compatError("not_found_error", "This model is not one Polaris can route to for this account.");
        default:
            return compatError("invalid_request_error", "This model does not answer messages.");
    }
}
