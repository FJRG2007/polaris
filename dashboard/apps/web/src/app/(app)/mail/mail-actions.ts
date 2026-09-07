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
