/**
 * Polar's "Automatic" model: which of the models this person can use answers
 * one turn, decided by fixed rules over what the turn carries.
 *
 * A short plain question goes to a fast model. A turn with files, with tool
 * work already in the conversation, or with a long message or history goes to
 * one that reasons. Providers whose calls failed a moment ago are tried last,
 * and a provider whose key cannot be read is skipped by the caller.
 *
 * Pure except for the failure memo, which is per process and short-lived: it
 * only reorders candidates, so losing it on a restart costs one slow retry.
 */

import { isFreeModel } from "@/lib/polar/credit";
import type { PolarModelOption, PolarProviderOption } from "@/lib/polar/models";

/** What one turn carries, as far as choosing a model goes. */
export interface TurnSignals {
    /** Files on the newest message. */
    files: number;
    /** Whether the conversation sent already holds tool calls. */
    tools: boolean;
    /** Characters of text across every message sent. */
    contextChars: number;
    /** Characters of the newest message's text. */
    lastChars: number;
    /** Whether the model is offered tools it may have to call to answer - every
     *  Polar chat turn is: its devices, files and apps are tools. Such a turn
     *  never goes to a model too small to drive them while a larger one fits. */
    agentic?: boolean;
}

export const PLAIN_TURN: TurnSignals = { files: 0, tools: false, contextChars: 0, lastChars: 0 };

/** A newest message longer than this is not a quick question. */
export const LONG_MESSAGE_CHARS = 1_500;
/** A conversation longer than this is long context. */
export const LONG_CONTEXT_CHARS = 24_000;
/** How long a failed provider stays at the back of the line. */
export const FAILURE_MS = 5 * 60_000;
/** How long a provider that refused for want of credit is offered only its
 *  free models: credit is added by hand, rarely within the hour. */
export const UNPAID_MS = 30 * 60_000;
/** Rough characters per token, to check a model's window can hold the turn. */
const CHARS_PER_TOKEN = 4;
/** A model whose name states fewer parameters than this (billions) is too small
 *  to drive tools reliably: it calls none, or the wrong one, and then answers
 *  that it cannot help. */
export const AGENTIC_MIN_BILLIONS = 10;

/**
 * How recent a model has to be for Polar to offer it, in months before today.
 * The window moves with the clock, so the list keeps itself current: what was
 * frontier a year ago (Mistral Nemo, gpt-oss-120b) drops out on its own as
 * newer releases land, with nothing to edit by hand.
 */
export const CURRENT_MODEL_MONTHS = 12;

/**
 * The models still current: released within `CURRENT_MODEL_MONTHS` of `now`,
 * or of unknown date (a deployment, a gateway, a model somebody typed - Polar
 * cannot judge those, so it does not hide them). When none of `models` is
 * current, the newest few stay rather than leaving a provider with nothing.
 * Order is kept. Pure.
 */
export function currentModels<T extends Pick<PolarModelOption, "releaseDate">>(
    models: readonly T[],
    now: Date = new Date()
): T[] {
    const floor = new Date(now);
    floor.setUTCMonth(floor.getUTCMonth() - CURRENT_MODEL_MONTHS);
    const cutoff = floor.toISOString().slice(0, 10);
    const current = models.filter((model) => !model.releaseDate || model.releaseDate >= cutoff);
    if (current.length > 0) return current;
    const newest = [...models].sort((a, b) =>
        (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "")
    );
    const keep = new Set(newest.slice(0, 3));
    return models.filter((model) => keep.has(model));
}

/** Which kind of model a turn goes to. */
export type AutoRoute = "fast" | "reasoning";

type Part = { type: string; text?: unknown };
type MessageLike = { role: string; parts: readonly Part[] };

function textLength(message: MessageLike): number {
    let total = 0;
    for (const part of message.parts) {
        if (part.type === "text" && typeof part.text === "string") total += part.text.length;
    }
    return total;
}

