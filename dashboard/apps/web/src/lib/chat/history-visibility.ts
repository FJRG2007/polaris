/**
 * Whether somebody who joins a conversation later reads what was said before
 * they joined.
 *
 * Matrix calls this `history_visibility` ("shared" vs "joined") and Telegram
 * "chat history for new members"; Discord always shows it and WhatsApp never
 * does. Here it is a choice, shown by default: a space sets the default for its
 * channels, a channel may override it, and a group decides for itself. A 1:1
 * conversation has nobody who joins later, so it is never restricted.
 *
 * When it is off, the earliest message a reader is shown is the one written at
 * or after the moment they joined - the membership row's `createdAt`. Leaving
 * deletes that row, so coming back is a new join (Matrix's "joined"). Changing
 * the setting only changes what is read from then on; nothing is deleted.
 *
 * Every read of chat messages asks this module, never a copy of the rule.
 *
 * Three more things decide what a reader is shown, and they live here so that
 * every read already asking about the floor asks about them too: a message past
 * its `expiresAt` is gone for everybody (disappearing messages), one a reader
 * deleted for themselves (`ChatMessageHidden`) is gone for them, and a chat they
 * deleted for themselves (`clearedAt` on their membership) starts again for
 * them at that moment - the cleared mark is a floor like any other.
 */

import { prisma, type Prisma } from "@polaris/db";
import { ChatAccessError, type ChatActor } from "./access";
import { everyoneClause, seenByClause } from "./ephemeral";

/** What a channel stores: follow the space (or, for a group, show), or say. */
export const NEWCOMER_HISTORY = ["inherit", "on", "off"] as const;
export type NewcomerHistory = (typeof NEWCOMER_HISTORY)[number];

/** Whether people who join later read earlier history in this conversation. */
export function newcomersReadHistory(
    channel: {
        readonly kind: string;
        readonly spaceId: string | null;
        readonly newcomerHistory: string;
    },
    spaceDefault: boolean | null
): boolean {
    if (channel.kind === "dm") return true;
    if (channel.newcomerHistory === "on") return true;
    if (channel.newcomerHistory === "off") return false;
    return channel.spaceId ? (spaceDefault ?? true) : true;
}

/**
 * The earliest moment this reader may read from, or null for all of it.
 *
 * In a space's open channel, joining the space is joining the room: reading one
 * leaves a channel row behind, so the row's age would hide history from a member
 * of years the first time they opened a channel. A private channel or a group is
 * joined by being added to it. Somebody who reaches a room with no membership
 * row at all (a room handed to their team) was handed it whole.
 */
export function historyFloor(input: {
    readonly readsHistory: boolean;
    readonly spaceId: string | null;
    readonly private: boolean;
    readonly channelJoinedAt: Date | null;
    readonly spaceJoinedAt: Date | null;
}): Date | null {
    if (input.readsHistory) return null;
    if (input.spaceId && !input.private) return input.spaceJoinedAt ?? input.channelJoinedAt;
    return input.channelJoinedAt;
}

/**
 * The floor of each of these conversations that has one, for this reader.
 *
 * One query, and it only returns conversations where the setting is off, so
 * the common case - everything visible - costs a single empty read.
 */
export async function historyFloors(
    actorId: string,
    channelIds: readonly string[]
): Promise<Map<string, Date>> {
    const floors = new Map<string, Date>();
    const ids = [...new Set(channelIds)];
    if (ids.length === 0) return floors;

    const closed = await prisma.chatChannel.findMany({
        where: {
            id: { in: ids },
            kind: { not: "dm" },
            OR: [
                { newcomerHistory: "off" },
                { newcomerHistory: "inherit", space: { newcomerHistory: false } }
            ]
        },
        select: {
            id: true,
            kind: true,
            spaceId: true,
            private: true,
            newcomerHistory: true,
            members: { where: { userId: actorId }, select: { createdAt: true }, take: 1 },
            space: {
                select: {
                    newcomerHistory: true,
                    members: { where: { userId: actorId }, select: { createdAt: true }, take: 1 }
                }
            }
        }
    });

    for (const channel of closed) {
        const floor = historyFloor({
            readsHistory: newcomersReadHistory(channel, channel.space?.newcomerHistory ?? null),
            spaceId: channel.spaceId,
            private: channel.private,
            channelJoinedAt: channel.members[0]?.createdAt ?? null,
            spaceJoinedAt: channel.space?.members[0]?.createdAt ?? null
        });
        if (floor) floors.set(channel.id, floor);
    }

    // A chat this reader deleted for themselves starts again where they cleared
    // it. Only rows that have been cleared come back, so this is usually empty.
    const cleared = await prisma.chatChannelMember.findMany({
        where: { userId: actorId, channelId: { in: ids }, clearedAt: { not: null } },
        select: { channelId: true, clearedAt: true }
    });
    for (const row of cleared) {
        if (!row.clearedAt) continue;
        const was = floors.get(row.channelId);
        if (!was || was.getTime() < row.clearedAt.getTime()) floors.set(row.channelId, row.clearedAt);
    }
    return floors;
}

