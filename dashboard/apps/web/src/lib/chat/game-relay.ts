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
import { chatRelayer } from "@/lib/app-extensions/registry";
import { conversationName, describeFiles } from "./toasts";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { messageable, reachableChannelIds } from "./access";
import { mentionsReader, notifyLevels, readerTeams } from "./notify";

/** How much of a message goes into the game: a line of chat, not an essay. */
export const RELAY_EXCERPT = 200;

/** The most readers one message is relayed to. A room of hundreds is a channel
 *  rather than somebody waiting for you, and the game chat is not the place for
 *  a whole server's worth of traffic. */
const MOST_READERS = 50;

/** The most accounts that turned it on looked at for one channel message, most
 *  of whom will not be reading that channel at all. */
const MOST_CANDIDATES = 200;

/**
 * Show a message that has just been sent to whoever asked to see their messages
 * in a game. Resolves when every relay has been attempted; failures are logged
 * and swallowed.
 */
export async function relayToGames(messageId: string): Promise<void> {
    const relay = await chatRelayer();
    if (!relay) return;

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
            channel: { select: { spaceId: true, name: true } }
        }
    });
    if (!message || message.deletedAt || !message.authorId) return;
    const authorId = message.authorId;
    const { channelId, channel } = message;

    const readers = await readersOf(channelId, channel.spaceId, authorId);
    if (readers.length === 0) return;

    // A channel is called by its name; only a direct message or a group needs
    // the people in it, and only once somebody is going to be shown it.
    const [author, members] = await Promise.all([
        prisma.user.findUnique({ where: { id: authorId }, select: { name: true } }),
        channel.spaceId
            ? []
            : prisma.chatChannelMember.findMany({
                  where: { channelId },
                  select: { userId: true, user: { select: { name: true } } }
              })
    ]);
    const text = plainExcerpt(message.body, RELAY_EXCERPT) || describeFiles(message.attachments);

    let relayed = 0;
    for (const reader of readers) {
        if (relayed >= MOST_READERS) break;
        if (!(await interrupts(reader, channelId, authorId, message.body))) continue;
        relayed += 1;
        await relay({
            userId: reader.userId,
            author: author?.name || "Somebody",
            conversation: conversationName({ ...channel, members }, reader.userId),
            inChannel: channel.spaceId !== null,
            text
        });
    }
}

/**
 * The accounts that turned it on and can read this conversation now, as the
 * corner note decides that: the same reach, and the same `chat.use`.
 *
 * A direct message or a group is read only by its members, so they are the
 * whole list. A channel in a space is also read by everybody who reaches the
 * space or was handed the room, with no row of their own on it, so it starts
 * from the accounts that turned it on instead.
 */
async function readersOf(
    channelId: string,
    spaceId: string | null,
    authorId: string
): Promise<{ userId: string; muted: boolean; mutedUntil: Date | null }[]> {
    const candidates = spaceId
        ? (
              await prisma.user.findMany({
                  where: { messagesInGame: true, id: { not: authorId } },
                  select: { id: true },
                  orderBy: { id: "asc" },
                  take: MOST_CANDIDATES
              })
          ).map((user) => user.id)
        : (
              await prisma.chatChannelMember.findMany({
                  where: { channelId, userId: { not: authorId }, user: { messagesInGame: true } },
                  select: { userId: true },
                  take: MOST_CANDIDATES
              })
          ).map((member) => member.userId);
    if (candidates.length === 0) return [];

    const allowed = await messageable(candidates);
    const reading: string[] = [];
    for (const userId of candidates) {
        if (allowed.has(userId) && (await reachableChannelIds({ id: userId })).has(channelId)) {
            reading.push(userId);
        }
    }
    if (reading.length === 0) return [];

    const rows = await prisma.chatChannelMember.findMany({
        where: { channelId, userId: { in: reading } },
        select: { userId: true, muted: true, mutedUntil: true }
    });
    const muting = new Map(rows.map((row) => [row.userId, row]));
    return reading.map((userId) => ({
        userId,
        muted: muting.get(userId)?.muted ?? false,
        mutedUntil: muting.get(userId)?.mutedUntil ?? null
    }));
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
