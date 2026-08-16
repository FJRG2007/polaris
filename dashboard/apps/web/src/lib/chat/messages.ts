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
import { rulesForChannel } from "./rules";
import { publishChatChange } from "./live";
import { announceRoomMention } from "./room-mentions";
import { nicknamesFor } from "@/lib/contact-names";
import { receiptsBetween } from "@/lib/privacy-service";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { isBlankMarkdown } from "@/components/rich-text/markdown";
import { discardAttachments, isInlineImage, type StoredAttachment } from "./attachments";
import { knownPreviews, unfurl, type KnownPreview, type LinkPreviewView } from "./link-preview";
import {
    ChatAccessError,
    ChatRuleError,
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
    /** The first web address in it, whatever came of looking it up. The list
     *  needs it even when nothing did: a video Polaris knows how to play still
     *  plays when the site refused to describe itself. */
    readonly link: string | null;
    /** What that link turned out to be, when Polaris has already looked. */
    readonly preview: LinkPreviewView | null;
    /** True when nobody has looked yet, which is the screen's cue to ask. A card
     *  that waited for a background job to finish and then for something else to
     *  wake the screen was a card that never appeared. */
    readonly previewPending: boolean;
    /**
     * How far this message got, for the ticks under it.
     *
     * Only on your own messages, only in a one-to-one conversation, and only
     * when both people's settings allow it - null everywhere else, which is what
     * tells the list to draw nothing rather than to draw "sent".
     */
    readonly receipt: core.MessageReceipt | null;
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
    /** How long it plays for, for the player to say so before a byte of it has
     *  been fetched. Null for anything nobody measured. */
    readonly durationMs: number | null;
    /** Its shape, one digit a bar, drawn under the play button. */
    readonly waveform: string | null;
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

/** A page of what was said after something, for reading downwards. */
export interface ChatNewerPage {
    readonly messages: readonly ChatMessageView[];
    /** The cursor for the page below this one, or null when this reaches the
     *  live end of the conversation. */
    readonly newerThan: string | null;
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
    await markDelivered(actor, channelId);

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
        messages: await decorateMessages(actor, page),
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
    return decorateMessages(actor, rows);
}

/**
 * The page below the newest message on screen: what has been said since, for a
 * screen catching up after a frame - and for one scrolling back down out of the
 * history it walked up into.
 *
 * `newerThan` is the mirror of `olderThan`: the id to ask from next when there
 * is more below, null once the reader is holding the live end of the
 * conversation. Both exist so a screen can keep a window over a long channel
 * rather than the whole of it.
 */
export async function readSince(
    actor: ChatActor,
    channelId: string,
    afterId: string | null
): Promise<ChatNewerPage> {
    await requireChannel(actor, channelId);
    await markDelivered(actor, channelId);
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
        take: PAGE + 1,
        select: MESSAGE_SELECT
    });

    const page = rows.slice(0, PAGE);
    return {
        messages: await decorateMessages(actor, page),
        newerThan: rows.length > PAGE ? (page[page.length - 1]?.id ?? null) : null
    };
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
    await requireSendable(actor, input.channelId, input.body);

    // Nothing but whitespace, whatever punctuation it serialized into. The
    // schema refuses an empty string and the composer refuses a blank one, and
    // this is the same question asked of the written text: a few spaces and some
    // shift-enters come out of the editor as a lone backslash, which is a
    // message that passes both and reads as a mistake to the whole room.
    if (attachments.length === 0 && isBlankMarkdown(input.body)) {
        throw new ChatRuleError("Write something first");
    }

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

    unfurlLater(input.body);
    // Not awaited, and never allowed to fail the send: a message going out
    // matters more than the notification about it.
    void announceRoomMention(input.channelId, actor.id, input.body, id).catch(() => undefined);

    return id;
}

/**
 * What this conversation's rules allow, applied to something about to be said.
 *
 * The length ceiling in the schema is what Polaris can store; this is what the
 * instance allows, and it can only be tighter. The rate is per person per
 * conversation, which is where flooding actually happens - a limit across the
 * whole instance would punish a busy afternoon in one channel by silencing
 * everybody's direct messages.
 */
