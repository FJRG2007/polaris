/**
 * One compatible-API call, from a translated request to the AI SDK parts it
 * answers with, shared by the Anthropic and the OpenAI routes:
 *
 * 1. the model is routed (`route-model.ts`) and resolved through Polar's
 *    router, so the call gets the same key rotation, cooldowns and fallback
 *    chain a chat turn does;
 * 2. a caller paying with the shared key stops at an administrator's ceiling;
 * 3. the call is one model step with the client's tools declared and none run
 *    here - the client runs them and sends the results back;
 * 4. the stream is read until the model says something, so a refusal that
 *    comes before any output is answered with a real HTTP status instead of a
 *    200 stream that fails at once (free-claude-code holds the preamble the
 *    same way, `api/stream_delivery.py`); a coding tool retries on the status;
 * 5. what the model that actually answered spent is recorded as an `api` call.
 */

import type { z } from "zod";
import { rateLimit } from "@/lib/rate-limit-service";
import { readCappedBody } from "@/lib/request-body";
import { polarRouting } from "@/lib/polar/router/store";
import type { SdkReasoning } from "@/lib/polar/routing";
import type { TurnSignals } from "@/lib/polar/automatic";
import type { CompatCaller } from "@/lib/polar/compat/auth";
import { classifyProviderFailure } from "@/lib/polar/provider-failure";
import type { SdkToolChoice } from "@/lib/polar/compat/anthropic-request";
import { choiceFor, routeFor, routeReasoning } from "@/lib/polar/compat/route-model";
import { encodeToolNames, toolNameCodec, toolNamesOf, type ToolNameCodec } from "@/lib/polar/compat/tool-names";
import { answerUsage, polarLimitReached, recordPolarUsage, routeRecord } from "@/lib/polar/usage";
import { isStepCount, streamText, type ModelMessage, type TextStreamPart, type ToolSet } from "ai";
import { compatError, providerError, refusalError, type CompatError } from "@/lib/polar/compat/errors";
import { answeredBy, polarModelOptions, resolvePolarModel, type ResolvedModel } from "@/lib/polar/models";

export type Part = TextStreamPart<ToolSet>;

/** Calls one key's owner may make a minute. A coding tool fires a few per
 *  turn (the answer, a title, a token count), so this is well above a person
 *  typing and well below a runaway loop. */
const CALLS_PER_MINUTE = 120;

/** Most bytes a request body may hold: a long session with screenshots. */
export const COMPAT_BODY_MAX = 32 * 1024 * 1024;

/** The request body read and checked, or why it cannot be. */
export async function readJsonBody<Schema extends z.ZodTypeAny>(
    request: Request,
    schema: Schema
): Promise<z.infer<Schema> | CompatError> {
    const bytes = await readCappedBody(request, COMPAT_BODY_MAX);
    if (!bytes) return compatError("request_too_large", "The request body is too large.");
    let json: unknown;
    try {
        json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return compatError("invalid_request_error", "The request body is not valid JSON.");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue?.path.join(".") || "body";
        return compatError("invalid_request_error", `${where}: ${issue?.message ?? "invalid"}`);
    }
    return parsed.data;
}

export interface CompatCall {
    caller: CompatCaller;
    /** The model id the client sent. */
    model: string;
    /** The effort the client asked for. */
    reasoning: SdkReasoning | undefined;
    messages: ModelMessage[];
    tools?: ToolSet;
    toolChoice?: SdkToolChoice;
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    seed?: number;
    stopSequences?: string[];
    signal: AbortSignal;
}

/** What Automatic reads of a turn, from the messages sent. Pure. */
export function signalsOf(messages: readonly ModelMessage[], tools: boolean): TurnSignals {
    let contextChars = 0;
    let lastChars = 0;
    let files = 0;
    let calls = tools;
    for (const message of messages) {
        if (message.role === "tool") calls = true;
        const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
        let chars = 0;
        let attached = 0;
        for (const part of parts) {
            if (part.type === "text" && "text" in part) chars += part.text.length;
            else if (part.type === "image" || part.type === "file") attached += 1;
            else if (part.type === "tool-call") calls = true;
        }
        contextChars += chars;
        if (message.role === "user") {
            lastChars = chars;
            files = attached;
        }
    }
    return { files, tools: calls, contextChars, lastChars };
}

export interface PreparedCall {
    resolved: ResolvedModel;
    reasoning: SdkReasoning | undefined;
}

/** The model a call runs on, or why it cannot run. */
export async function prepareCall(call: CompatCall): Promise<PreparedCall | CompatError> {
    const { userId, access } = call.caller;
    const limited = await rateLimit(`polar-api:${userId}`, CALLS_PER_MINUTE, 60_000);
    if (!limited.ok) {
        return compatError(
            "rate_limit_error",
            "Too many requests to Polar from this account. Try again shortly.",
            Math.ceil(limited.retryAfterMs / 1000)
        );
    }
    const [routing, options] = await Promise.all([polarRouting(userId), polarModelOptions(userId, access)]);
    const route = routeFor(call.model, routing, options);
    if (route === "unknown_model") return refusalError("unknown_model");
    // The effort only picks Automatic's intelligence here; the router applies
    // the route's preference to the first step itself (`ResolveOptions`).
    const resolved = await resolvePolarModel(
        userId,
        choiceFor(route, routeReasoning(route, call.reasoning)),
        signalsOf(call.messages, call.tools !== undefined),
        access,
        { keyId: route.keyId, reasoning: route.forceOff ? "off" : route.preference, fallBack: true }
    );
    if (typeof resolved === "string") return refusalError(resolved);
    if (resolved.credential.source === "instance" && (await polarLimitReached(userId))) {
        return compatError(
            "rate_limit_error",
            "This account has reached the usage limit an administrator set for the shared model key."
        );
    }
    return { resolved, reasoning: call.reasoning };
}

