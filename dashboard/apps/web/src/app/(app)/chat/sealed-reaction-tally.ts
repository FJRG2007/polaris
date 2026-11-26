/**
 * The counts of sealed reactions (docs/chat-e2ee-mls.md, "Sealed reactions"),
 * made in the browser from the sets it opened, the same way the server counts
 * plain ones (`lib/chat/messages.ts`): one per person and emoji, a space's own
 * emoji counted by its id so a rename is one reaction, drawn by the newest
 * text seen.
 */

import * as core from "@polaris/core";
import type { ChatReactionView } from "@/lib/chat/messages";

/** One opened set: its emoji (null when it did not open here) and whether it is the reader's. */
export interface OpenedReactions {
    readonly emoji: readonly string[] | null;
    readonly mine: boolean;
}

/** What makes two reactions the same one: a space emoji's id, or the emoji itself. */
export const reactionKey = (emoji: string): string => core.parseCustomEmojiToken(emoji)?.id ?? emoji;

/** The plain counts with the opened sets counted in, in first-seen order. */
export function withSealedReactions(plain: readonly ChatReactionView[], sets: readonly OpenedReactions[]): ChatReactionView[] {
    const out = new Map<string, { emoji: string; count: number; mine: boolean }>();
    for (const view of plain) out.set(reactionKey(view.emoji), { ...view });
    for (const set of sets) {
        if (!set.emoji) continue;
        const seen = new Set<string>();
        for (const emoji of set.emoji) {
            const key = reactionKey(emoji);
            if (seen.has(key)) continue;
            seen.add(key);
            const tally = out.get(key) ?? { emoji, count: 0, mine: false };
            tally.count += 1;
            tally.emoji = emoji;
            if (set.mine) tally.mine = true;
            out.set(key, tally);
        }
    }
    return [...out.values()].filter((tally) => tally.count > 0);
}

/**
 * The counts drawn for a sealed-reaction message: the reader's own reactions
 * come from `own` alone (their sealed set, with whatever they still had in the
 * clear folded in), so a row patched on screen or a clear row the server has
 * since dropped is never counted next to the set that replaced it.
 */
export function countedFor(
    plain: readonly ChatReactionView[],
    sets: readonly OpenedReactions[],
    own: readonly string[]
): ChatReactionView[] {
    const others = plain
        .map((view) => (view.mine ? { ...view, count: view.count - 1, mine: false } : view))
        .filter((view) => view.count > 0);
    return withSealedReactions(others, [...sets.filter((set) => !set.mine), { emoji: own, mine: true }]);
}

/** This person's set with one emoji put on or taken off; a space emoji by its id. */
export function toggled(set: readonly string[], emoji: string, on: boolean): string[] {
    const key = reactionKey(emoji);
    const rest = set.filter((one) => reactionKey(one) !== key);
    return on ? [...rest, emoji] : rest;
}