async function requireSendable(actor: ChatActor, channelId: string, body: string): Promise<void> {
    const rules = await rulesForChannel(channelId);

    // Code points rather than UTF-16 units: a limit that counted the latter
    // would refuse a message of emoji at half its stated length.
    if ([...body].length > rules.maxMessageLength) {
        throw new ChatRuleError(
            `Messages here are limited to ${rules.maxMessageLength} characters`
        );
    }

    if (rules.maxPerMinute !== core.CHAT_NO_LIMIT) {
        const recent = await prisma.chatMessage.count({
            where: {
                channelId,
                authorId: actor.id,
                createdAt: { gte: new Date(Date.now() - 60_000) }
            }
        });
        if (recent >= rules.maxPerMinute) {
            throw new ChatRuleError("You are sending messages too quickly. Wait a moment.");
        }
    }
}

/**
 * Rewrite one of your own.
 *
 * Nobody edits somebody else's, an admin included: a channel where what you said
 * can change under you is not a record of anything.
 *
 * How long it stays editable is the instance's decision and defaults to forever,
 * which is what people expect and what every messenger does. When the scope keeps
 * history, the text being replaced is written in the same transaction as the
 * replacement - a version recorded outside it could be lost while the edit
 * landed, and a history with a hole is worse than none.
 */
export async function edit(actor: ChatActor, input: core.ChatEditInput): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { channelId: true, authorId: true, body: true, deletedAt: true, createdAt: true }
    });
    if (!message) throw new ChatAccessError("That message is gone");
    await requirePostable(actor, message.channelId);
    if (message.authorId !== actor.id)
        throw new ChatAccessError("You can only edit your own messages");
    if (message.deletedAt) throw new ChatAccessError("That message was deleted");
    await requireSendable(actor, message.channelId, input.body);
    // Emptying a message is deleting it, and there is a delete for that.
    if (isBlankMarkdown(input.body)) throw new ChatRuleError("Write something first");

    const rules = await rulesForChannel(message.channelId);
    if (!core.withinEditWindow(rules, message.createdAt)) {
        throw new ChatRuleError(
            `Messages here can be edited for ${core.editWindowLabel(rules.editWindowMinutes)} after they are sent`
        );
    }

    const editedAt = new Date();
    await prisma.$transaction(async (tx) => {
        if (rules.keepEditHistory) {
            await tx.chatMessageEdit.create({
                data: { messageId: input.messageId, body: message.body, replacedAt: editedAt }
            });
        }
        await tx.chatMessage.update({
            where: { id: input.messageId },
            data: { body: input.body, editedAt }
        });
    });
    publishChatChange({ channelId: message.channelId, kind: "posted", actorId: actor.id });

    // An edit can put a link in a message that did not have one.
    unfurlLater(input.body);
}

/**
 * Start looking the link up, without the message waiting for it.
 *
 * A warm-up, not the mechanism: by the time the conversation reloads the answer
 * is usually already stored, so the card is there on the first draw. What
 * guarantees it appears at all is `linkPreviewFor` below, which the list asks
 * for any link nobody has looked at yet.
 *
 * Leaving this to a background job alone is what kept cards from ever showing:
 * it finishes a second or two after the reload that followed the send, and
 * nothing was going to reload again until somebody else said something - so the
 * last message in a conversation, which is the one being read, never got one.
 */
function unfurlLater(body: string): void {
    const link = core.firstLink(body);
    if (link) void unfurl(link).catch(() => undefined);
}

/**
 * Look up the link in one message and answer with the card, for a reader who is
 * looking at it now.
 *
 * Addressed by message rather than by URL on purpose. An action that took an
 * address would let anybody signed in point this server at anything it can
 * reach; taking a message id means the only addresses ever fetched are ones
 * somebody already posted into a conversation this reader is in.
 *
 * Awaited, unlike the warm-up: the caller is a card with nothing in it yet.
 */
