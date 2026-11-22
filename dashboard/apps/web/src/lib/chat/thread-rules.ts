/**
 * Where a new thread may be started.
 *
 * Pure, so the message menus and the send path reach the same answer: in a
 * space's channels always; in a direct message or a group outside a space only
 * when an administrator has switched threads on there (Chat > Settings), which
 * is off by default, as it is on Discord. A thread that already has replies is
 * never closed by the switch - it stays readable and answerable, because
 * turning the setting off decides what is started next, not what is already
 * written.
 */

import { hasDirectRules } from "./vanish-rules";

export function mayStartThread(
    channel: { readonly kind: string; readonly spaceId: string | null },
    directThreads: boolean,
    /** Replies already under the message, which makes it an existing thread. */
    replyCount = 0
): boolean {
    return replyCount > 0 || directThreads || !hasDirectRules(channel);
}
