/**
 * Whether a finished answer said nothing. A turn can end on its tool steps -
 * the model stopped, or a provider ignored the last step's "answer now" - and
 * the screen would show the steps with nothing under them, which reads as an
 * answer that never came.
 *
 * And the other way round: a turn that did answer - text, a view it drew - and
 * then broke on a later call is not a turn that could not answer, so no
 * failure is written into it (`failureIntoAnswer`) or drawn under it
 * (`answered`).
 */

import type { UIMessageChunk } from "ai";
import {
    FAILURE_PART,
    decodeLocalFailure,
    decodePolarFailure,
    decodeSubscriptionFailure
} from "@/lib/polar/provider-failure";
import { POLAR_VISUAL_TOOL } from "@/lib/polar/visuals";
import { POLAR_ASK_TOOL } from "@/lib/polar/ask";
import { POLAR_FORM_TOOL } from "@/lib/polar/forms";
import { withoutPseudoToolCalls } from "@/lib/polar/pseudo-tools";

type AnswerPart = { type: string; text?: string; state?: string; toolName?: string };

/** True when nothing in the answer is for the person to read or act on. */
export function answeredNothing(parts: readonly AnswerPart[]): boolean {
    return !parts.some(
        (part) =>
            (part.type === "text" && !!withoutPseudoToolCalls(part.text ?? "").trim()) ||
            part.type === "file" ||
            part.type === FAILURE_PART ||
            part.type === `tool-${POLAR_VISUAL_TOOL}` ||
            part.type === `tool-${POLAR_ASK_TOOL}` ||
            part.type === `tool-${POLAR_FORM_TOOL}` ||
            (part.type === "dynamic-tool" && part.toolName === POLAR_VISUAL_TOOL) ||
            part.state === "approval-requested"
    );
}

/** True when the answer has something for the person besides a failure. Pure. */
export function answered(parts: readonly AnswerPart[]): boolean {
    return !answeredNothing(parts.filter((part) => part.type !== FAILURE_PART));
}

/**
 * A provider's refusal mid-answer is also written into the answer, just before
 * the stream's error, so the stored message says why it stopped - unless the
 * answer already has something to show, which a later refusal does not take
 * back.
 */
export function failureIntoAnswer(): TransformStream<UIMessageChunk, UIMessageChunk> {
    const parts: AnswerPart[] = [{ type: "text", text: "" }];
    return new TransformStream({
        transform(chunk, controller) {
            trackPart(parts, chunk);
            if (chunk.type === "error" && !answered(parts)) {
                const failure =
                    decodePolarFailure(chunk.errorText) ??
                    decodeSubscriptionFailure(chunk.errorText) ??
                    decodeLocalFailure(chunk.errorText);
                if (failure) controller.enqueue({ type: FAILURE_PART, data: failure });
            }
            controller.enqueue(chunk);
        }
    });
}

/** Adds what a chunk puts in the answer to `parts`, whose first entry holds the
 *  answer's text so far. */
function trackPart(parts: AnswerPart[], chunk: UIMessageChunk): void {
    if (chunk.type === "text-delta") parts[0]!.text += chunk.delta;
    else if (chunk.type === "tool-input-start" || chunk.type === "tool-input-available") {
        const type = chunk.dynamic ? "dynamic-tool" : `tool-${chunk.toolName}`;
        parts.push({ type, toolName: chunk.toolName });
    } else if (chunk.type === "tool-approval-request") {
        parts.push({ type: "tool-approval", state: "approval-requested" });
    } else if (chunk.type === "file") parts.push({ type: "file" });
}

/**
 * The message the one step after an empty ending is asked with: the model
 * has what its tools returned and is told to answer from it.
 */
export const FINAL_ANSWER_NUDGE =
    "Answer the request above now, in plain words, from what your tool calls returned. Do not call any more tools.";

/**
 * A turn that ends on its tool steps with nothing for the person gets one more
 * step: `more` is asked for it (a call with no tools offered), its chunks
 * follow the answer's own, and the answer's finish comes last - through
 * `finished`, so what it says (the usage) can count that step too. Nothing
 * more is asked after a failure or a stop, or when the answer did say
 * something.
 */
export function finalAnswer(
    more: () => Promise<ReadableStream<UIMessageChunk> | null>,
    finished?: (held: UIMessageChunk) => Promise<UIMessageChunk>
): TransformStream<UIMessageChunk, UIMessageChunk> {
    const parts: AnswerPart[] = [{ type: "text", text: "" }];
    let held: UIMessageChunk | null = null;
    let ended = false;
    return new TransformStream({
        transform(chunk, controller) {
            trackPart(parts, chunk);
            if (chunk.type === "error" || chunk.type === "abort") ended = true;
            if (chunk.type === "finish") held = chunk;
            else controller.enqueue(chunk);
        },
        async flush(controller) {
            if (held && !ended && answeredNothing(parts)) {
                let extra: ReadableStream<UIMessageChunk> | null = null;
                try {
                    extra = await more();
                } catch (error) {
                    console.error("polar: could not ask for the answer after the tool steps", error);
                }
                if (extra) {
                    const reader = extra.getReader();
                    for (;;) {
                        const next = await reader.read();
                        if (next.done) break;
                        if (next.value.type === "start" || next.value.type === "finish") continue;
                        controller.enqueue(next.value);
                    }
                    if (finished) held = await finished(held).catch(() => held!);
                }
            }
            if (held) controller.enqueue(held);
        }
    });
}
