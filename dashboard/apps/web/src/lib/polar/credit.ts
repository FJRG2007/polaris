/**
 * What a turn asks a provider to reserve, and what happens when the account
 * cannot pay for it.
 *
 * A call that names no answer length is reserved at the model's whole output
 * window - 65536 tokens on some - and OpenRouter refuses it with a 402 when the
 * account's credit cannot cover that much, even for a one-line answer. Its
 * refusal names what it can afford ("You requested up to 65536 tokens, but can
 * only afford 22800"), so the turn is asked again once at that size. An account
 * with nothing to spend is moved to the model's `:free` variant when the
 * catalogue lists one, and otherwise the turn fails saying this model needs
 * credit, rather than looking like Polaris spent it.
 *
 * When Polar chose the model - Automatic, or the helper that names a thread -
 * a refusal another model can get past is asked once more of a stand-in
 * (`standInMiddleware`): a 402 the free variant could not settle, or a 429.
 * A shared `:free` model is rate-limited upstream for everyone at once, and a
 * zero-credit account cannot pay for the paid model Automatic ranked first, so
 * neither is a reason for the person to see an error. A model the person
 * pinned has no stand-in: they asked for that one, and the panel says why it
 * did not answer.
 */

import type { LanguageModelMiddleware } from "ai";
import { PAID_MODEL_MARK, callError, isPaidModelError } from "@/lib/polar/provider-failure";

/** The model a middleware is handed, as the SDK types it. */
export type LanguageModelV4 = Parameters<
    NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0]["model"];

/** The longest answer a turn reserves when the model publishes no smaller
 *  limit: room for a long answer with its reasoning, a fraction of the 65536
 *  some models declare. */
export const POLAR_OUTPUT_DEFAULT = 16_384;

/** Below this an affordable size is not worth a retry: the answer would be cut
 *  off before it said anything useful. */
export const POLAR_OUTPUT_FLOOR = 1_024;

/** OpenRouter's suffix for a model's no-cost variant. */
const FREE_SUFFIX = ":free";

const AFFORD = /can only afford (\d+)/i;

/**
 * The answer length a turn reserves on a model: undefined leaves it to the
 * provider's own SDK default, which only OpenRouter turns into a reservation of
 * the model's whole window. Pure.
 */
export function polarOutputTokens(option: {
    provider: string;
    outputTokens?: number;
}): number | undefined {
    if (option.provider !== "openrouter") return undefined;
    const declared = option.outputTokens ?? 0;
    return declared > 0 ? Math.min(declared, POLAR_OUTPUT_DEFAULT) : POLAR_OUTPUT_DEFAULT;
}

/** Whether a model costs nothing: OpenRouter's `:free` variants, or one the
 *  catalogue prices at zero both ways. An unknown price is not free. Pure. */
export function isFreeModel(option: {
    model: string;
    costInput: number | null;
    costOutput?: number | null;
}): boolean {
    if (option.model.endsWith(FREE_SUFFIX)) return true;
    return option.costInput === 0 && (option.costOutput ?? 0) === 0;
}

/** The `:free` variant of a model, when the provider's list carries one. Pure. */
export function freeVariantOf(model: string, models: readonly { model: string }[]): string | null {
    if (model.endsWith(FREE_SUFFIX)) return null;
    const free = `${model}${FREE_SUFFIX}`;
    return models.some((entry) => entry.model === free) ? free : null;
}

/** What to do about a refused call: ask again smaller, ask the free variant,
 *  say the model needs credit, or leave the error as it is. Pure. */
export type CreditRetry =
    { kind: "afford"; tokens: number } | { kind: "free" } | { kind: "paid" } | null;

export function creditRetry(
    error: unknown,
    requested: number | undefined,
    hasFree: boolean
): CreditRetry {
    const found = callError(error);
    if (found?.statusCode !== 402) return null;
    const said = `${typeof found.responseBody === "string" ? found.responseBody : ""} ${
        typeof found.message === "string" ? found.message : ""
    }`;
    const afford = Number(AFFORD.exec(said)?.[1] ?? 0);
    if (afford >= POLAR_OUTPUT_FLOOR && (requested === undefined || afford < requested)) {
        return { kind: "afford", tokens: afford };
    }
    return hasFree ? { kind: "free" } : { kind: "paid" };
}

