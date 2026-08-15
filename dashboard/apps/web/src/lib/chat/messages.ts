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
import { isInlineImage, type StoredAttachment } from "./attachments";
import {
    ChatAccessError,
    reachableChannelIds,
    requireChannel,
    requirePostable,
    type ChatActor
} from "./access";

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
    readonly attachments: readonly ChatAttachmentView[];
    /** The message this one answers or forwards, already resolved to what the
     *  quote line needs. Null when it stands alone, and present-but-gone when
     *  the original was deleted - which is a different thing to say. */
    readonly quote: ChatQuoteView | null;
    /** Whether this reader kept it. Private to them - starring is a bookmark,
     *  not a signal to the room. */
    readonly starred: boolean;
    readonly createdAt: string;
}

/** One file on a message. The bytes are fetched by their own route, which
 *  authorizes the channel before it reads anything. */
export interface ChatAttachmentView {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly contentType: string;
    /** Whether the list may draw it rather than link to it. */
    readonly inline: boolean;
}

/** The message a reply or a forward stands on, as the quote line draws it. */
export interface ChatQuoteView {
    readonly id: string;
    readonly authorName: string | null;
    /** Trimmed to a line: a quote that repeats a paragraph is the paragraph
     *  twice. */
    readonly excerpt: string;
    readonly deleted: boolean;
    /** True for a forward, false for a reply. The two read differently and are
     *  placed differently, and this is what decides which. */
    readonly forwarded: boolean;
}

/** How much of the quoted message the line carries. */
const QUOTE_LENGTH = 160;

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
export async function send(
    actor: ChatActor,
    input: core.ChatSendInput,
    /** Files already written to storage, to be tied to the message in the same
     *  transaction. A message that landed without its attachments would be a
     *  message nobody could make sense of. */
    attachments: readonly StoredAttachment[] = [],
    /** The message this one answers, or the one being forwarded. */
    quote: { readonly messageId: string; readonly forwarded: boolean } | null = null
): Promise<string> {
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

    // Resolved before the write and only when it is real: a reply pointing at a
    // message in another conversation would let somebody quote a room they
    // cannot read into one they can.
    let quoted: string | null = null;
    if (quote) {
        const original = await prisma.chatMessage.findUnique({
            where: { id: quote.messageId },
            select: { channelId: true }
        });
        if (original) {
            // A forward is the one case where the two differ on purpose: it
            // carries a message out of where it was said. The reader is proved
            // against the source before it moves.
            if (original.channelId === input.channelId) quoted = quote.messageId;
            else if (quote.forwarded) {
                await requireChannel(actor, original.channelId);
                quoted = quote.messageId;
            }
        }
    }

    const id = await prisma.$transaction(async (tx) => {
        const message = await tx.chatMessage.create({
            data: {
                channelId: input.channelId,
                authorId: actor.id,
                body: input.body,
                parentId: input.parentId ?? null,
                replyToId: quoted,
                forwarded: quoted !== null && (quote?.forwarded ?? false),
                ...(attachments.length
                    ? { attachments: { createMany: { data: attachments.map((file) => ({ ...file })) } } }
                    : {})
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

/**
 * Send somebody else's message on to another conversation.
 *
 * Both ends are proved: the reader has to be able to read where it came from -
 * checked inside `send` - and to post where it is going. Without the first, a
 * forward is a way to lift a message out of a room you were never in.
 *
 * The body is the forwarder's own note, and the original travels as the quote
 * rather than as copied text. Copying would strip who said it and when, which is
 * most of what makes a forwarded message worth anything.
 */
export async function forward(actor: ChatActor, input: core.ChatForwardInput): Promise<string> {
    const original = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { id: true, deletedAt: true }
    });
    if (!original || original.deletedAt) throw new ChatAccessError("That message is gone");

    return send(
        actor,
        { channelId: input.channelId, body: input.note || " ", parentId: null },
        [],
        { messageId: input.messageId, forwarded: true }
    );
}

/**
 * Keep a message, or stop keeping it. Returns whether it is kept now.
 *
 * Anybody who can read the message can keep it, including in a channel they
 * reach through the space rather than by membership: a bookmark is about the
 * reader, and nothing about it is visible to anybody else.
 */
export async function star(actor: ChatActor, messageId: string): Promise<boolean> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true }
    });
    if (!message) throw new ChatAccessError("That message is gone");
    await requireChannel(actor, message.channelId);

    const existing = await prisma.chatStar.findUnique({
        where: { messageId_userId: { messageId, userId: actor.id } },
        select: { id: true }
    });
    if (existing) {
        await prisma.chatStar.delete({ where: { id: existing.id } });
        return false;
    }
    await prisma.chatStar.create({ data: { messageId, userId: actor.id } });
    return true;
}

