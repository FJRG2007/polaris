/**
 * What was said, and everything done to it afterwards.
 *
 * Reads are paged backwards from the newest, because that is the only direction
 * anybody reads a channel: you arrive at the bottom and go up. The page is
 * returned oldest-first anyway, so the caller renders it in order without
 * reversing a list on every frame.
 *
 * Authorization is `access.ts` and nothing else - every entry point resolves the
 * channel before it touches a message, including the ones that take a message id
 * rather than a channel id.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { publishChatChange } from "./live";
import { ChatAccessError, requireChannel, requirePostable, type ChatActor } from "./access";

/** One message, with everything the list needs to draw it. */
export interface ChatMessageView {
    readonly id: string;
    readonly channelId: string;
    readonly authorId: string | null;
    /** Null when the account is gone. The message stays; the name does not. */
    readonly authorName: string | null;
    readonly kind: core.ChatMessageKind;
    /** Empty for a deleted message - the tombstone carries no text. */
    readonly body: string;
    readonly parentId: string | null;
    readonly replyCount: number;
    readonly lastReplyAt: string | null;
    readonly edited: boolean;
    readonly deleted: boolean;
    readonly reactions: readonly ChatReactionView[];
    readonly createdAt: string;
}

/** One emoji on a message, already counted. */
export interface ChatReactionView {
    readonly emoji: string;
    readonly count: number;
    /** Whether the reader is one of them, which is what the pressed state is. */
    readonly mine: boolean;
}

/** A page of a conversation. */
export interface ChatPage {
    readonly messages: readonly ChatMessageView[];
    /** The cursor for the page above this one, or null at the top of the
     *  channel. An id rather than a timestamp: two messages can share a
     *  millisecond, and a timestamp cursor would skip one of them. */
    readonly olderThan: string | null;
}

/** How many messages one page holds. A screenful and a bit, so scrolling up
 *  fetches before it runs out rather than after. */
const PAGE = 50;

/**
 * A page of a channel, newest last.
 *
 * `before` walks upwards: pass the id of the oldest message currently drawn.
 * Thread replies are left out of the channel - they belong under their root,
 * which the root's own reply count points at.
 */
export async function readChannel(
    actor: ChatActor,
    channelId: string,
    before?: string
): Promise<ChatPage> {
    await requireChannel(actor, channelId);

    const cursor = before
        ? await prisma.chatMessage.findFirst({
              where: { id: before, channelId },
              select: { createdAt: true }
          })
        : null;

    const rows = await prisma.chatMessage.findMany({
        where: {
            channelId,
            parentId: null,
            ...(cursor ? { createdAt: { lt: cursor.createdAt } } : {})
        },
        orderBy: { createdAt: "desc" },
        take: PAGE + 1,
        select: MESSAGE_SELECT
    });

    const page = rows.slice(0, PAGE).reverse();
    return {
        messages: await decorate(actor, page),
        olderThan: rows.length > PAGE ? (page[0]?.id ?? null) : null
    };
}

/**
 * A thread: its root and every reply, oldest first.
 *
 * Not paged. A thread that needs paging is a channel somebody started in the
 * wrong place, and the honest fix for that is moving it rather than teaching
 * this to scroll.
 */
export async function readThread(
    actor: ChatActor,
    messageId: string
): Promise<readonly ChatMessageView[]> {
    const root = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { id: true, channelId: true, parentId: true }
    });
    if (!root) return [];
    await requireChannel(actor, root.channelId);

    // A reply passed in place of the root opens the thread it is in, which is
    // what somebody clicking a reply in a search result means.
    const rootId = root.parentId ?? root.id;
    const rows = await prisma.chatMessage.findMany({
        where: { OR: [{ id: rootId }, { parentId: rootId }] },
        orderBy: { createdAt: "asc" },
        select: MESSAGE_SELECT
    });
    return decorate(actor, rows);
}

/** Messages posted since a given id, for a screen catching up after a frame. */
export async function readSince(
    actor: ChatActor,
    channelId: string,
    afterId: string | null
): Promise<readonly ChatMessageView[]> {
    await requireChannel(actor, channelId);
    const cursor = afterId
        ? await prisma.chatMessage.findFirst({
              where: { id: afterId, channelId },
              select: { createdAt: true }
          })
        : null;

    const rows = await prisma.chatMessage.findMany({
        where: {
            channelId,
            parentId: null,
            ...(cursor ? { createdAt: { gt: cursor.createdAt } } : {})
        },
        orderBy: { createdAt: "asc" },
        take: PAGE,
        select: MESSAGE_SELECT
    });
    return decorate(actor, rows);
}

