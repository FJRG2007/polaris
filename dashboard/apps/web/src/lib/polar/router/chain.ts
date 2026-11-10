/**
 * The router itself: an AI SDK middleware that walks an ordered list of steps
 * - one model on one key each - until one answers.
 *
 * Modelled on free-claude-code's candidate loop (`application/execution.py`)
 * and its admission controller (`providers/admission.py`), with three things it
 * does not do:
 *
 * - **Keys rotate.** A step is a model on a key, and the plan holds every key
 *   of a provider in its owner's order, so a refused, rate-limited or spent key
 *   hands the call to the next key of the same provider before any other model
 *   is asked. free-claude-code only ever uses the key number written on the
 *   fallback entry.
 * - **A refusal is remembered for what it is about** (`health.ts`): the next
 *   turn starts on a key that works instead of re-learning the refusal.
 * - **Waiting is the last resort, not the first.** When another step fits, the
 *   call moves on at once; only the last one standing is retried, with
 *   exponential backoff and the provider's own `Retry-After`, bounded so a chat
 *   never hangs for minutes.
 *
 * A stream is held back until its first piece of content, so a provider that
 * accepts the call and then fails before saying anything is routed past like
 * one that refused it (free-claude-code buffers the first 0.75 s for the same
 * reason). Once content has reached the reader a failure is carried on rather
 * than ended (`continuation.ts`): the next step that fits is shown what was
 * already written and asked to continue it, the way free-claude-code does.
 *
 * Once a step has answered, it answers every later step of the same turn, so
 * one model is billed for the whole turn and its tool calls stay coherent.
 *
 * Server-only.
 */

import type { LanguageModelMiddleware } from "ai";
import type { KeyLimits } from "@/lib/agents/key-limits";
import type { LanguageModelV4 } from "@/lib/polar/credit";
import { admit, type Admission } from "@/lib/polar/router/limits";
import { readsSentFiles, sendsProviderTool, type StandInTarget } from "@/lib/polar/credit";
import { classifyProviderFailure, type FailureKind } from "@/lib/polar/provider-failure";
import { coolingOf, noteAnswered, noteRefusal, retryAfterMs } from "@/lib/polar/router/health";
import { reasoningForRoute, type RouteReasoning, type SdkReasoning } from "@/lib/polar/routing";
import {
    MAX_CONTINUATIONS,
    continuable,
    continuationParams,
    withoutOverlap,
    type Delivered
} from "@/lib/polar/router/continuation";

type CallParams = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["params"];
type StreamResult = Awaited<ReturnType<LanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** One model on one key, as the router tries it. */
export interface RouteStep extends StandInTarget {
    /** The provider's own model id. */
    modelId: string;
    /** The stored key it spends; absent for a credential with no row. */
    keyId?: string;
    limits?: KeyLimits;
    coolingUntil?: Date | null;
    coolingReason?: string | null;
    /** The effort this step runs at (`routing.ts`). */
    routeReasoning: RouteReasoning;
    /** Set on a key that has spent its own allowance: it refuses at once. */
    spent?: boolean;
}

/** The refusals the router moves past. A malformed request, a refusal of the
 *  content and a dropped connection are the call's, not the model's: another
 *  model would be asked the same thing and fail the same way. */
const ROUTABLE: ReadonlySet<FailureKind> = new Set([
    "key",
    "credit",
    "paid",
    "rate",
    "busy",
    "down",
    "model"
]);

/** Whether a refusal is one the router moves past. Pure. */
export function isRoutable(error: unknown): boolean {
    return ROUTABLE.has(classifyProviderFailure(error).kind);
}

/** The refusals worth asking the same step again after a wait. */
const RETRYABLE: ReadonlySet<FailureKind> = new Set(["rate", "busy", "down"]);

/** How the last step standing is retried. */
export const RETRY = {
    /** Attempts after the first. */
    times: 3,
    baseMs: 1_000,
    /** Longest single wait, and longest a provider's `Retry-After` is honoured
     *  for here: a longer one moves on rather than holding a chat open. */
    mostMs: 20_000,
    /** Longest the retries of one call may wait in all. */
    totalMs: 30_000
} as const;

/** The wait before retry `attempt` (1-based): doubling from `baseMs` with
 *  jitter, never under what the provider asked. Pure apart from the jitter. */
export function backoffMs(attempt: number, retryAfter: number | null, random = Math.random): number {
    const doubling = Math.min(RETRY.baseMs * 2 ** (attempt - 1), RETRY.mostMs);
    return Math.max(doubling + random() * 500, retryAfter ?? 0);
}

