/**
 * Whether a call that has just ended was a call at all, and who missed it.
 *
 * Pure, and separate from the room it is about, because the question is a small
 * piece of reasoning with three ways to get it subtly wrong - and every one of
 * them is a line written into somebody's conversation that should not be there.
 *
 * What counts as missed:
 *
 * - **Somebody answering makes it a call, not a missed one.** However briefly,
 *   and whoever it was: a call three of five people joined is a call, and the
 *   two who did not are not owed a notice saying nobody picked up.
 * - **The person who rang never missed their own call**, even though they are in
 *   the conversation and, once the room is closed, out of it like everybody else.
 * - **Somebody who has blocked the caller was never rung**, so there is nothing
 *   for them to have missed. Their telephone is deliberately silent, and a
 *   notification saying they missed a call would walk straight around that.
 *
 * The one judgement worth stating: a declined call and an unanswered one are the
 * same thing here, exactly as they are on the card that rang. Polaris has no
 * business telling a caller which of the two happened.
 */

/** What a room looked like when it closed. */
export interface CallOutcome {
    /** Who started it, and rang everybody else. */
    readonly hostId: string;
    /** Everybody the conversation could have rung. */
    readonly members: readonly string[];
    /** Everybody who took a seat in it, at any point. Guests have no account and
     *  are not in here; a guest answering still counts, which is why the caller
     *  passes them as `answeredByGuest`. */
    readonly seated: readonly string[];
    /** Whoever has blocked the caller, and so was never rung. */
    readonly unreachable?: readonly string[];
    /** Whether somebody with no Polaris account answered on a guest link. */
    readonly answeredByGuest?: boolean;
}

/**
 * Everybody who was rung and did not answer, or an empty list when the call was
 * answered by anybody at all.
 *
 * Empty is the ordinary case: most calls are answered, and the caller writes
 * nothing.
 */
export function whoMissedTheCall(outcome: CallOutcome): string[] {
    if (outcome.answeredByGuest) return [];
    const seated = new Set(outcome.seated);
    // Anybody but the host having sat in it means it happened.
    for (const userId of seated) {
        if (userId !== outcome.hostId) return [];
    }
    const shut = new Set(outcome.unreachable ?? []);
    return [
        ...new Set(
            outcome.members.filter(
                (userId) => userId !== outcome.hostId && !seated.has(userId) && !shut.has(userId)
            )
        )
    ];
}
