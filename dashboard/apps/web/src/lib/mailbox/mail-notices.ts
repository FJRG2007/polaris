/**
 * The bell's notices about a conversation, read when the conversation is.
 *
 * A bounce is announced on the bell with a link to its conversation. Reading,
 * filing or deleting that conversation in Mail used to leave the notice unread,
 * so the bell kept a count for mail somebody had already dealt with. Those
 * notices are read on the server in the same action, so the next frame of the
 * bell's stream agrees with the screen instead of bringing the count back.
 *
 * Never fails the action it follows: the mail moved, and a notice that could
 * not be marked is a count on the bell, not a reason to say the mail did not.
 */

import { prisma } from "@polaris/db";
import { conversationLink } from "./conversation-link";

/** Mark read the notices about these conversations. */
export async function readNoticesAboutThreads(
    userId: string,
    threadIds: readonly string[]
): Promise<void> {
    if (threadIds.length === 0) return;
    try {
        await prisma.notification.updateMany({
            where: {
                userId,
                readAt: null,
                href: { in: [...new Set(threadIds)].map(conversationLink) }
            },
            data: { readAt: new Date() }
        });
    } catch (caught) {
        console.error("polaris: mail notices could not be marked read:", caught);
    }
}

/** Mark read the notices about the conversations these messages belong to. */
export async function readNoticesAboutMessages(
    userId: string,
    messageIds: readonly string[]
): Promise<void> {
    if (messageIds.length === 0) return;
    try {
        const rows = await prisma.mailMessage.findMany({
            where: { id: { in: [...messageIds] }, account: { userId } },
            select: { threadId: true },
            distinct: ["threadId"]
        });
        await readNoticesAboutThreads(
            userId,
            rows.map((row) => row.threadId)
        );
    } catch (caught) {
        console.error("polaris: mail notices could not be marked read:", caught);
    }
}

/** Mark read every notice about a conversation, for "mark all mail read". */
export async function readEveryMailNotice(userId: string): Promise<void> {
    try {
        await prisma.notification.updateMany({
            where: { userId, readAt: null, href: { startsWith: conversationLink("") } },
            data: { readAt: new Date() }
        });
    } catch (caught) {
        console.error("polaris: mail notices could not be marked read:", caught);
    }
}
