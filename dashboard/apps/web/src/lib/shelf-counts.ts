/**
 * What is waiting in each app, on the shelf that is open.
 *
 * The one place a badge above every screen gets its number, for the frame's
 * first paint and for the routes the badges recount through alike - so the two
 * cannot disagree, and neither can count a shelf the app itself does not list.
 * They did: Mail's badge was taken across every mailbox the account had, while
 * Mail lists the open shelf's, so a company mailbox's unread mail was a number
 * on somebody's personal shelf that opening Mail there showed nothing behind.
 *
 * Each count asks its app the same question the app's own listing asks, with
 * the shelf from the same switch. An app that starts counting adds itself here.
 *
 * Not everything is on a shelf. Management's queue is the instance's, and the
 * bell filters its own rows - see `lib/shelf` for the rule and
 * `notification-service` for where it is applied.
 */

import { unreadCounts } from "@/lib/mailbox/views";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { unreadTotal, type ChatUnread } from "@/lib/chat/chat-service";

export interface MailWaiting {
    readonly messages: number;
    readonly mailboxes: number;
}

/** Nothing waiting. Named so a failed count and a missing app say the same. */
export const NO_CHAT_WAITING: ChatUnread = { messages: 0, conversations: 0 };
export const NO_MAIL_WAITING: MailWaiting = { messages: 0, mailboxes: 0 };

/** Unread mail in the open shelf's mailboxes - the ones Mail lists there. */
export async function mailWaitingOnShelf(userId: string): Promise<MailWaiting> {
    const counts = await unreadCounts(userId, await scopeOrgIdFor(userId));
    return {
        messages: counts.total,
        mailboxes: Object.values(counts.byAccount).filter((one) => one > 0).length
    };
}

/** Unread chat in the conversations the open shelf's chat lists. The shelf is
 *  resolved inside Chat, which is where an organization keeping a chat of its
 *  own is decided - see `chat/isolation`. */
export async function chatWaitingOnShelf(userId: string): Promise<ChatUnread> {
    return unreadTotal({ id: userId });
}