/**
 * Say something.
 *
 * The channel's `lastMessageAt` and, for a reply, the root's reply count are
 * written in the same transaction as the message: they are how the rail orders
 * conversations and how a thread announces itself, and a message that landed
 * without them would be a message nobody is shown.
 */
export async function send(actor: ChatActor, input: core.ChatSendInput): Promise<string> {
    await requirePostable(actor, input.channelId);

    if (input.parentId) {
        const parent = await prisma.chatMessage.findUnique({
            where: { id: input.parentId },
            select: { channelId: true, parentId: true }
        });
        if (!parent || parent.channelId !== input.channelId) {
            throw new ChatAccessError("That message is not in this conversation");
        }
        // Threads are one level. A reply to a reply joins the same thread rather
        // than starting a second one nobody would find.
        input = { ...input, parentId: parent.parentId ?? input.parentId };
    }

    const id = await prisma.$transaction(async (tx) => {
        const message = await tx.chatMessage.create({
            data: {
                channelId: input.channelId,
                authorId: actor.id,
                body: input.body,
                parentId: input.parentId ?? null
            },
            select: { id: true, createdAt: true }
        });
        await tx.chatChannel.update({
            where: { id: input.channelId },
            data: { lastMessageAt: message.createdAt }
        });
        if (input.parentId) {
            await tx.chatMessage.update({
                where: { id: input.parentId },
                data: { replyCount: { increment: 1 }, lastReplyAt: message.createdAt }
            });
        }
        // Posting is reading: the sender is caught up by definition, and without
        // this their own message would light their own badge.
        await tx.chatChannelMember.upsert({
            where: { channelId_userId: { channelId: input.channelId, userId: actor.id } },
            update: { lastReadMessageId: message.id, lastReadAt: message.createdAt },
            create: {
                channelId: input.channelId,
                userId: actor.id,
                lastReadMessageId: message.id,
                lastReadAt: message.createdAt
            }
        });
        return message.id;
    });

    publishChatChange({ channelId: input.channelId, kind: "posted", actorId: actor.id });
    return id;
}

/** Rewrite one of your own. Nobody edits somebody else's, an admin included:
 *  a channel where what you said can change under you is not a record of
 *  anything. */
export async function edit(actor: ChatActor, input: core.ChatEditInput): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { channelId: true, authorId: true, deletedAt: true }
    });
    if (!message) throw new ChatAccessError("That message is gone");
    await requirePostable(actor, message.channelId);
    if (message.authorId !== actor.id)
        throw new ChatAccessError("You can only edit your own messages");
    if (message.deletedAt) throw new ChatAccessError("That message was deleted");

    await prisma.chatMessage.update({
        where: { id: input.messageId },
        data: { body: input.body, editedAt: new Date() }
    });
    publishChatChange({ channelId: message.channelId, kind: "posted", actorId: actor.id });
}

/**
 * Take one back.
 *
 * A tombstone rather than a delete: the replies under a message stay findable,
 * and the message above it does not silently inherit the meaning of the one that
 * went. The author does it, or somebody who administers the channel - moderating
 * a room is exactly the case where removing somebody else's words is the point.
 */
export async function remove(actor: ChatActor, messageId: string): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, authorId: true }
    });
    if (!message) return;
    const access = await requireChannel(actor, message.channelId);
    if (message.authorId !== actor.id && !access.mayAdminister) {
        throw new ChatAccessError("You cannot delete that message");
    }

    await prisma.chatMessage.update({
        where: { id: messageId },
        data: { deletedAt: new Date(), body: "" }
    });
    publishChatChange({ channelId: message.channelId, kind: "posted", actorId: actor.id });
}

/** Put an emoji on a message, or take yours back off. Returns whether it is on
 *  now, so an optimistic caller can settle without asking again. */
export async function react(actor: ChatActor, input: core.ChatReactInput): Promise<boolean> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { channelId: true }
    });
    if (!message) throw new ChatAccessError("That message is gone");
    await requirePostable(actor, message.channelId);

    const existing = await prisma.chatReaction.findUnique({
        where: {
            messageId_userId_emoji: {
                messageId: input.messageId,
                userId: actor.id,
                emoji: input.emoji
            }
        },
        select: { id: true }
    });

    if (existing) await prisma.chatReaction.delete({ where: { id: existing.id } });
    else
        await prisma.chatReaction.create({
            data: { messageId: input.messageId, userId: actor.id, emoji: input.emoji }
        });

    publishChatChange({ channelId: message.channelId, kind: "posted", actorId: actor.id });
    return !existing;
}

