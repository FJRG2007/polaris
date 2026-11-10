/**
 * Carrying on an answer another model started.
 *
 * Once a stream has reached the reader it cannot be taken back, so a provider
 * that fails halfway used to end the answer there. free-claude-code continues
 * it instead (`core/stream_recovery.py`, `core/continuation_request.py`): the
 * next model is shown what was already written as its own reply, asked to carry
 * on exactly where it stopped, and whatever it repeats of that is cut off before
 * the reader sees it. The same rules hold here:
 *
 * - only plain text continues. Once a tool call has started streaming the turn
 *   is not resumable - half a call cannot be finished by somebody else - and a
 *   structured answer (`responseFormat: json`) is not either, since a second
 *   model's half cannot be trusted to close the first one's object;
 * - a refusal that says the call itself is wrong (`other`, such as a content
 *   refusal) is not worked around by asking somebody else; a dropped
 *   connection is, because that is the case this exists for.
 *
 * Pure, apart from the stream transform.
 */

import type { LanguageModelMiddleware } from "ai";
import { classifyProviderFailure, type FailureKind } from "@/lib/polar/provider-failure";

type CallParams = Parameters<NonNullable<LanguageModelMiddleware["wrapStream"]>>[0]["params"];

/** What one stream has already put in front of the reader. */
export interface Delivered {
    text: string;
    /** A tool call started streaming: the turn can no longer be continued. */
    tools: boolean;
}

/** The most of the delivered answer compared against a continuation's start,
 *  and the most kept to show the next model (free-claude-code keeps 1 MiB). */
export const OVERLAP_WINDOW = 2_000;
export const SEED_LIMIT = 1_048_576;

/** How many times one answer is carried on before a failure is surfaced. */
export const MAX_CONTINUATIONS = 2;

/** The refusals a continuation answers for, besides a dropped connection. */
const CONTINUABLE: ReadonlySet<FailureKind> = new Set([
    "key",
    "credit",
    "paid",
    "rate",
    "busy",
    "down",
    "model"
]);

/** A connection that broke under a stream, as Node's fetch and undici say it. */
const BROKEN = /terminated|socket|ECONNRESET|EPIPE|network|premature|other side closed|stream (was )?(closed|aborted)/i;

/** Whether a failure in the middle of a stream is one worth carrying on from. */
export function continuable(error: unknown): boolean {
    if (CONTINUABLE.has(classifyProviderFailure(error).kind)) return true;
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return BROKEN.test(message);
}

/** The instruction free-claude-code gives the next model, word for word. */
export function continuationInstruction(hasTools: boolean): string {
    const lines = [
        "The previous provider stream was interrupted. Continue the assistant response exactly",
        "where it stopped. Do not repeat thinking or text already written."
    ];
    if (hasTools) {
        lines.push(
            "No tool calls from this interrupted assistant turn were delivered or executed.",
            "Any unfinished calls were discarded. Emit the required tool calls using the provided tools."
        );
    }
    return lines.join(" ");
}

/** The call again, with what was already written as the model's own reply and
 *  the instruction to carry on after it. */
export function continuationParams(params: CallParams, delivered: string): CallParams {
    const seed = delivered.length > SEED_LIMIT ? delivered.slice(-SEED_LIMIT) : delivered;
    return {
        ...params,
        prompt: [
            ...params.prompt,
            { role: "assistant", content: [{ type: "text", text: seed }] },
            {
                role: "user",
                content: [{ type: "text", text: continuationInstruction((params.tools?.length ?? 0) > 0) }]
            }
        ]
    };
}

/**
 * What of `candidate` is new after `existing`: free-claude-code's
 * `continuation_suffix`. A continuation that starts by repeating the end of
 * what was written loses the repeat; one that shares nothing is kept whole.
 */
export function continuationSuffix(existing: string, candidate: string): string {
    if (!candidate || !existing) return candidate;
    if (candidate.startsWith(existing)) return candidate.slice(existing.length);
    for (let size = Math.min(existing.length, candidate.length); size > 0; size--) {
        if (existing.endsWith(candidate.slice(0, size))) return candidate.slice(size);
    }
    return candidate;
}

/**
 * A continuation stream as the reader should see it: no second `stream-start`,
 * and its first words checked against the end of what was already written, the
 * repeat cut off. Text is held only until it is as long as that window or
 * something other than text arrives.
 */
export function withoutOverlap<P extends { type: string }>(
    stream: ReadableStream<P>,
    delivered: string
): ReadableStream<P> {
    const tail = delivered.slice(-OVERLAP_WINDOW);
    let pending = tail.length > 0;
    let held = "";
    let heldId: string | null = null;

    const flush = (controller: TransformStreamDefaultController<P>) => {
        if (!pending) return;
        pending = false;
        const text = continuationSuffix(tail, held);
        if (text && heldId !== null) {
            controller.enqueue({ type: "text-delta", id: heldId, delta: text } as unknown as P);
        }
        held = "";
    };

    return stream.pipeThrough(
        new TransformStream<P, P>({
            transform(part, controller) {
                if (part.type === "stream-start") return;
                if (pending && part.type === "text-delta") {
                    const delta = part as unknown as { id: string; delta: string };
                    heldId ??= delta.id;
                    held += delta.delta;
                    if (held.length >= tail.length) flush(controller);
                    return;
                }
                if (pending && part.type !== "text-start" && part.type !== "response-metadata") {
                    flush(controller);
                }
                controller.enqueue(part);
            },
            flush(controller) {
                flush(controller);
            }
        })
    );
}
