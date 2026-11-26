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

/** This person's set with one emoji put on or taken off; a space emoji by its id. */
export function toggled(set: readonly string[], emoji: string, on: boolean): string[] {
    const key = reactionKey(emoji);
    const rest = set.filter((one) => reactionKey(one) !== key);
    return on ? [...rest, emoji] : rest;
}