/** Messages that have not disappeared yet. */
export function notExpiredClause(now: Date = new Date()): Prisma.ChatMessageWhereInput {
    return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

/** Messages this reader has not deleted for themselves. */
export function notHiddenClause(viewerId: string): Prisma.ChatMessageWhereInput {
    return { hiddenFor: { none: { userId: viewerId } } };
}

/** The floor of one conversation for this reader, or null for all of it. */
export async function readableSince(actor: ChatActor, channelId: string): Promise<Date | null> {
    return (await historyFloors(actor.id, [channelId])).get(channelId) ?? null;
}

/** A where clause for one conversation: only what this reader may read - past
 *  the floor, not expired, and not deleted by them for themselves when the
 *  reader is named. */
export function sinceClause(
    floor: Date | null,
    viewerId?: string | null
): Prisma.ChatMessageWhereInput {
    return {
        AND: [
            floor ? { createdAt: { gte: floor } } : {},
            notExpiredClause(),
            viewerId ? notHiddenClause(viewerId) : {},
            // The conversation itself: an ephemeral answer only to its audience.
            viewerId ? seenByClause(viewerId) : everyoneClause()
        ]
    };
}

/**
 * The same across several conversations, for a read that spans them (search,
 * unread counts, toasts). Meant to sit in an `AND` list, so it never collides
 * with an `OR` the caller already has.
 */
export function readableWhere(
    floors: ReadonlyMap<string, Date>,
    viewerId?: string | null
): Prisma.ChatMessageWhereInput {
    const floored: Prisma.ChatMessageWhereInput =
        floors.size === 0
            ? {}
            : {
                  OR: [
                      { channelId: { notIn: [...floors.keys()] } },
                      ...[...floors].map(([channelId, gte]) => ({ channelId, createdAt: { gte } }))
                  ]
              };
    // What speaks for the conversation - unread, search, toasts - never counts
    // an ephemeral answer, not even for the one it was for (`lib/chat/ephemeral`).
    return {
        AND: [floored, notExpiredClause(), viewerId ? notHiddenClause(viewerId) : {}, everyoneClause()]
    };
}

/** Whether a message written at `createdAt` is past this floor - and, when its
 *  expiry is passed, has not disappeared. */
export function isReadable(
    floor: Date | null | undefined,
    createdAt: Date,
    expiresAt?: Date | null
): boolean {
    if (expiresAt && expiresAt.getTime() <= Date.now()) return false;
    return !floor || createdAt.getTime() >= floor.getTime();
}

/**
 * Refuses one message this reader joined too late to read, the same way a
 * conversation they cannot open is refused: a permalink, a quote or a reaction
 * must not be the way round the setting.
 */
export async function requireReadable(
    actor: ChatActor,
    channelId: string,
    messageId: string
): Promise<void> {
    const floor = await readableSince(actor, channelId);
    const row = await prisma.chatMessage.findFirst({
        where: { id: messageId, AND: [notHiddenClause(actor.id), seenByClause(actor.id)] },
        select: { createdAt: true, expiresAt: true }
    });
    if (!row || !isReadable(floor, row.createdAt, row.expiresAt)) throw new ChatAccessError();
}

/** The same for a file, asked by the route that serves it: a file in a message
 *  this reader may not read is a file they may not download. */
export async function attachmentReadable(
    actor: ChatActor,
    channelId: string,
    attachmentId: string
): Promise<boolean> {
    const floor = await readableSince(actor, channelId);
    const row = await prisma.chatAttachment.findUnique({
        where: { id: attachmentId },
        select: {
            message: {
                select: {
                    createdAt: true,
                    expiresAt: true,
                    hiddenFor: { where: { userId: actor.id }, select: { userId: true }, take: 1 }
                }
            }
        }
    });
    return (
        row !== null &&
        row.message.hiddenFor.length === 0 &&
        isReadable(floor, row.message.createdAt, row.message.expiresAt)
    );
}