/** What the router tells its caller. */
export interface RouteHooks {
    /** Runs when step `index` answers, with the refusal that moved the call
     *  off the first step, if one did. */
    onAnswered?: (index: number, firstRefusal: FailureKind | null) => void;
    /** Runs with each refusal, before the next step is tried. */
    onRefused?: (kind: FailureKind, index: number) => void;
    /** Waits; replaced in tests. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(signal.reason);
            },
            { once: true }
        );
    });
}

/** The parts a stream may send before it has said anything. */
const PREAMBLE: ReadonlySet<string> = new Set([
    "stream-start",
    "response-metadata",
    "raw",
    "text-start",
    "reasoning-start"
]);

/** A stream's error part as the error it carries. */
class StreamRefusal extends Error {
    constructor(readonly error: unknown) {
        super("the provider failed before it answered");
        this.name = "StreamRefusal";
        this.cause = error;
    }
}

/** Carries on a stream that failed after content, or answers null to let the
 *  failure through. */
export type Resume = (error: unknown, delivered: Delivered) => Promise<StreamResult | null>;

/**
 * Read a stream up to its first piece of content. An error before it throws,
 * so the router can move on; otherwise the stream is handed back whole, the
 * parts already read first. `release` runs once the stream ends however it
 * ends. An error after content is offered to `resume`, which may hand back a
 * stream that continues the answer; the reader sees one answer either way.
 */
export async function heldStream(
    result: StreamResult,
    release: () => void,
    resume?: Resume
): Promise<StreamResult> {
    let reader = result.stream.getReader();
    const held: StreamPart[] = [];
    const delivered: Delivered = { text: "", tools: false };
    const openText = new Set<string>();
    const openReasoning = new Set<string>();
    const note = (part: StreamPart & { type: string }) => {
        const piece = part as { id?: string; delta?: string };
        if (part.type === "text-delta") delivered.text += piece.delta ?? "";
        else if (part.type === "text-start" && piece.id) openText.add(piece.id);
        else if (part.type === "text-end" && piece.id) openText.delete(piece.id);
        else if (part.type === "reasoning-start" && piece.id) openReasoning.add(piece.id);
        else if (part.type === "reasoning-end" && piece.id) openReasoning.delete(piece.id);
        else if (part.type.startsWith("tool-")) delivered.tools = true;
    };
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const part = value as StreamPart & { type: string; error?: unknown };
            if (part.type === "error") throw new StreamRefusal(part.error);
            held.push(value);
            note(part);
            if (!PREAMBLE.has(part.type)) break;
        }
    } catch (error) {
        reader.cancel().catch(() => undefined);
        release();
        throw error instanceof StreamRefusal ? error.error : error;
    }
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        release();
    };
    let continued = 0;
    /** Whether the answer goes on in another stream; false ends it on the error. */
    const carryOn = async (
        error: unknown,
        controller: ReadableStreamDefaultController<StreamPart>
    ): Promise<boolean> => {
        // Once handed on, the stream that continues owns any further break
        // (and its own bound), so this one never carries on twice.
        if (!resume || delivered.tools || continued > 0) return false;
        // This stream's key is done with either way.
        finish();
        const next = await resume(error, { ...delivered }).catch(() => null);
        if (!next) return false;
        continued++;
        // The blocks the broken stream left open are closed as they stood.
        for (const id of openText) controller.enqueue({ type: "text-end", id } as StreamPart);
        for (const id of openReasoning) controller.enqueue({ type: "reasoning-end", id } as StreamPart);
        openText.clear();
        openReasoning.clear();
        reader = withoutOverlap(next.stream, delivered.text).getReader();
        return true;
    };
    const stream = new ReadableStream<StreamPart>({
        start(controller) {
            for (const part of held) controller.enqueue(part);
        },
        async pull(controller) {
            for (;;) {
                let failure: unknown;
                let failedPart: StreamPart | null = null;
                try {
                    const { value, done } = await reader.read();
                    if (done) {
                        finish();
                        controller.close();
                        return;
                    }
                    const part = value as StreamPart & { type: string; error?: unknown };
                    if (part.type !== "error") {
                        note(part);
                        controller.enqueue(value);
                        return;
                    }
                    failure = part.error;
                    failedPart = value;
                } catch (error) {
                    failure = error;
                }
                if (await carryOn(failure, controller)) continue;
                // Not carried on: the failure reaches the reader as it came, a
                // part as a part and a broken read as an error.
                if (failedPart) {
                    controller.enqueue(failedPart);
                    return;
                }
                finish();
                controller.error(failure);
                return;
            }
        },
        cancel(reason) {
            finish();
            return reader.cancel(reason);
        }
    });
    return { ...result, stream };
}

