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
}

export const PLAIN_TURN: TurnSignals = { files: 0, tools: false, contextChars: 0, lastChars: 0 };

/** A newest message longer than this is not a quick question. */
export const LONG_MESSAGE_CHARS = 1_500;
/** A conversation longer than this is long context. */
export const LONG_CONTEXT_CHARS = 24_000;
/** How long a failed provider stays at the back of the line. */
export const FAILURE_MS = 5 * 60_000;
/** Rough characters per token, to check a model's window can hold the turn. */
const CHARS_PER_TOKEN = 4;

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
 * turn. Fast: models that do not reason first, then the cheapest. Reasoning:
 * models that reason first, then the newest, then the most capable by price.
 * A turn with files only goes to models that read files, and a long one only
 * to models whose window holds it, unless no model qualifies - then the
 * filter is dropped rather than leaving the turn with nothing. Providers in
 * `failing` go last, in the same order among themselves.
 */
export function automaticCandidates(
    providers: readonly PolarProviderOption[],
    signals: TurnSignals,
    failing: ReadonlySet<string> = new Set()
): PolarModelOption[] {
    const route = autoRoute(signals);
    let models = providers.flatMap((provider) => provider.models);
    const keep = (test: (model: PolarModelOption) => boolean) => {
        const kept = models.filter(test);
        if (kept.length > 0) models = kept;
    };
    if (signals.files > 0) keep((model) => model.attachment);
    const tokens = Math.ceil(signals.contextChars / CHARS_PER_TOKEN);
    keep((model) => model.contextTokens === 0 || model.contextTokens > tokens);
    const sorted = [...models].sort((a, b) => {
        if (route === "fast") {
            if (a.reasoning !== b.reasoning) return a.reasoning ? 1 : -1;
            return byCostAsc(a, b) || byName(a, b);
        }
        if (a.reasoning !== b.reasoning) return a.reasoning ? -1 : 1;
        return byReleaseDesc(a, b) || byCostAsc(b, a) || byName(a, b);
    });
    return [
        ...sorted.filter((model) => !failing.has(model.provider)),
        ...sorted.filter((model) => failing.has(model.provider))
    ];
}

const failures = new Map<string, number>();
/** Most entries the memo keeps, so it cannot grow without end. */
const FAILURE_MOST = 5_000;

/** Notes that a call to this provider failed for this person just now. */
export function noteProviderFailure(userId: string, provider: string, now = Date.now()): void {
    if (failures.size >= FAILURE_MOST) {
        for (const [key, at] of failures) if (now - at > FAILURE_MS) failures.delete(key);
        if (failures.size >= FAILURE_MOST) failures.clear();
    }
    failures.set(`${userId}\u0000${provider}`, now);
}

/** The providers whose calls failed for this person in the last few minutes. */
export function failingProviders(userId: string, now = Date.now()): Set<string> {
    const prefix = `${userId}\u0000`;
    const found = new Set<string>();
    for (const [key, at] of failures) {
        if (!key.startsWith(prefix)) continue;
        if (now - at > FAILURE_MS) failures.delete(key);
        else found.add(key.slice(prefix.length));
    }
    return found;
}
