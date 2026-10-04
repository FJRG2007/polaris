/**
 * What the list shows between a press and the mail server's answer.
 *
 * Every action on a conversation is a round trip to somebody else's mail server,
 * so the row changes the moment it is asked for and the server's answer either
 * agrees with it or takes it back. The screen (`mail-view`) owns when each of
 * these is called; the rules themselves are here, with nothing to render, so
 * they can be held to account on their own.
 */

import { leavesTheView } from "./mail-actions";
import type { MailAction } from "@/lib/mailbox/messages";

/** What an action changes about a row before the server has confirmed it. Only
 *  the things a list actually draws differently. */
export interface ThreadPatch {
    unreadCount?: number;
    starred?: boolean;
    important?: boolean;
    pinned?: boolean;
    muted?: boolean;
    /** Taken out of this list. Drawn as gone at once and put back if the server
     *  refuses, rather than left sitting there while a mail server is asked. */
    gone?: boolean;
}

/**
 * How a row should look the instant an action is asked for.
 *
 * Every action, including the ones that take the conversation out of the list.
 * That was held back at first on the grounds that a row vanishing and
 * reappearing after a refusal is worse than the wait - but the wait is a round
 * trip to somebody's mail server, and pressing Archive and watching the row sit
 * there reads as the button not having worked. A refusal is rare, it says why,
 * and the row comes back.
 */
export function optimistically(action: MailAction): ThreadPatch | null {
    switch (action) {
        case "read":
            return { unreadCount: 0 };
        case "unread":
            return { unreadCount: 1 };
        case "star":
            return { starred: true };
        case "unstar":
            return { starred: false };
        case "important":
            return { important: true };
        case "unimportant":
            return { important: false };
        default:
            return leavesTheView(action) ? { gone: true } : null;
    }
}

/** `held` with `change` laid over each of `ids`, as a new record. */
export function withPatch(
    held: Readonly<Record<string, ThreadPatch>>,
    ids: readonly string[],
    change: ThreadPatch
): Record<string, ThreadPatch> {
    const next = { ...held };
    for (const id of ids) next[id] = { ...next[id], ...change };
    return next;
}
