/**
 * A Chat message, shown to its reader inside the game they are playing.
 *
 * Somebody on a game server is not looking at Polaris: the toast in the corner
 * of a tab they are not in, and the chime from a laptop across the room, reach
 * nobody. So an account that asks for it gets its messages in the game's own
 * chat as well, where only that player sees them.
 *
 * Who gets one is exactly who the corner note would have been for - the same
 * mute, the same "all / mentions / nothing" level, the same blocks, read through
 * the same functions - and then only the accounts that turned it on
 * (`User.messagesInGame`). Which game, which player and whether they are on is
 * the app's business, behind `relayChatMessage`; core knows nothing of any game.
 *
 * Never awaited by the send and never able to fail it: a message going out
 * matters more than any echo of it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { blockedBy } from "@/lib/blocks";
import { conversationName, describeFiles } from "./toasts";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { mentionsReader, notifyLevels, readerTeams } from "./notify";
import { relayChatMessage, relaysChatToGames } from "@/lib/app-extensions/registry";

/** How much of a message goes into the game: a line of chat, not an essay. */
export const RELAY_EXCERPT = 200;

/** The most readers one message is relayed to. A room of hundreds is a channel
 *  rather than somebody waiting for you, and the game chat is not the place for
 *  a whole server's worth of traffic. */
const MOST_READERS = 50;

/**
 * Show a message that has just been sent to whoever asked to see their messages
 * in a game. Resolves when every relay has been attempted; failures are logged
 * and swallowed.
 */
export async function relayToGames(messageId: string): Promise<void> {
    if (!(await relaysChatToGames())) return;

    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: {
            id: true,
            body: true,
            authorId: true,
            channelId: true,
            deletedAt: true,
            attachments: {
                orderBy: { createdAt: "asc" },
                select: { id: true, name: true, contentType: true, posterPath: true, spoiler: true }
            },
            channel: {
                select: {
                    spaceId: true,
                    name: true,
                    members: { select: { userId: true, user: { select: { name: true } } } }
                }
            }
        }
    });
    if (!message || message.deletedAt || !message.authorId) return;
    const authorId = message.authorId;

    // Only the members who turned it on are looked at at all - which is nearly
    // always nobody, and then this costs one query.
    const readers = await prisma.chatChannelMember.findMany({
        where: {
            channelId: message.channelId,
            userId: { not: authorId },
            user: { messagesInGame: true }
        },
        select: { userId: true, muted: true, mutedUntil: true },
        take: MOST_READERS
    });
    if (readers.length === 0) return;

    const author = await prisma.user.findUnique({ where: { id: authorId }, select: { name: true } });
    const text = plainExcerpt(message.body, RELAY_EXCERPT) || describeFiles(message.attachments);

    for (const reader of readers) {
        if (!(await interrupts(reader, message.channelId, authorId, message.body))) continue;
        await relayChatMessage({
            userId: reader.userId,
            author: author?.name || "Somebody",
            conversation: conversationName(message.channel, reader.userId),
            inChannel: message.channel.spaceId !== null,
            text
        });
    }
}

/**
 * Whether this message is one the corner note would have told this reader
 * about: not muted, not a conversation set to nothing, named in it where it is
 * set to mentions, and not from somebody they blocked.
 */
async function interrupts(
    reader: { userId: string; muted: boolean; mutedUntil: Date | null },
    channelId: string,
    authorId: string,
    body: string
): Promise<boolean> {
    if (core.muteInForce(reader)) return false;
    const level = (await notifyLevels(reader.userId, [channelId])).get(channelId) ?? "all";
    if (level === "none") return false;
    if (level === "mentions" && !mentionsReader(body, reader.userId, await readerTeams(reader.userId))) {
        return false;
    }
    return !(await blockedBy(reader.userId, [authorId])).has(authorId);
}
