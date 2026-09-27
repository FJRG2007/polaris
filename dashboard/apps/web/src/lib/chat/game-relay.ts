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
 * the same functions - and then only the accounts it is on for
 * (`User.messagesInGame`): by default a direct message or a group of up to
 * `SMALL_GROUP_SIZE`, where somebody is writing to you; turned on, every channel and
 * group too; turned off, nothing. Which game, which player and whether they are on is
 * the app's business, behind `relayChatMessage`; core knows nothing of any game.
 *
 * Never awaited by the send and never able to fail it: a message going out
 * matters more than any echo of it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { blockedBy } from "@/lib/blocks";
import { channelRelayer, chatRelayer } from "@/lib/app-extensions/registry";
import { conversationName, filesLabel } from "./toasts";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { SMALL_GROUP_SIZE } from "./in-game-choice";
import { messageable, reachableChannelIds } from "./access";
import { mentionsReader, notifyLevels, readerTeams } from "./notify";

/** How much of a message goes into the game: a line of chat, not an essay. */
export const RELAY_EXCERPT = 200;

/** The most of a poll's answers carried into the game; the rest are in Polaris. */
const POLL_OPTIONS = 10;

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
    const [relay, shown] = await Promise.all([chatRelayer(), channelRelayer()]);
    if (!relay && !shown) return;

    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: {
            id: true,
            kind: true,
            body: true,
            authorId: true,
            channelId: true,
            deletedAt: true,
            forwarded: true,
            attachments: {
                orderBy: { createdAt: "asc" },
                select: { name: true, contentType: true, spoiler: true }
            },
            poll: {
                select: { options: { orderBy: { position: "asc" }, select: { text: true } } }
            },
            channel: { select: { spaceId: true, name: true } }
        }
    });
    if (!message || message.deletedAt || !message.authorId) return;
    const authorId = message.authorId;
    const { channelId, channel } = message;
    const text = plainExcerpt(message.body, RELAY_EXCERPT);
    const files = filesLabel(message.attachments);
    const poll =
        message.kind === "poll" && message.poll
            ? message.poll.options.slice(0, POLL_OPTIONS).map((option) => option.text)
            : null;

    // A channel a game shows to everybody playing, whoever is reading: the
    // operator who linked it decided that, not each reader. Named by the
    // conversation's own name - a group without one is not called after its
    // members in front of people who are not in it.
    if (shown) {
        const author = await prisma.user.findUnique({
            where: { id: authorId },
            select: { name: true }
        });
        await shown({
            channelId,
            author: author?.name || "Somebody",
            conversation: channel.name || "Group",
            text,
            files,
            poll,
            forwarded: message.forwarded
        });
    }
    if (!relay) return;

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
            text,
            files,
            poll,
            forwarded: message.forwarded,
            channelId
        });
    }
}

/**
 * The accounts that turned it on and can read this conversation now, as the
 * corner note decides that: the same reach, and the same `chat.use`.
 *
 * A direct message or a group is read only by its members, so they are the
 * whole list: each one it is not turned off for, or in a group larger than
 * `SMALL_GROUP_SIZE` each one that turned everything on. A channel in a space is also
 * read by everybody who reaches the space or was handed the room, with no row of
 * their own on it, so it starts from the accounts that turned everything on.
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
        : await groupMembers(channelId, authorId);
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

/** The members of a direct message or group it is on for, asked of the
 *  database before the cap so a large group's opted-in members are not cut. */
async function groupMembers(channelId: string, authorId: string): Promise<string[]> {
    const size = await prisma.chatChannelMember.count({ where: { channelId } });
    const small = size <= SMALL_GROUP_SIZE;
    const members = await prisma.chatChannelMember.findMany({
        where: {
            channelId,
            userId: { not: authorId },
            user: small
                ? { OR: [{ messagesInGame: true }, { messagesInGame: null }] }
                : { messagesInGame: true }
        },
        select: { userId: true, user: { select: { messagesInGame: true } } },
        orderBy: { userId: "asc" },
        take: MOST_CANDIDATES
    });
    return groupCandidates(members, authorId, size);
}

/** The members of a direct message or group it is on for, as `readersOf` says. */
export function groupCandidates(
    members: readonly { userId: string; user: { messagesInGame: boolean | null } }[],
    authorId: string,
    size: number = members.length
): string[] {
    const small = size <= SMALL_GROUP_SIZE;
    return members
        .filter((member) => member.userId !== authorId)
        .filter((member) =>
            member.user.messagesInGame === null ? small : member.user.messagesInGame
        )
        .map((member) => member.userId);
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
    if (
        level === "mentions" &&
        !mentionsReader(body, reader.userId, await readerTeams(reader.userId))
    ) {
        return false;
    }
    return !(await blockedBy(reader.userId, [authorId])).has(authorId);
}