/** The signals of the messages one request sends. */
export function turnSignals(messages: readonly MessageLike[]): TurnSignals {
    const last = messages.at(-1);
    return {
        files: last ? last.parts.filter((part) => part.type === "file").length : 0,
        tools: messages.some((message) =>
            message.parts.some(
                (part) => part.type.startsWith("tool-") || part.type === "dynamic-tool"
            )
        ),
        contextChars: messages.reduce((sum, message) => sum + textLength(message), 0),
        lastChars: last ? textLength(last) : 0
    };
}

/** The route a turn takes. */
export function autoRoute(signals: TurnSignals): AutoRoute {
    if (signals.files > 0 || signals.tools) return "reasoning";
    if (signals.lastChars > LONG_MESSAGE_CHARS) return "reasoning";
    if (signals.contextChars > LONG_CONTEXT_CHARS) return "reasoning";
    return "fast";
}

/**
 * The parameter count a model's id or name states, in billions ("8b", "1.5b",
 * "8x7b"), the largest when it states several ("235b-a22b" is 235); null when
 * it states none, which is most commercial models.
 */
export function statedBillions(model: Pick<PolarModelOption, "model" | "name">): number | null {
    let most: number | null = null;
    for (const text of [model.model, model.name]) {
        const name = text.toLowerCase().split("/").pop() ?? "";
        for (const match of name.matchAll(/(?<![a-z0-9.])(?:(\d+)x)?(\d+(?:\.\d+)?)b(?![a-z0-9])/g)) {
            const billions = Number(match[2]) * (match[1] ? Number(match[1]) : 1);
            if (most === null || billions > most) most = billions;
        }
    }
    return most;
}

/** Cheapest first; an unknown price after every known one. */
function byCostAsc(a: PolarModelOption, b: PolarModelOption): number {
    const left = a.costInput ?? Number.POSITIVE_INFINITY;
    const right = b.costInput ?? Number.POSITIVE_INFINITY;
    return left === right ? 0 : left < right ? -1 : 1;
}

/** Newest release first; an unknown date after every known one. */
function byReleaseDesc(a: PolarModelOption, b: PolarModelOption): number {
    const left = a.releaseDate ?? "";
    const right = b.releaseDate ?? "";
    return left === right ? 0 : left > right ? -1 : 1;
}

const byName = (a: PolarModelOption, b: PolarModelOption) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Every model this person can use, in the order Automatic tries them for a
 * turn. Fast: models that do not reason first, then the cheapest, then the
 * newest. Reasoning:
 * models that reason first, then the newest, then the most capable by price.
 * A turn with files only goes to models that read files, and a long one only
 * to models whose window holds it, unless no model qualifies - then the
 * filter is dropped rather than leaving the turn with nothing; so is the one
 * that keeps a turn offering tools off models too small to call them
 * (`statedBillions`). A provider in
 * `unpaid` refused a call for want of credit a moment ago, so only its free
 * models are offered while it has any. Providers in `failing` go last, in the
 * same order among themselves.
 */