/**
 * Mark a channel read up to a message.
 *
 * Never moves the mark backwards. Two tabs open on the same channel disagree
 * about what has been seen, and the one scrolled further up must not un-read
 * what the other already read.
 */
export async function markRead(actor: ChatActor, input: core.ChatMarkReadInput): Promise<void> {
    await requireChannel(actor, input.channelId);
    const message = await prisma.chatMessage.findFirst({
        where: { id: input.messageId, channelId: input.channelId },
        select: { createdAt: true }
    });
    if (!message) return;

    const current = await prisma.chatChannelMember.findUnique({
        where: { channelId_userId: { channelId: input.channelId, userId: actor.id } },
        select: { lastReadAt: true }
    });
    if (current?.lastReadAt && current.lastReadAt >= message.createdAt) return;

    await prisma.chatChannelMember.upsert({
        where: { channelId_userId: { channelId: input.channelId, userId: actor.id } },
        update: { lastReadMessageId: input.messageId, lastReadAt: message.createdAt },
        create: {
            channelId: input.channelId,
            userId: actor.id,
            lastReadMessageId: input.messageId,
            lastReadAt: message.createdAt
        }
    });
}

/** Say that somebody is composing. Nothing is stored: it is true for a few
 *  seconds and then it is not, and a table would only ever hold stale rows. */
export async function announceTyping(
    actor: ChatActor & { name: string },
    channelId: string
): Promise<void> {
    await requireChannel(actor, channelId);
    publishChatChange({ channelId, kind: "typing", actorId: actor.id, actorName: actor.name });
}

const MESSAGE_SELECT = {
    id: true,
    channelId: true,
    authorId: true,
    kind: true,
    body: true,
    parentId: true,
    replyCount: true,
    lastReplyAt: true,
    editedAt: true,
    deletedAt: true,
    createdAt: true
} as const;

interface Row {
    id: string;
    channelId: string;
    authorId: string | null;
    kind: string;
    body: string;
    parentId: string | null;
    replyCount: number;
    lastReplyAt: Date | null;
    editedAt: Date | null;
    deletedAt: Date | null;
    createdAt: Date;
}

/**
 * Fill in the two things a message row does not carry: who wrote it and what is
 * on it.
 *
 * Both in one query for the whole page rather than per message. Author names are
 * looked up rather than joined - `authorId` is deliberately not a foreign key,
 * so a join would drop every message written by somebody who has since deleted
 * their account, which is the opposite of what a record of a conversation is
 * for.
 */
async function decorate(actor: ChatActor, rows: readonly Row[]): Promise<ChatMessageView[]> {
    if (rows.length === 0) return [];

    const authorIds = [
        ...new Set(rows.map((row) => row.authorId).filter((id): id is string => id !== null))
    ];
    const [authors, reactions] = await Promise.all([
        authorIds.length
            ? prisma.user.findMany({
                  where: { id: { in: authorIds } },
                  select: { id: true, name: true }
              })
            : Promise.resolve([]),
        prisma.chatReaction.findMany({
            where: { messageId: { in: rows.map((row) => row.id) } },
            select: { messageId: true, emoji: true, userId: true }
        })
    ]);

    const names = new Map(authors.map((author) => [author.id, author.name]));
    const onMessage = new Map<string, Map<string, { count: number; mine: boolean }>>();
    for (const reaction of reactions) {
        const bucket = onMessage.get(reaction.messageId) ?? new Map();
        const tally = bucket.get(reaction.emoji) ?? { count: 0, mine: false };
        tally.count += 1;
        if (reaction.userId === actor.id) tally.mine = true;
        bucket.set(reaction.emoji, tally);
        onMessage.set(reaction.messageId, bucket);
    }

    return rows.map((row) => ({
        id: row.id,
        channelId: row.channelId,
        authorId: row.authorId,
        authorName: row.authorId ? (names.get(row.authorId) ?? null) : null,
        kind: row.kind as core.ChatMessageKind,
        body: row.deletedAt ? "" : row.body,
        parentId: row.parentId,
        replyCount: row.replyCount,
        lastReplyAt: row.lastReplyAt?.toISOString() ?? null,
        edited: row.editedAt !== null,
        deleted: row.deletedAt !== null,
        reactions: [...(onMessage.get(row.id) ?? new Map())]
            .map(([emoji, tally]) => ({ emoji, count: tally.count, mine: tally.mine }))
            // Most-reacted first, then by emoji so the order is stable between
            // renders when two have the same count.
            .sort(
                (left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji)
            ),
        createdAt: row.createdAt.toISOString()
    }));
}
