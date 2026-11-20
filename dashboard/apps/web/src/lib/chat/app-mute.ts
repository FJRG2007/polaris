/**
 * Chat muted as a whole, from the app menu's right click.
 *
 * Chat's messages are not catalogue events, so this is a hold of its own
 * (`app:chat` in the account's notification holds) and every path that
 * interrupts somebody about a message asks it beside the conversation's own
 * mute: the message toast with its chime and desktop notice, the room mention
 * on the bell, and the message shown inside a game. A mention of the reader
 * gets through it unless it was set to hold mentions too - see
 * `core.chatMuteHolds`. Calls are not held, the
 * same as a muted conversation still rings, and the unread count stays: a mute
 * silences the interruption, not the record of what is waiting.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

const CHAT_KEY = core.holdKey({ kind: "app", id: "chat" });

/**
 * Which of these accounts have Chat muted at `now`, each with whether that mute
 * holds back a mention of them too.
 */
export async function chatMutes(
    userIds: Iterable<string>,
    now = new Date()
): Promise<Map<string, { readonly mentions: boolean }>> {
    const ids = [...new Set(userIds)];
    const muted = new Map<string, { readonly mentions: boolean }>();
    if (ids.length === 0) return muted;
    // Narrowed in the database to rows that name the key at all, so a large
    // audience reads only the few accounts that ever muted Chat.
    const rows = await prisma.user.findMany({
        where: { id: { in: ids }, notifyHolds: { contains: `"${CHAT_KEY}"` } },
        select: { id: true, notifyHolds: true }
    });
    for (const row of rows) {
        const holds = core.parseNotificationHolds(row.notifyHolds);
        if (!core.appHoldMuted(holds, "chat", now)) continue;
        muted.set(row.id, { mentions: core.appHoldMutesMentions(holds, "chat", now) });
    }
    return muted;
}

/** Which of these accounts have Chat muted at `now`. */
export async function chatMutedUsers(
    userIds: Iterable<string>,
    now = new Date()
): Promise<Set<string>> {
    return new Set((await chatMutes(userIds, now)).keys());
}