/** The call as one step receives it: its effort, and the answer length and
 *  reasoning another provider accepts. */
function adjust(step: RouteStep, params: CallParams, origin: string): CallParams {
    const current = params.reasoning as SdkReasoning | undefined;
    const reasoning = step.reasoning
        ? reasoningForRoute(step.routeReasoning, current)
        : undefined;
    let next: CallParams = { ...params, reasoning };
    if (step.provider !== origin) next = { ...next, maxOutputTokens: step.outputTokens };
    return next;
}

/** What each refusal rules out for the rest of the call. */
interface Ruled {
    keys: Set<string>;
    providers: Set<string>;
    keyModels: Set<string>;
    providerModels: Set<string>;
    /** Keys that cannot pay: still in for a free model. */
    unpaid: Set<string>;
}

function ruleOut(ruled: Ruled, step: RouteStep, kind: FailureKind): void {
    const key = step.keyId ?? `${step.provider}#`;
    if (kind === "key") ruled.keys.add(key);
    else if (kind === "down") ruled.providers.add(step.provider);
    else if (kind === "credit" || kind === "paid") ruled.unpaid.add(key);
    else if (kind === "busy") ruled.providerModels.add(`${step.provider}/${step.modelId}`);
    else ruled.keyModels.add(`${key}/${step.modelId}`);
}

function ruledOut(ruled: Ruled, step: RouteStep): boolean {
    const key = step.keyId ?? `${step.provider}#`;
    return (
        ruled.keys.has(key) ||
        ruled.providers.has(step.provider) ||
        (ruled.unpaid.has(key) && !step.free) ||
        ruled.providerModels.has(`${step.provider}/${step.modelId}`) ||
        ruled.keyModels.has(`${key}/${step.modelId}`)
    );
}

/**
 * The middleware that routes every call of a turn through `steps`, the first
 * being the model chosen. See the file comment for the order of things.
 */
