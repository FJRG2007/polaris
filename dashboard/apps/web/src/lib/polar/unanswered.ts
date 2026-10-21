/**
 * Whether a finished answer said nothing. A turn can end on its tool steps -
 * the model stopped, or a provider ignored the last step's "answer now" - and
 * the screen would show the steps with nothing under them, which reads as an
 * answer that never came.
 */

import { FAILURE_PART } from "@/lib/polar/provider-failure";
import { POLAR_VISUAL_TOOL } from "@/lib/polar/visuals";

type AnswerPart = { type: string; text?: string; state?: string; toolName?: string };

/** True when nothing in the answer is for the person to read or act on. */
export function answeredNothing(parts: readonly AnswerPart[]): boolean {
    return !parts.some(
        (part) =>
            (part.type === "text" && !!part.text?.trim()) ||
            part.type === "file" ||
            part.type === FAILURE_PART ||
            part.type === `tool-${POLAR_VISUAL_TOOL}` ||
            (part.type === "dynamic-tool" && part.toolName === POLAR_VISUAL_TOOL) ||
            part.state === "approval-requested"
    );
}