/** What the model may write: what the client asked, never past what the
 *  model declares it can. */
function outputTokens(asked: number | undefined, declared: number | undefined): number | undefined {
    if (asked === undefined) return undefined;
    return declared && declared > 0 ? Math.min(asked, declared) : asked;
}

/** The parts with every tool name back in the client's own spelling. */
function decodedParts(iterator: AsyncIterator<Part>, codec: ToolNameCodec): AsyncIterator<Part> {
    if (!codec.hasAliases) return iterator;
    return {
        async next() {
            const next = await iterator.next();
            if (next.done) return next;
            const part = next.value;
            if (part.type === "tool-input-start" || part.type === "tool-call") {
                return { done: false, value: { ...part, toolName: codec.decode(part.toolName) } as Part };
            }
            return next;
        },
        return: async (value?: unknown) =>
            (await iterator.return?.(value)) ?? { done: true as const, value: undefined }
    };
}

/** Whether a part is the model saying something, which ends the preamble. */
const speaks = (part: Part) =>
    part.type !== "start" && part.type !== "start-step" && part.type !== "raw" && part.type !== "text-start";

export interface OpenedCall {
    parts: AsyncGenerator<Part>;
    /** Records what the answer spent; called once with the `finish` part. */
    record: (finish: Extract<Part, { type: "finish" }>) => void;
}

/**
 * Starts the call and reads it until the model speaks. A failure before that
 * is returned as an error to answer with; after it, the failure arrives as an
 * `error` part for the wire to put in its own shape.
 */
export async function openCall(call: CompatCall, prepared: PreparedCall): Promise<OpenedCall | CompatError> {
    const { resolved, reasoning } = prepared;
    const codec = toolNameCodec(toolNamesOf(call));
    const wire = encodeToolNames(
        { messages: call.messages, tools: call.tools, toolChoice: call.toolChoice },
        codec
    );
    const result = streamText({
        model: resolved.model,
        messages: wire.messages,
        tools: wire.tools,
        toolChoice: wire.toolChoice,
        maxOutputTokens: outputTokens(call.maxOutputTokens, resolved.option.outputTokens),
        temperature: call.temperature,
        topP: call.topP,
        topK: call.topK,
        presencePenalty: call.presencePenalty,
        frequencyPenalty: call.frequencyPenalty,
        seed: call.seed,
        stopSequences: call.stopSequences,
        // What the client asked; the router turns it into each step's effort.
        reasoning,
        // The router already retries and walks the keys and the fallbacks; a
        // retry here would walk the whole plan again.
        maxRetries: 0,
        // One step: the client runs its own tools.
        stopWhen: isStepCount(1),
        abortSignal: call.signal,
        // Failures reach the wire as `error` parts; the log line is ours.
        onError: ({ error }) => {
            const failure = classifyProviderFailure(error);
            console.warn(`polar api: call failed (${failure.kind}, ${failure.status ?? "no status"})`);
        }
    });
    const iterator = decodedParts(result.fullStream[Symbol.asyncIterator](), codec);
    const held: Part[] = [];
    for (;;) {
        let next: IteratorResult<Part>;
        try {
            next = await iterator.next();
        } catch (error) {
            return providerError(error);
        }
        if (next.done) break;
        if (next.value.type === "error") {
            await iterator.return?.();
            return providerError(next.value.error);
        }
        held.push(next.value);
        if (speaks(next.value)) break;
    }
    async function* parts(): AsyncGenerator<Part> {
        yield* held;
        for (;;) {
            let next: IteratorResult<Part>;
            try {
                next = await iterator.next();
            } catch (error) {
                yield { type: "error", error };
                return;
            }
            if (next.done) return;
            yield next.value;
        }
    }
    let recorded = false;
    const record = (finish: Extract<Part, { type: "finish" }>) => {
        if (recorded) return;
        recorded = true;
        const answered = answeredBy(resolved);
        void recordPolarUsage({
            userId: call.caller.userId,
            threadId: null,
            messageId: null,
            provider: answered.option.provider,
            model: answered.option.model,
            payer: answered.credential.source,
            usage: answerUsage(finish.totalUsage, answered.option),
            ...routeRecord(resolved),
            surface: "api"
        }).catch((error: unknown) => {
            console.error("polar api: usage not recorded", error instanceof Error ? error.message : error);
        });
    };
    return { parts: parts(), record };
}

/** The frames a wire writes for each moment of the answer. */
export interface WireWriter<Frame> {
    start(): Frame[];
    part(part: Part): Frame[];
    finish(finish: Extract<Part, { type: "finish" }>): Frame[];
    error(error: CompatError): Frame[];
}

/** Every frame of an answer, in order, ending at its finish or its failure. */
export async function* answerFrames<Frame>(opened: OpenedCall, writer: WireWriter<Frame>): AsyncGenerator<Frame> {
    yield* writer.start();
    for await (const part of opened.parts) {
        if (part.type === "error") {
            yield* writer.error(providerError(part.error));
            return;
        }
        if (part.type === "abort") return;
        if (part.type === "finish") {
            opened.record(part);
            yield* writer.finish(part);
            return;
        }
        yield* writer.part(part);
    }
    // The stream ended without a finish: the provider hung up.
    yield* writer.error(compatError("api_error", "The model stopped answering before it finished."));
}

/** Every frame, for an answer that is not streamed. */
export async function allFrames<Frame>(frames: AsyncGenerator<Frame>): Promise<Frame[]> {
    const out: Frame[] = [];
    for await (const frame of frames) out.push(frame);
    return out;
}
