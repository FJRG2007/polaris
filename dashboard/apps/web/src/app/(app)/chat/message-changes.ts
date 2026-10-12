/**
 * Messages that changed in place, applied to what a screen holds.
 *
 * The live channel names the messages somebody edited, reacted to or deleted.
 * Asking for "what is newer than what I hold" brings none of them back - they
 * are not newer - which is how a deletion stayed on every other screen until it
 * was reloaded. So the screen reads the named ones again and swaps them in, and
 * one that does not come back is gone.
 *
 * Pure, so the arithmetic is tested without a conversation on screen.
 */

import type { ChatMessageView } from "@/lib/chat/messages";

/**
 * Which held messages to read again.
 *
 * The named ones, and every message quoting one of them: a reply's preview of
 * the line it answers is drawn by the server, and it says "deleted" only when
 * the reply is read again. An empty list from the frame means more changed than
 * it could name, so everything held is read again.
 */
export function changedTargets(
    held: readonly ChatMessageView[],
    named: readonly string[]
): string[] {
    if (named.length === 0) return held.map((message) => message.id);
    const wanted = new Set(named);
    return held
        .filter((message) => wanted.has(message.id) || wanted.has(message.quote?.id ?? ""))
        .map((message) => message.id);
}

/**
 * The window with the re-read messages swapped in.
 *
 * `asked` is what was read again and `fresh` what came back: an id asked for
 * and not returned left the conversation without trace, so it leaves the screen
 * too. Anything not asked about stays exactly as it is - including messages
 * that arrived while the read was out. Returns the same array when nothing
 * moved, so a caller can skip a redraw.
 */
export function applyChanged(
    held: readonly ChatMessageView[],
    asked: readonly string[],
    fresh: readonly ChatMessageView[]
): readonly ChatMessageView[] {
    const askedSet = new Set(asked);
    const byId = new Map(fresh.map((message) => [message.id, message]));
    let moved = false;
    const next: ChatMessageView[] = [];
    for (const message of held) {
        if (!askedSet.has(message.id)) {
            next.push(message);
            continue;
        }
        const replacement = byId.get(message.id);
        moved = true;
        if (replacement) next.push(replacement);
    }
    return moved ? next : held;
}

/** `ids` cut into runs of at most `size`, in order: one re-read each. */
export function inBatches(ids: readonly string[], size: number): string[][] {
    const batches: string[][] = [];
    for (let start = 0; start < ids.length; start += size)
        batches.push(ids.slice(start, start + size));
    return batches;
}