export async function linkPreviewFor(
    actor: ChatActor,
    messageId: string
): Promise<LinkPreviewView | null> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, body: true, deletedAt: true }
    });
    if (!message || message.deletedAt) return null;
    await requireChannel(actor, message.channelId);

    const link = core.firstLink(message.body);
    if (!link) return null;

    await unfurl(link);
    return (await knownPreviews([link])).get(link)?.view ?? null;
}

/** One version of a message, as the history dialog draws it. */
export interface ChatMessageVersion {
    readonly body: string;
    /** When this text stopped being the current one. */
    readonly replacedAt: string;
}

export interface ChatEditHistory {
    /** Whether this conversation keeps history at all. False is a different
     *  answer to an empty list, and the dialog says so rather than implying the
     *  message was never edited. */
    readonly kept: boolean;
    /** Newest replacement first, so the version above the current text is at the
     *  top where somebody comparing the two is already looking. */
    readonly versions: readonly ChatMessageVersion[];
}

/**
 * What a message used to say.
 *
 * Anybody who can read the message can read its history: the point of recording
 * it is that "(edited)" without it asks the room to take the change on trust,
 * and a history only the author could open would not answer that.
 */
export async function editHistory(
    actor: ChatActor,
    messageId: string
): Promise<ChatEditHistory> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, deletedAt: true }
    });
    if (!message) throw new ChatAccessError("That message is gone");
    await requireChannel(actor, message.channelId);

    const rules = await rulesForChannel(message.channelId);
    // A deleted message has no text to compare against, and handing back what it
    // used to say would undo the deletion for anybody who asked.
    if (!rules.keepEditHistory || message.deletedAt) return { kept: false, versions: [] };

    const rows = await prisma.chatMessageEdit.findMany({
        where: { messageId },
        orderBy: { replacedAt: "desc" },
        select: { body: true, replacedAt: true }
    });
    return {
        kept: true,
        versions: rows.map((row) => ({
            body: row.body,
            replacedAt: row.replacedAt.toISOString()
        }))
    };
}

/**
 * Take one back.
 *
 * The author does it, or somebody who administers the channel - moderating a
 * room is exactly the case where removing somebody else's words is the point.
 *
 * What is left behind is the instance's decision. A tombstone by default: the
 * replies under a message stay findable and the message above it does not
 * silently inherit the meaning of the one that went. An operator can choose no
 * trace instead, and then the row goes and so do its files - "no trace" that
 * left the bytes on the NAS would be a claim the storage does not back.
 */
export async function remove(
    actor: ChatActor,
    messageId: string,
    /** Answering a report, where the authority is the instance's rather than the
     *  conversation's. It skips the two checks that ask about *this* room - being
     *  the author, and the window an author may take their own words back in -
     *  and nothing else. Only ever passed from behind an administrator gate: it
     *  is the whole check, so the caller is the whole check. */
    options?: { readonly asModerator?: boolean }
): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: {
            channelId: true,
            authorId: true,
            parentId: true,
            replyCount: true,
            createdAt: true
        }
    });
    if (!message) return;
    // The conversation is not asked at all when the instance has decided:
    // somebody answering a report is acting on a room they are not in, which is
    // the whole point of an instance-wide queue.
    const moderating = options?.asModerator === true;
    const mayAdminister = moderating
        ? true
        : (await requireChannel(actor, message.channelId)).mayAdminister;
    const mine = message.authorId === actor.id;
    if (!mine && !mayAdminister) {
        throw new ChatAccessError("You cannot delete that message");
    }

    const rules = await rulesForChannel(message.channelId);
    // The window binds the author, not a moderator. Somebody removing a message
    // from a room they run is not taking back their own words, and a rule that
    // stopped them would turn moderation into a race against a clock.
    if (mine && !mayAdminister && !core.withinEditWindow(rules, message.createdAt)) {
        throw new ChatRuleError(
            `Messages here can be deleted for ${core.editWindowLabel(rules.editWindowMinutes)} after they are sent`
        );
    }

    // A thread root is the one message that cannot leave without trace: the
    // replies hang off it by foreign key and would cascade away with it, so
    // choosing "no trace" would delete other people's messages. The tombstone is
    // the honest outcome there, and it is what keeps the thread reachable.
    const wouldTakeOthers = message.replyCount > 0;

    if (rules.deleteLeavesTrace || wouldTakeOthers) {
        await prisma.chatMessage.update({
            where: { id: messageId },
            data: { deletedAt: new Date(), body: "" }
        });
    } else {
        // Bytes first: the rows cascade with the message, and an attachment row
        // deleted before its file would leave a file nothing points at.
        await discardAttachments(messageId);
        await prisma.$transaction(async (tx) => {
            await tx.chatMessage.delete({ where: { id: messageId } });
            if (message.parentId) {
                await tx.chatMessage.update({
                    where: { id: message.parentId },
                    data: { replyCount: { decrement: 1 } }
                });
            }
        });
    }
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
 * Say that this browser now has the messages.
 *
 * The second tick, and a different claim to the third: this is the device
 * holding them, and reading is the person. Written on every fetch rather than on
 * a signal of its own, because fetching them *is* the event - a client that has
 * the messages has had them delivered, whatever it does next.
 *
 * Only where there is somebody to tell. A membership row is what carries the
 * mark, and somebody reading a public channel through the space has none.
 */
