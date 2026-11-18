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
            if (chunk.type === "text-delta") parts[0]!.text += chunk.delta;
            else if (chunk.type === "tool-input-start" || chunk.type === "tool-input-available") {
                const type = chunk.dynamic ? "dynamic-tool" : `tool-${chunk.toolName}`;
                parts.push({ type, toolName: chunk.toolName });
            } else if (chunk.type === "tool-approval-request") {
                parts.push({ type: "tool-approval", state: "approval-requested" });
            } else if (chunk.type === "file") parts.push({ type: "file" });
            else if (chunk.type === "error" && !answered(parts)) {
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
