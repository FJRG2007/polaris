/**
 * What an action does to the conversation it was aimed at, as far as a screen is
 * concerned.
 *
 * Its own module because both the list and the reading pane need the answer and
 * each already imports the other - the list renders the pane, the pane reads the
 * list's context type - so putting it in either would close that loop.
 */

import type { MailAction } from "@/lib/mailbox/messages";

/**
 * Whether the conversation stops being in the view it was acted on from.
 *
 * Every one of these is a move on the mail server, and a move drops the rows the
 * screen was reading: the destination decides the uids, so they are fetched
 * again rather than guessed at. Which means the conversation that was open beside
 * the list is, a moment later, a conversation the server has never heard of - and
 * a pane still asking for it is the screen breaking rather than the message going
 * away. Whoever asks for one of these has to close what was open.
 */
export function leavesTheView(action: MailAction): boolean {
    switch (action) {
        case "archive":
        case "trash":
        case "delete":
        case "junk":
        case "not-junk":
        case "inbox":
            return true;
        default:
            return false;
    }
}

/**
 * The run of rows between the last one picked on its own and the one just
 * clicked, both included.
 *
 * Identified by id rather than by position, because the list is redrawn from
 * the server between two clicks - a sync lands, a message arrives - and a
 * remembered index would by then be pointing at a different conversation than
 * the one somebody actually clicked. Either end being gone leaves just the row
 * that was clicked, which is what a plain click does and is never surprising.
 */
export function runBetween(
    ids: readonly string[],
    anchor: string,
    target: string
): readonly string[] {
    const from = ids.indexOf(anchor);
    const to = ids.indexOf(target);
    if (from === -1 || to === -1) return target ? [target] : [];
    return ids.slice(Math.min(from, to), Math.max(from, to) + 1);
}