/** A refusal for an account with no credit on a model that has no free variant. */
export class PaidModelError extends Error {
    readonly [PAID_MODEL_MARK] = true;
    constructor(cause: unknown) {
        // i18n-ignore logged, never shown: the panel words the failure kind
        super("the account has no credit and this model has no free variant", { cause });
        this.name = "PaidModelError";
    }
}

/**
 * Retry one refused call the way `creditRetry` says, once. A retry that is
 * refused again surfaces that refusal: asking a third time costs the person a
 * wait for the same answer.
 */
async function settle<T>(
    attempt: () => PromiseLike<T>,
    again: (model: LanguageModelV4, tokens: number | undefined) => PromiseLike<T>,
    model: LanguageModelV4,
    requested: number | undefined,
    free: (() => LanguageModelV4) | null,
    onNoCredit?: () => void
): Promise<T> {
    try {
        return await attempt();
    } catch (error) {
        const next = creditRetry(error, requested, free !== null);
        if (!next) throw error;
        if (next.kind === "afford") return again(model, next.tokens);
        onNoCredit?.();
        if (next.kind === "free" && free) return again(free(), requested);
        throw new PaidModelError(error);
    }
}

/** The middleware that applies the above to every call a model makes. */
export function creditMiddleware(
    free: (() => LanguageModelV4) | null,
    onNoCredit?: () => void
): LanguageModelMiddleware {
    return {
        wrapGenerate: ({ doGenerate, params, model }) =>
            settle(
                doGenerate,
                (target, tokens) => target.doGenerate({ ...params, maxOutputTokens: tokens }),
                model,
                params.maxOutputTokens,
                free,
                onNoCredit
            ),
        wrapStream: ({ doStream, params, model }) =>
            settle(
                doStream,
                (target, tokens) => target.doStream({ ...params, maxOutputTokens: tokens }),
                model,
                params.maxOutputTokens,
                free,
                onNoCredit
            )
    };
}

/** Whether a refusal is one a stand-in model may answer instead: no credit
 *  for this model, or a rate limit on it. A key refused, a provider down or a
 *  dropped connection would fail the stand-in the same way. Pure. */
export function standInRetry(error: unknown): boolean {
    if (isPaidModelError(error)) return true;
    const status = callError(error)?.statusCode;
    return status === 402 || status === 429;
}

/** The model that answers when the first one is refused, and whether it may
 *  be sent a reasoning level (some providers refuse one on a model that does
 *  not reason). */
export interface StandInTarget {
    model: () => LanguageModelV4;
    reasoning: boolean;
}

/**
 * The middleware that asks the stand-in once when the first call is refused
 * the way `standInRetry` says, and keeps asking the stand-in for the rest of
 * the turn's steps, so one model answers and is billed for all of them.
 * `onStandIn` runs before that call, so the turn can record which model
 * answered. A stand-in that is refused too surfaces its own refusal.
 */
export function standInMiddleware(
    target: StandInTarget,
    onStandIn: () => void
): LanguageModelMiddleware {
    type Params = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["params"];
    const adjust = (params: Params): Params =>
        target.reasoning ? params : { ...params, reasoning: undefined };
    let standing = false;
    async function swap<T>(
        attempt: () => PromiseLike<T>,
        again: (model: LanguageModelV4) => PromiseLike<T>
    ): Promise<T> {
        if (standing) return again(target.model());
        try {
            return await attempt();
        } catch (error) {
            if (!standInRetry(error)) throw error;
            standing = true;
            onStandIn();
            return again(target.model());
        }
    }
    return {
        wrapGenerate: ({ doGenerate, params }) =>
            swap(doGenerate, (model) => model.doGenerate(adjust(params))),
        wrapStream: ({ doStream, params }) =>
            swap(doStream, (model) => model.doStream(adjust(params)))
    };
}
