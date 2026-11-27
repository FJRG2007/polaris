/**
 * `@everyone` and `@here`, made to mean something.
 *
 * They are stored as the text somebody typed rather than as a reference,
 * because there is nothing to point at: they mean "this conversation", which the
 * message already belongs to. What makes them work is here - the moment a
 * message carrying one lands, everybody it names is told.
 *
 * The two differ in exactly one way and it is the reason both exist. `@everyone`
 * reaches the whole room, including the person who has not looked at Polaris
 * since Tuesday. `@here` reaches the people who are actually at their screen, so
 * it can be used to ask a question without waking anybody who is not around to
 * answer it.
 *
 * Deliberately not in a direct message. There is nobody in a one-to-one
 * conversation who is not already being written to, so `@everyone` in one is
 * decoration - and sending a notification for it would mean every message
 * containing the word could ping somebody twice.
 *
 * Somebody who has muted the conversation, or Chat as a whole, is still told:
 * Discord counts `@everyone` and `@here` as mentions that get through a mute,
 * and so does this. Only a mute set to hold mentions too keeps them out - the
 * same answer Discord's "Suppress @everyone and @here" gives - see
 * `core.chatMuteHolds`. Somebody who set the conversation, or the space it is
 * in, to notify them about nothing is not told, as with Discord's "Nothing".
 * Setting it to mentions does not skip them: this is the mention.
 *
 * Nor is somebody who has blocked whoever wrote it. `@everyone` is the one place
 * a blocked account can still reach a whole room's notifications without
 * addressing anybody, which is exactly what a block is for.
 *
 * A group's owner can keep both to themselves. Then a message from anybody else
 * that carries one is refused rather than sent - see `refuseRoomMention`.
 */

import { prisma } from "@polaris/db";
import { lockedFor } from "./chat-lock";
import * as core from "@polaris/core";
import { muteStates, silencedIn } from "./notify";
import { blockersOf } from "@/lib/blocks";
import { onlineUserIds } from "@/lib/notifications/presence";
import { createNotification } from "@/lib/notification-service";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { channelMentions } from "@/components/rich-text/markdown";
import { chatAlertShelf } from "./isolation";
import { chatWordsFor } from "./text";
import { inBatches } from "./bounded";
import { recipientShelf } from "@/lib/workspace-scope";
import {
    ChatAccessError,
    roomMentionsAllowed,
    runsSpace,
    spaceAccess,
    type ChannelAccess,
    type ChatActor,
    type ChatErrorText
} from "./access";

/** What somebody is told when the owner of a group has kept these to themselves. */
const ROOM_MENTION_REFUSED: ChatErrorText = { key: "errors.roomMentionOwnerOnly" };

/** What somebody is told in a space whose admins kept these to themselves. */
const ROOM_MENTION_SPACE_REFUSED: ChatErrorText = { key: "errors.roomMentionAdminsOnly" };

/**
 * Refuse a message that names the room from somebody the room does not let.
 *
 * Refused rather than sent as plain text, because every place that reads a
 * message - the notification, the toast for somebody following only mentions,
 * the mark in the list - decides "this names me" from the text alone. Sending it
 * quietly would have to teach all three who was allowed to say it at the time,
 * and the day one of them forgot, the whole group would be pinged anyway. The
 * composer does not offer the words to whoever this refuses, so this is met
 * only by somebody who typed them out.
 *
 * Asked of the row on every call rather than of the screen: a switch hidden from
 * somebody is not a rule. Only a group can say no, and only a message that
 * names the room is read for it, which is nearly none of them.
 */
export async function refuseRoomMention(
    actor: ChatActor,
    access: ChannelAccess,
    body: string
): Promise<void> {
    if (access.kind !== "group" && !access.spaceId) return;
    if (!body.includes("@") || channelMentions(body).size === 0) return;
    const channel = await prisma.chatChannel.findUnique({
        where: { id: access.channelId },
        select: {
            kind: true,
            ownerId: true,
            createdById: true,
            membersMayMention: true,
            spaceId: true,
            space: { select: { membersMayMentionEveryone: true } }
        }
    });
    if (!channel) return;
    if (channel.kind === "group") {
        if (!roomMentionsAllowed(channel, actor.id)) throw new ChatAccessError(ROOM_MENTION_REFUSED);
        return;
    }
    if (!channel.spaceId || channel.space?.membersMayMentionEveryone) return;
    // Asked only when the space has not handed it out: one more read, and only
    // for a message that names the room.
    const admin = runsSpace(await spaceAccess(actor, channel.spaceId));
    if (!roomMentionsAllowed(channel, actor.id, admin)) throw new ChatAccessError(ROOM_MENTION_SPACE_REFUSED);
}

/**
 * Tell the room, if the message named it.
 *
 * Best effort and never awaited by the send: a notification that fails must not
 * turn somebody's message into an error, and the message is what matters.
 *
 * @param channelId - Where it was said.
 * @param authorId - Who said it. Never told about their own.
 * @param body - The stored Markdown. Parsed rather than scanned, so one inside
 *   a code fence is code.
 */
