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
 * What happens when a model is refused for any other reason - another key,
 * another model, another provider - is the router's (`router/chain.ts`);
 * the stand-in shape it walks is described here because every step carries it.
 */

import type { LanguageModelMiddleware } from "ai";
import { fileRoute, type ModelReads } from "@/lib/polar/file-route";
import { PAID_MODEL_MARK, callError } from "@/lib/polar/provider-failure";

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

/**
 * A provider's own marker for a model's no-cost variant, for providers that
 * name free variants rather than price them: OpenRouter's `:free` suffix
 * (openrouter.ai/docs/api-reference/limits, "free model variants"). Every
 * other provider's free models are the ones the catalogue prices at zero.
 */
const FREE_MARKERS: Readonly<Record<string, string>> = { openrouter: ":free" };

/** Whether a model id carries its provider's free-variant marker. Pure. */
export function hasFreeMarker(provider: string, model: string): boolean {
    const suffix = FREE_MARKERS[provider];
    return !!suffix && model.endsWith(suffix);
}

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

/** Whether a model costs nothing: one the catalogue prices at zero both ways,
 *  or one carrying its provider's own free-tier marker (`FREE_MARKERS`). An
 *  unknown price is not free. Pure. */
export function isFreeModel(option: {
    provider: string;
    model: string;
    costInput: number | null;
    costOutput?: number | null;
}): boolean {
    if (hasFreeMarker(option.provider, option.model)) return true;
    return option.costInput === 0 && (option.costOutput ?? 0) === 0;
}

/** The free variant of a model, when its provider names free variants by a
 *  marker and the provider's list carries one. Pure. */
export function freeVariantOf(
    provider: string,
    model: string,
    models: readonly { model: string }[]
): string | null {
    const suffix = FREE_MARKERS[provider];
    if (!suffix || model.endsWith(suffix)) return null;
    const free = `${model}${suffix}`;
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

/** The model that answers when the first one is refused. */
export interface StandInTarget {
    model: () => LanguageModelV4;
    /** Its provider: another provider's model is asked without the turn's
     *  provider-only tools, so a turn that sends one stays with its own. */
    provider: string;
    /** Whether it costs nothing (`isFreeModel`). */
    free: boolean;
    /** Whether it may be sent a reasoning level (some providers refuse one on
     *  a model that does not reason). */
    reasoning: boolean;
    /** The answer length it reserves (`polarOutputTokens`), used when it is
     *  another provider's: a length one provider takes another may refuse. */
    outputTokens?: number;
    /** What it reads as a file: a call that sends a file it would only take
     *  as text is not handed to it. Absent is "reads what the call sends". */
    reads?: ModelReads;
}

type CallParams = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["params"];

/** Whether a call sends a tool only its own provider runs - Anthropic's,
 *  OpenAI's or Google's own web search. Pure. */
export function sendsProviderTool(params: Pick<CallParams, "tools">): boolean {
    return (params.tools ?? []).some((entry) => entry.type === "provider");
}

/** Whether a model that reads `reads` takes every file part the call sends
 *  as the file it is. Pure. */
export function readsSentFiles(params: Pick<CallParams, "prompt">, reads: ModelReads): boolean {
    return (params.prompt ?? []).every(
        (message) =>
            !Array.isArray(message.content) ||
            message.content.every(
                (part) => part.type !== "file" || fileRoute(part.mediaType, reads) === "file"
            )
    );
}