async function markDelivered(actor: ChatActor, channelId: string): Promise<void> {
    await prisma.chatChannelMember.updateMany({
        where: { channelId, userId: actor.id },
        data: { lastDeliveredAt: new Date() }
    });
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
    return decorateMessages(actor, rows);
}

/** Say that somebody is composing, and which way. Nothing is stored: it is true
 *  for a few seconds and then it is not, and a table would only ever hold stale
 *  rows. */
export async function announceTyping(
    actor: ChatActor & { name: string },
    channelId: string,
    activity: core.ChatActivity = "typing"
): Promise<void> {
    await requireChannel(actor, channelId);
    publishChatChange({
        channelId,
        kind: "typing",
        actorId: actor.id,
        actorName: actor.name,
        activity
    });
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
 * Exported because search builds the same views from rows it selected itself,
 * and a second copy of this would be a second place for a message to be drawn
 * without its reactions.
 *
 * Both in one query for the whole page rather than per message. Author names are
 * looked up rather than joined - `authorId` is deliberately not a foreign key,
 * so a join would drop every message written by somebody who has since deleted
 * their account, which is the opposite of what a record of a conversation is
 * for.
 */
export async function decorateMessages(actor: ChatActor, rows: readonly Row[]): Promise<ChatMessageView[]> {
    if (rows.length === 0) return [];

    const authorIds = [
        ...new Set(rows.map((row) => row.authorId).filter((id): id is string => id !== null))
    ];
    const quotedIds = [
        ...new Set(rows.map((row) => row.replyToId).filter((id): id is string => id !== null))
    ];
    // The links in the page, looked up in one query rather than one per message.
    // Nothing is fetched here: a read path that could reach out to a third party
    // is a read path that hangs when they are slow.
    const links = new Map<string, string>();
    for (const row of rows) {
        if (row.deletedAt) continue;
        const link = core.firstLink(row.body);
        if (link) links.set(row.id, link);
    }

    // How far the reader's own messages got, in a one-to-one conversation where
    // both sides allow it. Worked out once for the page rather than per message:
    // it is one other person and two timestamps.
    const receipts = await receiptStateFor(actor, rows);

    const [authors, reactions, files, stars, quoted, previews] = await Promise.all([
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
            select: {
                id: true,
                name: true,
                size: true,
                waveform: true,
                messageId: true,
                durationMs: true,
                contentType: true
            }
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
            : Promise.resolve([]),
        knownPreviews([...links.values()])
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

    // What this reader calls people, laid over what those people are called.
    // One query for the page: a nickname is per reader, so it cannot be resolved
    // where the names are, and a lookup per message would be fifty of them.
    const called = await nicknamesFor(actor.id, [...authorIds, ...quoteAuthorIds]);
    const names = new Map(
        [...authors, ...quoteAuthors].map((author) => [
            author.id,
            called.get(author.id) ?? author.name
        ])
    );
    const quotes = new Map(quoted.map((row) => [row.id, row]));
    const kept = new Set(stars.map((row) => row.messageId));
    const onMessageFiles = new Map<string, ChatAttachmentView[]>();
    for (const file of files) {
        const bucket = onMessageFiles.get(file.messageId) ?? [];
        bucket.push({
            id: file.id,
            name: file.name,
            size: Number(file.size),
            waveform: file.waveform,
            durationMs: file.durationMs,
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
        link: links.get(row.id) ?? null,
        preview: previewOf(row, links, previews),
        previewPending: pendingOf(row, links, previews),
        receipt: receiptFor(row, actor, receipts),
        createdAt: row.createdAt.toISOString()
    }));
}

/** How far the other person in a one-to-one conversation has got. Null when
 *  there is no such person, or when the ticks are not theirs to be shown. */
interface ReceiptState {
    readonly deliveredAt: Date | null;
    readonly readAt: Date | null;
}

/**
 * The other side's marks, if this is a conversation that has ticks at all.
 *
 * Everything about this is deliberately narrow. Only a one-to-one conversation:
 * "read by three of the seven people here" is a different feature and not one
 * anybody asked for. Only when both settings allow it, because a receipt you can
 * see and they cannot is a mirror rather than a setting. And nothing at all in a
 * page with none of the reader's own messages in it, which costs the lookup
 * nothing.
 */
async function receiptStateFor(
    actor: ChatActor,
    rows: readonly Row[]
): Promise<ReceiptState | null> {
    const mine = rows.filter((row) => row.authorId === actor.id && !row.deletedAt);
    if (mine.length === 0) return null;

    const channelId = mine[0]!.channelId;
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { kind: true }
    });
    if (channel?.kind !== "dm") return null;

    const other = await prisma.chatChannelMember.findFirst({
        where: { channelId, userId: { not: actor.id } },
        select: { userId: true, lastReadAt: true, lastDeliveredAt: true }
    });
    if (!other) return null;

    // The reader is not resolved as an administrator here: these are their own
    // messages in their own conversation, and the admin exception is about
    // reading somebody else's.
    const allowed = await receiptsBetween({ id: actor.id, isAdmin: false }, other.userId);
    if (!allowed) return null;

    return { deliveredAt: other.lastDeliveredAt, readAt: other.lastReadAt };
}

/** The ticks for one message. */
function receiptFor(
    row: Row,
    actor: ChatActor,
    state: ReceiptState | null
): core.MessageReceipt | null {
    if (!state || row.authorId !== actor.id || row.deletedAt) return null;
    if (state.readAt && state.readAt >= row.createdAt) return "read";
    if (state.deliveredAt && state.deliveredAt >= row.createdAt) return "delivered";
    return "sent";
}

/** The card under one message, or null when there is no link or nothing is yet
 *  known about it. */
function previewOf(
    row: Row,
    links: ReadonlyMap<string, string>,
    previews: ReadonlyMap<string, KnownPreview>
): LinkPreviewView | null {
    const link = links.get(row.id);
    return link ? (previews.get(link)?.view ?? null) : null;
}

/**
 * Whether this message's link is one worth asking about.
 *
 * Either nobody has looked yet, or what was found has gone stale - a page that
 * said nothing an hour ago is worth one more try, since "nothing" is as often
 * about a slow site or a network that was down as about the page. What is not
 * done is asking on every render: that would be a request per drawn card for a
 * page that has already answered.
 */
function pendingOf(
    row: Row,
    links: ReadonlyMap<string, string>,
    previews: ReadonlyMap<string, KnownPreview>
): boolean {
    const link = links.get(row.id);
    if (link === undefined) return false;
    const known = previews.get(link);
    return known === undefined || known.askAgain;
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
    return {
        id: original.id,
        authorName: original.authorId ? (names.get(original.authorId) ?? null) : null,
        // The words, not the Markdown they were written in. A quote that read
        // "```py print(1) ```" showed the reader the fence rather than the code.
        excerpt: original.deletedAt ? "" : plainExcerpt(original.body, QUOTE_LENGTH),
        deleted: original.deletedAt !== null,
        forwarded: row.forwarded
    };
}