export async function announceRoomMention(
    channelId: string,
    authorId: string,
    body: string,
    messageId: string
): Promise<void> {
    // Checked before anything is read: the overwhelming majority of messages
    // name nobody, and this runs on every one of them.
    const named = channelMentions(body);
    if (named.size === 0) return;

    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: {
            id: true,
            name: true,
            kind: true,
            spaceId: true,
            private: true,
            orgId: true,
            space: { select: { orgId: true } }
        }
    });
    // A one-to-one conversation has nobody in it who is not already being
    // written to.
    if (!channel || channel.kind === "dm") return;

    // `@everyone` wins where a message carries both: it is the wider of the two,
    // and telling somebody twice about one message is worse than telling the
    // people `@here` would have skipped.
    const everyone = named.has("everyone");
    const label = everyone ? "@everyone" : "@here";
    const where = channel.spaceId ? `#${channel.name}` : channel.name;
    const author = await prisma.user.findUnique({
        where: { id: authorId },
        select: { name: true }
    });
    const authorName = author?.name ?? null;
    const about = await chatAlertShelf(channel);

    // A page of the room at a time, never the whole roster: a space of a
    // million people is two thousand pages, each bounded in what it reads and
    // in how many notifications it writes at once. `@here` never pages the
    // roster at all - it starts from who is online, the smaller set.
    const pages = everyone ? rosterPages(channel) : onlinePages(channel, onlineUserIds());
    for await (const page of pages) {
        const ids = page.filter((userId) => userId !== authorId);
        if (ids.length === 0) continue;
        // A mention gets through the conversation's mute and Chat's as a whole,
        // unless that mute holds mentions too.
        const [mutes, silenced, shut, locked] = await Promise.all([
            muteStates([channelId], ids),
            silencedIn(channelId, ids),
            blockersOf(authorId, ids),
            // Somebody who locked the conversation is told only that something arrived.
            lockedFor(channelId, ids)
        ]);
        const told = ids
            .filter((userId) => !core.chatMuteHolds(mutes(channelId, userId), true))
            .filter((userId) => !silenced.has(userId))
            .filter((userId) => !shut.has(userId));
        await inBatches(told, ROOM_MENTION_CONCURRENCY, async (userId) => {
            // Written for whoever is told, in their own language.
            const words = await chatWordsFor(userId);
            return createNotification({
                userId,
                type: "chat.mention",
                title: locked.has(userId)
                    ? words("lock.newMessage")
                    : words("notices.roomMention", {
                          name: authorName ?? words("notices.somebodyCapital"),
                          mention: label,
                          where
                      }),
                body: locked.has(userId) ? null : plainExcerpt(body, 140),
                href: `/chat/c/${channelId}/${messageId}`,
                level: "info",
                // Addressed to the room, and drawn as that: the conversation
                // it went to rather than "you", so it reads as an
                // announcement and not as a message written to the reader.
                audience: "group",
                audienceLabel: locked.has(userId) ? null : where || null,
                shelf: await recipientShelf(userId, about).catch(() => null),
                // One per reader per message, however often this runs.
                dedupKey: `chat.room-mention:${messageId}`,
                once: true
            });
        });
    }
}

/** How many people one page of a room mention covers. */
export const ROOM_MENTION_PAGE = 500;

/** How many notifications of one page are written at once. */
export const ROOM_MENTION_CONCURRENCY = 16;

type Room = { readonly id: string; readonly spaceId: string | null; readonly private: boolean; };

/**
 * Everybody the message reaches, a page at a time in id order, the last id
 * the cursor: the channel's own members where it has them, and the space's
 * roster where the channel is open to all of it.
 */
export async function* rosterPages(channel: Room): AsyncGenerator<string[]> {
    let after: string | undefined;
    for (;;) {
        const cursor = after ? { userId: { gt: after } } : {};
        const rows =
            !channel.spaceId || channel.private
                ? await prisma.chatChannelMember.findMany({
                      where: { channelId: channel.id, ...cursor },
                      orderBy: { userId: "asc" },
                      select: { userId: true },
                      take: ROOM_MENTION_PAGE
                  })
                : await prisma.chatSpaceMember.findMany({
                      where: { spaceId: channel.spaceId, ...cursor },
                      orderBy: { userId: "asc" },
                      select: { userId: true },
                      take: ROOM_MENTION_PAGE
                  });
        if (rows.length === 0) return;
        yield rows.map((row) => row.userId);
        if (rows.length < ROOM_MENTION_PAGE) return;
        after = rows[rows.length - 1]!.userId;
    }
}

/** The people online right now who are in the room, a page at a time. */
export async function* onlinePages(
    channel: Room,
    online: ReadonlySet<string>
): AsyncGenerator<string[]> {
    const ids = [...online];
    for (let start = 0; start < ids.length; start += ROOM_MENTION_PAGE) {
        const chunk = ids.slice(start, start + ROOM_MENTION_PAGE);
        const rows =
            !channel.spaceId || channel.private
                ? await prisma.chatChannelMember.findMany({
                      where: { channelId: channel.id, userId: { in: chunk } },
                      select: { userId: true },
                      take: ROOM_MENTION_PAGE
                  })
                : await prisma.chatSpaceMember.findMany({
                      where: { spaceId: channel.spaceId, userId: { in: chunk } },
                      select: { userId: true },
                      take: ROOM_MENTION_PAGE
                  });
        if (rows.length > 0) yield rows.map((row) => row.userId);
    }
}