/**
 * Everything this reader kept, newest first.
 *
 * Re-checked against the channel on the way out rather than trusted from the
 * star: somebody removed from a private channel keeps their bookmarks as rows,
 * and this is where they stop being readable.
 */
export async function starred(actor: ChatActor, limit = 100): Promise<ChatMessageView[]> {
    const stars = await prisma.chatStar.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { message: { select: MESSAGE_SELECT } }
    });
    if (stars.length === 0) return [];

    const reachable = await reachableChannelIds(actor);
    const rows = stars
        .map((entry) => entry.message)
        .filter((row) => reachable.has(row.channelId) && row.deletedAt === null);
    return decorate(actor, rows);
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
    replyToId: true,
    forwarded: true,
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
    replyToId: string | null;
    forwarded: boolean;
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
    const quotedIds = [
        ...new Set(rows.map((row) => row.replyToId).filter((id): id is string => id !== null))
    ];
    const [authors, reactions, files, stars, quoted] = await Promise.all([
        authorIds.length
            ? prisma.user.findMany({
                  where: { id: { in: authorIds } },
                  select: { id: true, name: true }
              })
            : Promise.resolve([]),
        prisma.chatReaction.findMany({
            where: { messageId: { in: rows.map((row) => row.id) } },
            select: { messageId: true, emoji: true, userId: true }
        }),
        prisma.chatAttachment.findMany({
            where: { messageId: { in: rows.map((row) => row.id) } },
            orderBy: { createdAt: "asc" },
            select: { id: true, messageId: true, name: true, size: true, contentType: true }
        }),
        prisma.chatStar.findMany({
            where: { userId: actor.id, messageId: { in: rows.map((row) => row.id) } },
            select: { messageId: true }
        }),
        quotedIds.length
            ? prisma.chatMessage.findMany({
                  where: { id: { in: quotedIds } },
                  select: { id: true, authorId: true, body: true, deletedAt: true }
              })
            : Promise.resolve([])
    ]);

    // The quoted messages have authors of their own, and they are usually
    // already in the page - but not always, which is why they join the lookup
    // rather than being read out of it.
    const quoteAuthorIds = quoted
        .map((row) => row.authorId)
        .filter((id): id is string => id !== null && !authorIds.includes(id));
    const quoteAuthors = quoteAuthorIds.length
        ? await prisma.user.findMany({
              where: { id: { in: [...new Set(quoteAuthorIds)] } },
              select: { id: true, name: true }
          })
        : [];

    const names = new Map([...authors, ...quoteAuthors].map((author) => [author.id, author.name]));
    const quotes = new Map(quoted.map((row) => [row.id, row]));
    const kept = new Set(stars.map((row) => row.messageId));
    const onMessageFiles = new Map<string, ChatAttachmentView[]>();
    for (const file of files) {
        const bucket = onMessageFiles.get(file.messageId) ?? [];
        bucket.push({
            id: file.id,
            name: file.name,
            size: Number(file.size),
            contentType: file.contentType,
            inline: isInlineImage(file.contentType)
        });
        onMessageFiles.set(file.messageId, bucket);
    }
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
        attachments: onMessageFiles.get(row.id) ?? [],
        quote: quoteViewOf(row, quotes, names),
        starred: kept.has(row.id),
        createdAt: row.createdAt.toISOString()
    }));
}

/** The quote line for one message, or null when it stands alone. */
function quoteViewOf(
    row: Row,
    quotes: ReadonlyMap<
        string,
        { id: string; authorId: string | null; body: string; deletedAt: Date | null }
    >,
    names: ReadonlyMap<string, string>
): ChatQuoteView | null {
    if (!row.replyToId) return null;
    const original = quotes.get(row.replyToId);
    // The column survives the message it pointed at being deleted, so the
    // absence is said rather than swallowed: an answer with no visible question
    // is worse than one that admits the question is gone.
    if (!original) {
        return {
            id: row.replyToId,
            authorName: null,
            excerpt: "",
            deleted: true,
            forwarded: row.forwarded
        };
    }
    const body = original.deletedAt ? "" : original.body.replace(/\s+/g, " ").trim();
    return {
        id: original.id,
        authorName: original.authorId ? (names.get(original.authorId) ?? null) : null,
        excerpt: body.length > QUOTE_LENGTH ? `${body.slice(0, QUOTE_LENGTH)}...` : body,
        deleted: original.deletedAt !== null,
        forwarded: row.forwarded
    };
}
