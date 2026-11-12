/**
 * Chat muted as a whole, from the app menu's right click.
 *
 * Chat's messages are not catalogue events, so this is a hold of its own
 * (`app:chat` in the account's notification holds) and every path that
 * interrupts somebody about a message asks it beside the conversation's own
 * mute: the message toast with its chime and desktop notice, the room mention
 * on the bell, and the message shown inside a game. Calls are not held, the
 * same as a muted conversation still rings, and the unread count stays: a mute
 * silences the interruption, not the record of what is waiting.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

const CHAT_KEY = core.holdKey({ kind: "app", id: "chat" });

/** Which of these accounts have Chat muted at `now`. */
export async function chatMutedUsers(
    userIds: Iterable<string>,
    now = new Date()
): Promise<Set<string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Set();
    // Narrowed in the database to rows that name the key at all, so a large
    // audience reads only the few accounts that ever muted Chat.
    const rows = await prisma.user.findMany({
        where: { id: { in: ids }, notifyHolds: { contains: `"${CHAT_KEY}"` } },
        select: { id: true, notifyHolds: true }
    });
    return new Set(
        rows
            .filter((row) =>
                core.appHoldMuted(core.parseNotificationHolds(row.notifyHolds), "chat", now)
            )
            .map((row) => row.id)
    );
}
