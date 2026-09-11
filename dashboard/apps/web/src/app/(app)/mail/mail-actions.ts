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
 * What an action aimed at a row is aimed at: the conversation, or the one
 * message the row was named by.
 *
 * The list draws conversations, so a row is a conversation - but it is handed to
 * the server as the message that leads it, because that is what a mail server
 * has a word for. For Read and Unread the difference is visible: marking a
 * conversation of four read used to mark the newest of them, and the row stayed
 * bold with three unread under it, which reads as the button not working.
 *
 * A move stays the message. A conversation lives in several folders at once and
 * archiving "the conversation" would be a promise about mail the view is not
 * showing - the reasoning above `leavesTheView`.
 */
export function scopeOf(action: MailAction): "message" | "conversation" {
    return action === "read" || action === "unread" ? "conversation" : "message";
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

/**
 * How a dragged conversation names itself on the way to a folder.
 *
 * A type of its own rather than `text/plain`, so a rail entry can tell a
 * conversation from a file somebody dragged off their desktop and refuse the
 * one it cannot file - and so dropping mail into a text field elsewhere pastes
 * nothing.
 */
export const MAIL_DRAG_TYPE = "application/x-polaris-mail";
