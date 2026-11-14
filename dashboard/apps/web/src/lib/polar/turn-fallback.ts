/**
 * Whether a chat turn hands itself to the next model when the one answering it
 * cannot: out of credit, a refused key, a rate limit, an outage, a model gone
 * (`isRoutable` in `router/chain.ts`).
 *
 * A model Polar chose - Automatic, Polar's or an agent's own list, the first
 * model offered when the one picked was retired - is a means to an answer, so
 * the turn walks on to the next one that fits. A model the person picked by
 * hand is what they asked for: its refusal is shown with its actions, and the
 * turn only walks the fallback list they configured themselves
 * (`pinnedFallsBack`). The technique is OpenRouter's `models` fallback list:
 * the same request, retried down an ordered list on a provider error.
 *
 * Pure and isomorphic.
 */

import { isAutomatic, type ModelChoice } from "@/lib/polar/shared";

type Named = Pick<ModelChoice, "provider" | "model">;

/** Whether the person picked the model answering this turn by hand. */
export function pinnedByHand(picked: Named, answering: Named): boolean {
    if (isAutomatic(picked)) return false;
    return picked.provider === answering.provider && picked.model === answering.model;
}

/**
 * The choices a turn moves on to after the one answering it, in order: the
 * rest of the list it was resolved from, then Automatic unless the list is all
 * the turn may use. None for a model picked by hand.
 */
export function turnStandIns(
    picked: ModelChoice,
    tries: readonly ModelChoice[],
    answering: ModelChoice,
    keepsToList: boolean,
    automatic: ModelChoice
): ModelChoice[] {
    if (pinnedByHand(picked, answering)) return [];
    const at = tries.findIndex(
        (entry) => entry.provider === answering.provider && entry.model === answering.model
    );
    const later = (at >= 0 ? tries.slice(at + 1) : []).filter((entry) => !isAutomatic(entry));
    return keepsToList || isAutomatic(answering) ? later : [...later, automatic];
}