export function routeMiddleware(steps: readonly RouteStep[], hooks: RouteHooks = {}): LanguageModelMiddleware {
    const wait = hooks.sleep ?? sleep;
    const origin = steps[0]?.provider ?? "";
    let standing: number | null = null;
    let firstRefusal: FailureKind | null = null;

    async function call<T>(
        params: CallParams,
        run: (model: LanguageModelV4, params: CallParams) => PromiseLike<T>,
        streams: boolean,
        broke?: { index: number; kind: FailureKind | null },
        depth = 0
    ): Promise<T> {
        const signal = params.abortSignal;
        /** Carries on step `index`'s answer on whichever step fits next. */
        const resumeFrom =
            (index: number): Resume =>
            async (error, delivered) => {
                // Bounded across the chain of continuations, not only per stream:
                // a connection that keeps dropping must end somewhere.
                if (depth >= MAX_CONTINUATIONS || signal?.aborted || !continuable(error)) return null;
                // A structured answer is not one a second model can finish.
                if (params.responseFormat?.type === "json") return null;
                const { kind } = classifyProviderFailure(error);
                const refused = ROUTABLE.has(kind);
                if (refused) {
                    void noteRefusal(subjectOf(steps[index]!), kind, error);
                    hooks.onRefused?.(kind, index);
                }
                standing = null;
                const next = delivered.text ? continuationParams(params, delivered.text) : params;
                const answer = await call(next, run, true, { index, kind: refused ? kind : null }, depth + 1);
                return answer as unknown as StreamResult;
            };
        const attempt = async (index: number): Promise<T> => {
            const step = steps[index]!;
            if (step.spent) throw new NoRouteError("rate");
            const admission: Admission = admit(step.keyId, step.limits);
            if (!admission.ok) throw new Busy(admission.retryInMs);
            try {
                const result = await run(step.model(), adjust(step, params, origin));
                const answered = streams
                    ? ((await heldStream(result as StreamResult, admission.release, resumeFrom(index))) as T)
                    : result;
                if (!streams) admission.release();
                return answered;
            } catch (error) {
                admission.release();
                throw error;
            }
        };

        const ruled: Ruled = {
            keys: new Set(),
            providers: new Set(),
            keyModels: new Set(),
            providerModels: new Set(),
            unpaid: new Set()
        };
        // The step whose stream broke is out for the continuation, as a refusal
        // would put it; a dropped connection leaves it in, to be asked again.
        if (broke?.kind) ruleOut(ruled, steps[broke.index]!, broke.kind);

        // A later step of the turn goes to the step that answered the first.
        // If that one is refused now - a tool loop that ran into a rate limit
        // halfway - the turn walks the plan again without it rather than
        // ending on a refusal another step could answer.
        if (standing !== null) {
            const held = standing;
            try {
                return await attempt(held);
            } catch (error) {
                if (error instanceof Busy || signal?.aborted) throw error;
                const { kind } = classifyProviderFailure(error);
                if (!ROUTABLE.has(kind)) throw error;
                ruleOut(ruled, steps[held]!, kind);
                void noteRefusal(subjectOf(steps[held]!), kind, error);
                hooks.onRefused?.(kind, held);
                standing = null;
            }
        }
        let lastError: unknown = null;
        let lastKind: FailureKind | null = null;
        const cooled: number[] = [];
        const crowded: Array<{ index: number; retryInMs: number }> = [];

        // What each refusal excludes is already in `ruled`; beyond that a step
        // fits unless the call carries something only the first provider takes.
        const fits = (index: number): boolean => {
            const step = steps[index]!;
            if (ruledOut(ruled, step)) return false;
            if (index === 0) return true;
            if (step.provider !== origin && sendsProviderTool(params)) return false;
            return !step.reads || readsSentFiles(params, step.reads);
        };

        const settle = async (index: number, ignoreCooling: boolean): Promise<{ value: T } | null> => {
            const step = steps[index]!;
            if (!fits(index)) return null;
            if (!ignoreCooling && coolingOf(subjectOf(step), step.free)) {
                cooled.push(index);
                return null;
            }
            const later = steps.some((_, other) => other > index && fits(other));
            let waited = 0;
            for (let retry = 0; ; retry++) {
                try {
                    const value = await attempt(index);
                    standing = index;
                    void noteAnswered(subjectOf(step));
                    hooks.onAnswered?.(index, firstRefusal);
                    return { value };
                } catch (error) {
                    if (error instanceof Busy) {
                        crowded.push({ index, retryInMs: error.retryInMs });
                        return null;
                    }
                    if (signal?.aborted) throw error;
                    const { kind } = classifyProviderFailure(error);
                    if (!ROUTABLE.has(kind)) throw error;
                    const retryAfter = retryAfterMs(error);
                    const pause = backoffMs(retry + 1, retryAfter);
                    const mayRetry =
                        !later &&
                        RETRYABLE.has(kind) &&
                        retry < RETRY.times &&
                        (retryAfter ?? 0) <= RETRY.mostMs &&
                        waited + pause <= RETRY.totalMs;
                    if (mayRetry) {
                        waited += pause;
                        await wait(pause, signal);
                        continue;
                    }
                    firstRefusal ??= kind;
                    lastError = error;
                    lastKind = kind;
                    ruleOut(ruled, step, kind);
                    void noteRefusal(subjectOf(step), kind, error);
                    hooks.onRefused?.(kind, index);
                    return null;
                }
            }
        };

        for (let index = 0; index < steps.length; index++) {
            const done = await settle(index, false);
            if (done) return done.value;
        }
        // Everything still in was crowded by its own allowance: wait for the
        // first slot that opens, once, rather than refuse a call a key will
        // take in a moment.
        const soonest = crowded
            .filter((entry) => fits(entry.index))
            .sort((a, b) => a.retryInMs - b.retryInMs)[0];
        if (soonest && soonest.retryInMs <= RETRY.mostMs) {
            await wait(soonest.retryInMs, signal);
            const done = await settle(soonest.index, true);
            if (done) return done.value;
        }
        // Everything left was cooling from an earlier refusal: ask them anyway,
        // in order, rather than refuse on what may already have passed.
        for (const index of cooled) {
            const done = await settle(index, true);
            if (done) return done.value;
        }
        if (lastError) throw lastError;
        throw new NoRouteError(lastKind);
    }

    return {
        wrapGenerate: ({ params }) =>
            call(params, (model, adjusted) => model.doGenerate(adjusted), false),
        wrapStream: ({ params }) => call(params, (model, adjusted) => model.doStream(adjusted), true)
    };
}

/** A step its own allowance turned away for now. */
class Busy extends Error {
    constructor(readonly retryInMs: number) {
        super("the key is at its own limit");
        this.name = "Busy";
    }
}

/** Every step was ruled out before any was asked. Classified as a rate limit:
 *  the reader's keys are all at their own allowance. */
export class NoRouteError extends Error {
    readonly statusCode = 429;
    readonly responseBody = JSON.stringify({ error: { code: "rate_limit_exceeded" } });
    constructor(readonly kind: FailureKind | null) {
        super("every key is at its own limit or cooling down");
        this.name = "NoRouteError";
    }
}

function subjectOf(step: RouteStep) {
    return {
        provider: step.provider,
        model: step.modelId,
        keyId: step.keyId,
        coolingUntil: step.coolingUntil,
        coolingReason: step.coolingReason
    };
}