export function automaticCandidates(
    providers: readonly PolarProviderOption[],
    signals: TurnSignals,
    failing: ReadonlySet<string> = new Set(),
    unpaid: ReadonlySet<string> = new Set(),
    /** `provider/model` of models that wrote their tool calls out as text
     *  lately (`toolMarkupIn`); a turn offering tools skips them. */
    garbled: ReadonlySet<string> = new Set()
): PolarModelOption[] {
    const route = autoRoute(signals);
    let models = providers.flatMap((provider) =>
        unpaid.has(provider.provider) && provider.models.some(isFreeModel)
            ? provider.models.filter(isFreeModel)
            : provider.models
    );
    const keep = (test: (model: PolarModelOption) => boolean) => {
        const kept = models.filter(test);
        if (kept.length > 0) models = kept;
    };
    if (signals.files > 0) keep((model) => model.attachment);
    if (signals.agentic) {
        keep((model) => !garbled.has(`${model.provider}/${model.model}`));
        keep((model) => {
            const billions = statedBillions(model);
            return billions === null || billions >= AGENTIC_MIN_BILLIONS;
        });
    }
    const tokens = Math.ceil(signals.contextChars / CHARS_PER_TOKEN);
    keep((model) => {
        // The provider's own window when it reports one, as the context bar reads it.
        const window = model.providerContextTokens ?? model.contextTokens;
        return window === 0 || window > tokens;
    });
    const sorted = [...models].sort((a, b) => {
        if (route === "fast") {
            if (a.reasoning !== b.reasoning) return a.reasoning ? 1 : -1;
            return byCostAsc(a, b) || byReleaseDesc(a, b) || byName(a, b);
        }
        if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
        return byReleaseDesc(a, b) || byCostAsc(b, a) || byName(a, b);
    });
    return [
        ...sorted.filter((model) => !failing.has(model.provider)),
        ...sorted.filter((model) => failing.has(model.provider))
    ];
}

/** Most entries a memo keeps, so it cannot grow without end. */
const MEMO_MOST = 5_000;

/** A per-process memo of providers that refused one person a moment ago. */
function providerMemo(ttl: number) {
    const seen = new Map<string, number>();
    return {
        note(userId: string, provider: string, now: number): void {
            if (seen.size >= MEMO_MOST) {
                for (const [key, at] of seen) if (now - at > ttl) seen.delete(key);
                if (seen.size >= MEMO_MOST) seen.clear();
            }
            seen.set(`${userId}\u0000${provider}`, now);
        },
        list(userId: string, now: number): Set<string> {
            const prefix = `${userId}\u0000`;
            const found = new Set<string>();
            for (const [key, at] of seen) {
                if (!key.startsWith(prefix)) continue;
                if (now - at > ttl) seen.delete(key);
                else found.add(key.slice(prefix.length));
            }
            return found;
        }
    };
}

/** How long a model that wrote its tool calls out as text is kept off
 *  Automatic's turns that offer tools. */
export const GARBLED_MS = 6 * 60 * 60_000;

/**
 * Whether an answer holds a tool call written out as text rather than made:
 * the markup a model's own chat template uses (`<invoke name=`, `<tool_call>`,
 * `<|tool_call...|>`, `<function_calls>`) leaking into what the reader sees.
 * Such a model cannot drive tools through this API, whatever its catalogue
 * says. Pure.
 */
export function toolMarkupIn(text: string): boolean {
    return /<invoke\s+name=|<\/?tool_call\b|<\|tool_calls?[_a-z]*\|>|<\/?function_calls>/i.test(text);
}

const failures = providerMemo(FAILURE_MS);
const garbled = providerMemo(GARBLED_MS);

/** Notes that this model wrote its tool calls out as text for this person. */
export function noteToolMarkup(userId: string, provider: string, model: string, now = Date.now()): void {
    garbled.note(userId, `${provider}/${model}`, now);
}

/** The `provider/model` of models that wrote tool calls as text lately. */
export function garbledModels(userId: string, now = Date.now()): Set<string> {
    return garbled.list(userId, now);
}
const unpaid = providerMemo(UNPAID_MS);

/** Notes that a call to this provider failed for this person just now. */
export function noteProviderFailure(userId: string, provider: string, now = Date.now()): void {
    failures.note(userId, provider, now);
}

/** The providers whose calls failed for this person in the last few minutes. */
export function failingProviders(userId: string, now = Date.now()): Set<string> {
    return failures.list(userId, now);
}

/** Notes that this provider refused this person for want of credit just now. */
export function noteNoCredit(userId: string, provider: string, now = Date.now()): void {
    unpaid.note(userId, provider, now);
}

/** The providers that refused this person for want of credit lately. */
export function unpaidProviders(userId: string, now = Date.now()): Set<string> {
    return unpaid.list(userId, now);
}
