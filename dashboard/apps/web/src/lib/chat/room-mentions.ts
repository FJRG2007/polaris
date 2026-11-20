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
import { recipientShelf } from "@/lib/workspace-scope";
import {
    ChatAccessError,
    roomMentionsAllowed,
    type ChannelAccess,
    type ChatActor,
    type ChatErrorText
} from "./access";

/** What somebody is told when the owner of a group has kept these to themselves. */
const ROOM_MENTION_REFUSED: ChatErrorText = { key: "errors.roomMentionOwnerOnly" };

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
    if (access.kind !== "group") return;
    if (!body.includes("@") || channelMentions(body).size === 0) return;
    const group = await prisma.chatChannel.findUnique({
        where: { id: access.channelId },
        select: { kind: true, ownerId: true, createdById: true, membersMayMention: true }
    });
    if (group && !roomMentionsAllowed(group, actor.id)) {
        throw new ChatAccessError(ROOM_MENTION_REFUSED);
    }
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

    const audience = await reachable(channel);
    if (audience.size === 0) return;

    // `@everyone` wins where a message carries both: it is the wider of the two,
    // and telling somebody twice about one message is worse than telling the
    // people `@here` would have skipped.
    const everyone = named.has("everyone");
    const online = everyone ? null : onlineUserIds();
    const label = everyone ? "@everyone" : "@here";

    // A mention gets through the conversation's mute and Chat's as a whole,
    // unless that mute holds mentions too.
    const mutes = await muteStates([channelId], [...audience]);
    const silenced = await silencedIn(channelId, [...audience]);
    const shut = await blockersOf(authorId, [...audience]);
    const where = channel.spaceId ? `#${channel.name}` : channel.name;
    const author = await prisma.user.findUnique({
        where: { id: authorId },
        select: { name: true }
    });
    const authorName = author?.name ?? null;
    const about = await chatAlertShelf(channel);
    // Somebody who locked the conversation is told only that something arrived.
    const locked = await lockedFor(channelId, [...audience]);

    await Promise.all(
        [...audience]
            .filter((userId) => userId !== authorId)
            .filter((userId) => !core.chatMuteHolds(mutes(channelId, userId), true))
            .filter((userId) => !silenced.has(userId))
            .filter((userId) => !shut.has(userId))
            .filter((userId) => online === null || online.has(userId))
            .map(async (userId) => {
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
                    shelf: await recipientShelf(userId, about).catch(() => null)
                });
            })
    );
}

/** Everybody the message reaches: the channel's own members where it has them,
 *  and the space's roster where the channel is open to all of it. */
async function reachable(channel: {
    id: string;
    spaceId: string | null;
    private: boolean;
}): Promise<Set<string>> {
    if (!channel.spaceId || channel.private) {
        const members = await prisma.chatChannelMember.findMany({
            where: { channelId: channel.id },
            select: { userId: true }
        });
        return new Set(members.map((row) => row.userId));
    }
    const members = await prisma.chatSpaceMember.findMany({
        where: { spaceId: channel.spaceId },
        select: { userId: true }
    });
    return new Set(members.map((row) => row.userId));
}
