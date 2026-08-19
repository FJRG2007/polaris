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
import { blockedBy } from "@/lib/blocks";
import { nicknamesFor } from "@/lib/contact-names";
import { referenceFromUrl } from "@/components/rich-text/references";
import {
    anyAbsolute,
    chatReferencesIn,
    polarisOrigin,
    resolveChatReferences,
    type ChatReferenceView
} from "./references";
import { announceRoomMention } from "./room-mentions";
import { noticePeople, renderNotice } from "./notice-text";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { isBlankMarkdown } from "@/components/rich-text/markdown";
import { allowedBy, maySee, receiptsBetween } from "@/lib/privacy-service";
import { discardAttachments, isInlineImage, type StoredAttachment } from "./attachments";
import { knownPreviews, unfurl, type KnownPreview, type LinkPreviewView } from "./link-preview";
import {
    ChatAccessError,
    ChatRuleError,
    reachableChannelIds,
    requireChannel,
    requirePostable,
    type ChannelAccess,
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
    /**
     * Whether this reader has blocked whoever wrote it.
     *
     * The message is still carried rather than dropped, and the list draws it
     * folded away with a way to look. Two reasons it is not simply left out: a
     * conversation with holes in it reads as a bug rather than as a decision,
     * and the replies underneath one would be answering nothing.
     *
     * Only ever the reader's own decision. A block set by the author against
     * this reader changes nothing here - what they wrote is still what they
     * wrote, and hiding it would tell the reader something they were not told.
     */
    readonly blocked: boolean;
    /**
     * What this message points at inside Polaris, resolved for this reader.
     *
     * Carried rather than looked up by the screen for the reason every other
     * per-reader field here is: a page of messages is one resolution, and a
     * component asking per chip would be a request per name. Resolved on every
     * read rather than stored on the message, because what a reference is - the
     * conversation's name, whether this reader may see it - is a fact about now
     * and not about when somebody pasted it.
     */
    readonly references: readonly ChatReferenceView[];
    /**
     * Whether this reader may send it into another conversation.
     *
     * The author's own setting, resolved for this reader. Carried on the message
     * rather than asked when the menu opens, because a menu that offers Forward
     * and then refuses is worse than one that does not offer it - and the answer
     * is per author, so a page of messages is a page of different answers.
     */
    readonly forwardable: boolean;
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

/** Said when somebody answers a message that has been taken back. One sentence
 *  for the reply, the thread and the forward, because it is one situation. */
const GONE = "That message was deleted";

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
    await markDelivered(actor, await requireChannel(actor, channelId));

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
    await markDelivered(actor, await requireChannel(actor, channelId));
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
    const access = await requirePostable(actor, input.channelId);
    await requireSendable(actor, access, input.body);
    await refuseIfBlocked(actor, access);

    // Nothing but whitespace, whatever punctuation it serialized into. The
    // schema refuses an empty string and the composer refuses a blank one, and
    // this is the same question asked of the written text: a few spaces and some
    // shift-enters come out of the editor as a lone backslash, which is a
    // message that passes both and reads as a mistake to the whole room.
    //
    // A forward is the exception, and it was a bug: the message being passed on
    // is the content, the note on top is optional and says so on the dialog -
    // and this refused every forward somebody sent without typing one.
    if (attachments.length === 0 && !quote?.forwarded && isBlankMarkdown(input.body)) {
        throw new ChatRuleError("Write something first");
    }

    if (input.parentId) {
        const parent = await prisma.chatMessage.findUnique({
            where: { id: input.parentId },
            select: { channelId: true, parentId: true, deletedAt: true }
        });
        if (!parent || parent.channelId !== input.channelId) {
            throw new ChatAccessError("That message is not in this conversation");
        }
        if (parent.deletedAt) throw new ChatRuleError(GONE);
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
            select: { channelId: true, deletedAt: true }
        });
        // Answering something that is no longer there. The menus already hide
        // both actions on a deleted message, so this is the case they cannot
        // cover: the message was taken back while somebody had the reply box
        // open, or the forward dialog, and what would land is a quote of a
        // tombstone - a line reading "message deleted" above a reply to nothing.
        //
        // Only for a NEW one. A reply written before the original was deleted
        // keeps its quote and keeps saying "message deleted", which is what makes
        // the rest of the conversation readable.
        if (original?.deletedAt) throw new ChatRuleError(GONE);
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
                    ? {
                          attachments: {
                              createMany: { data: attachments.map((file) => ({ ...file })) }
                          }
                      }
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
 * Writing to somebody this account has blocked.
 *
 * Only that direction, and only in a one-to-one conversation. Blocking somebody
 * is a decision about being reached, not a promise to stay silent, but a
 * messenger that lets you write into a room you have shut is a messenger that
 * will let you have a conversation with somebody who is not receiving it. So it
 * is refused, and the sentence says exactly what to do about it - there is
 * nothing to hide from the person who set the block.
 *
 * The other direction is deliberately not refused here. Somebody who has been
 * blocked writes, and it is stored, and it reaches nobody: no toast, no unread,
 * collapsed where it lands. That is the only shape that does not announce the
 * block - an error appearing where messages used to send is the announcement,
 * however carefully it is worded.
 */
async function refuseIfBlocked(actor: ChatActor, access: ChannelAccess): Promise<void> {
    if (access.kind !== "dm") return;
    const others = await prisma.chatChannelMember.findMany({
        where: { channelId: access.channelId, userId: { not: actor.id } },
        select: { userId: true, user: { select: { name: true } } }
    });
    if (others.length === 0) return;

    const blocked = await blockedBy(
        actor.id,
        others.map((row) => row.userId)
    );
    if (blocked.size === 0) return;

    const name = others.find((row) => blocked.has(row.userId))?.user.name || "them";
    throw new ChatRuleError(`You blocked ${name}. Unblock them to send a message.`);
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
async function requireSendable(
    actor: ChatActor,
    access: ChannelAccess,
    body: string,
    options: { wait?: boolean } = {}
): Promise<void> {
    const channelId = access.channelId;
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

    if (options.wait === false) return;

    /**
     * Slow mode: how long this room makes somebody wait between messages.
     *
     * A different thing from the limit above, which is the instance stopping a
     * script. This one is a room stopping a hundred people talking over each
     * other, it is set by whoever runs the room, and it is measured from the
     * last thing this person said rather than counted over a window - which is
     * what makes it predictable enough to wait out.
     *
     * Whoever may moderate the room is not held by it. A moderator who cannot
     * answer for ten minutes cannot moderate, and every client that has this
     * exempts them.
     */
    if (access.mayModerate) return;
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { slowmode: true }
    });
    if (!channel || channel.slowmode <= 0) return;
    // Deleted messages count. Otherwise the way round slow mode is to send and
    // delete, which is the same room full of noise plus a trail of tombstones.
    const last = await prisma.chatMessage.findFirst({
        where: { channelId, authorId: actor.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true }
    });
    const wait = core.slowmodeWait({
        slowmode: channel.slowmode,
        lastSentAt: last?.createdAt ?? null,
        now: new Date()
    });
    if (wait > 0) {
        throw new ChatRuleError(
            `Slow mode is on here. You can send again in ${core.slowmodeSpoken(wait)}.`
        );
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
    const editable = await requirePostable(actor, message.channelId);
    if (message.authorId !== actor.id)
        throw new ChatAccessError("You can only edit your own messages");
    if (message.deletedAt) throw new ChatAccessError("That message was deleted");
    // The length and the instance's own limit, but never the wait: slow mode is
    // about how often somebody speaks, and rewriting what you already said is
    // not speaking again.
    await requireSendable(actor, editable, input.body, { wait: false });
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
/** One message, with the conversation it came out of named. */
export interface CarriedMessage {
    readonly message: ChatMessageView;
    /** What to call the room it came from, for the line above the box: a person
     *  answering privately needs to know which of the four channels they are in
     *  today this was said in. Null for a conversation with no name of its own,
     *  where "in" would have nothing to follow it. */
    readonly from: string | null;
    /** Whether that name is a channel, so the screen can write the hash in front
     *  of it without guessing from the shape of the name. */
    readonly channel: boolean;
}

/**
 * Read one message, wherever it is, for carrying it somewhere else.
 *
 * What answering somebody privately needs: the message is quoted in a
 * conversation it was not said in, so it has to be fetched on its own rather
 * than found in the page already on screen - the two conversations are different
 * screens and the second one has never loaded the first.
 *
 * Authorized the way everything else here is: the channel it sits in, asked
 * before a word of it is returned. Somebody who cannot read the room cannot
 * carry a line out of it by holding onto an id.
 */
export async function readMessage(actor: ChatActor, messageId: string): Promise<CarriedMessage> {
    const found = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true }
    });
    if (!found) throw new ChatAccessError("That message is gone");
    await requireChannel(actor, found.channelId);

    const [row, channel] = await Promise.all([
        prisma.chatMessage.findUnique({ where: { id: messageId }, select: MESSAGE_SELECT }),
        prisma.chatChannel.findUnique({
            where: { id: found.channelId },
            select: { name: true, spaceId: true, kind: true }
        })
    ]);
    if (!row) throw new ChatAccessError("That message is gone");
    const [message] = await decorateMessages(actor, [row]);
    if (!message) throw new ChatAccessError("That message is gone");
    return {
        message,
        // A direct message is named after whoever is in it, which from here is
        // the person being answered - saying "in Grace" above a box addressed to
        // Grace is noise, so it is left off.
        from: channel && channel.kind !== "dm" ? channel.name : null,
        channel: channel?.spaceId !== null && channel?.spaceId !== undefined
    };
}

export async function editHistory(actor: ChatActor, messageId: string): Promise<ChatEditHistory> {
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
    // Moderation rather than administration: the person whose group it is may
    // take a message out of it without that making them an administrator of a
    // conversation which has none.
    const mayAdminister = moderating
        ? true
        : (await requireChannel(actor, message.channelId)).mayModerate;
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
        // The line stays and says so; nothing else does. A tombstone carries no
        // text, no files and no reactions - which is how it is already drawn - so
        // leaving the bytes on the NAS would be keeping a photograph nothing can
        // reach and nobody can find, on somebody else's disk, forever.
        await discardAttachments(messageId);
        await prisma.$transaction(async (tx) => {
            await tx.chatAttachment.deleteMany({ where: { messageId } });
            await tx.chatReaction.deleteMany({ where: { messageId } });
            await tx.chatMessage.update({
                where: { id: messageId },
                data: { deletedAt: new Date(), body: "" }
            });
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
async function markDelivered(actor: ChatActor, channel: ChannelAccess): Promise<void> {
    const now = new Date();
    const channelId = channel.channelId;

    // The moment itself, on the messages themselves, and only in a one-to-one
    // conversation - which is the only place there is a "the other person" to
    // draw an information panel about. The mark below says how far this reader
    // has got now; it can never say when they got to a particular message.
    if (channel.kind === "dm" && channel.member) {
        const mark = await prisma.chatChannelMember.findUnique({
            where: { channelId_userId: { channelId, userId: actor.id } },
            select: { lastDeliveredAt: true }
        });
        await prisma.chatMessage.updateMany({
            where: {
                channelId,
                authorId: { not: actor.id },
                deliveredAt: null,
                // From where the last pick-up left off. Everything older than
                // that arrived long ago - possibly before Polaris recorded the
                // moment at all - and stamping it now would put today's time on
                // a message from March.
                ...(mark?.lastDeliveredAt ? { createdAt: { gte: mark.lastDeliveredAt } } : {})
            },
            data: { deliveredAt: now }
        });
    }

    await prisma.chatChannelMember.updateMany({
        where: { channelId, userId: actor.id },
        data: { lastDeliveredAt: now }
    });
}

/**
 * Mark a channel read up to a message.
 *
 * Never moves the mark backwards. Two tabs open on the same channel disagree
 * about what has been seen, and the one scrolled further up must not un-read
 * what the other already read.
 *
 * Announced, because nothing else says somebody caught up: the count on the
 * desktop they left open stayed until the page was reloaded, and the second tick
 * under the other person's message stayed grey for the same reason. Only
 * announced when the mark actually moved - every early return above this is a
 * read that changed nothing - and only to the screens `readAudience` names.
 */
export async function markRead(actor: ChatActor, input: core.ChatMarkReadInput): Promise<void> {
    const channel = await requireChannel(actor, input.channelId);
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

    // The moment, on everything this crossed. Bounded by the mark it replaces,
    // so a conversation opened for the tenth time stamps whatever arrived since
    // the ninth and nothing else.
    if (channel.kind === "dm") {
        await prisma.chatMessage.updateMany({
            where: {
                channelId: input.channelId,
                authorId: { not: actor.id },
                readAt: null,
                createdAt: {
                    lte: message.createdAt,
                    ...(current?.lastReadAt ? { gt: current.lastReadAt } : {})
                }
            },
            data: { readAt: new Date() }
        });
    }

    publishChatChange({
        channelId: input.channelId,
        kind: "read",
        actorId: actor.id,
        audience: await readAudience(actor, channel)
    });
}

/**
 * Put a conversation back to unread.
 *
 * The one write that moves the read mark backwards, and the only reason it may:
 * `markRead` refuses to, because two tabs disagreeing about how far somebody
 * has scrolled must never un-read what one of them already read. This is not
 * that - it is somebody saying so on purpose, and it is the whole feature.
 *
 * Where the mark lands is the message immediately **before** the one to pick up
 * from, so that message is the first thing waiting rather than the last thing
 * read. From the conversation list there is no message under the pointer, and
 * the answer is the newest one somebody else said - which leaves exactly one
 * message waiting, the number every client shows for this.
 *
 * "Newest one somebody else said" means the same thing the badge means, and the
 * filters below are the ones `unreadCounts` applies: not a line Polaris wrote
 * itself, not a reply inside a thread, and not the reader's own. A boundary
 * picked from a wider set would mark a conversation unread and then show a
 * count of zero, which reads as a menu item that did nothing.
 *
 * Marking a conversation unread that has nothing in it to read is not an error;
 * it writes nothing and says so by leaving the badge alone.
 *
 * The ticks are deliberately left alone. `readAt` on a message records the
 * moment somebody actually saw it, and they did; retracting that would tell the
 * other person their message went back to unseen, which is not true and is not
 * this reader's to say. What changes is only where this reader is picking the
 * conversation up.
 */
export async function markUnread(actor: ChatActor, input: core.ChatMarkUnreadInput): Promise<void> {
    const channel = await requireChannel(actor, input.channelId);

    /** What is countable here, and therefore what a boundary may be picked from. */
    const countable = {
        channelId: input.channelId,
        deletedAt: null,
        parentId: null,
        kind: { not: "system" },
        authorId: { not: actor.id }
    };

    const from = input.messageId
        ? await prisma.chatMessage.findFirst({
              where: { id: input.messageId, channelId: input.channelId },
              select: { createdAt: true }
          })
        : await prisma.chatMessage.findFirst({
              where: countable,
              orderBy: { createdAt: "desc" },
              select: { createdAt: true }
          });
    // A message in another conversation, or a conversation nobody has said
    // anything in. Neither is worth an error: the menu offering this can be a
    // moment out of date, and the outcome asked for is already the case.
    if (!from) return;

    // Deliberately not `countable` - the new mark only has to sit before the
    // message being picked up from, and the message that happens to be there
    // may well be a system line or the reader's own. What must not happen is a
    // mark landing on or after it.
    const previous = await prisma.chatMessage.findFirst({
        where: { channelId: input.channelId, createdAt: { lt: from.createdAt } },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true }
    });

    const current = await prisma.chatChannelMember.findUnique({
        where: { channelId_userId: { channelId: input.channelId, userId: actor.id } },
        select: { lastReadAt: true }
    });
    // Already unread from at least this far back. Writing anyway would move the
    // mark forwards, which is the one thing this must never do - somebody
    // marking a conversation unread twice would end up having read more of it.
    if (!current?.lastReadAt) return;
    if (previous && current.lastReadAt <= previous.createdAt) return;

    await prisma.chatChannelMember.update({
        where: { channelId_userId: { channelId: input.channelId, userId: actor.id } },
        data: {
            lastReadMessageId: previous?.id ?? null,
            lastReadAt: previous?.createdAt ?? null
        }
    });

    // The same frame a read sends, because it is the same fact changing: the
    // rail on the desktop they left open, and this tab's own badge.
    publishChatChange({
        channelId: input.channelId,
        kind: "read",
        actorId: actor.id,
        audience: await readAudience(actor, channel)
    });
}

/**
 * Whose screens a read is for.
 *
 * Always the reader's own, which is the count coming down on the desktop they
 * left open. The other person as well, but only in a one-to-one conversation
 * where the ticks are theirs to see: the frame arrives at the instant somebody
 * opened the message, which is the fact the setting withholds - a receipt
 * nothing draws is still a receipt if it is on the wire.
 *
 * One person everywhere else. No screen consumes somebody else's read outside a
 * one-to-one - "read by four of the seven here" is a different feature - and
 * telling fifty members about each other's reading is a frame per pair per
 * message for nothing.
 */
async function readAudience(actor: ChatActor, channel: ChannelAccess): Promise<string[]> {
    if (channel.kind !== "dm") return [actor.id];

    const other = await prisma.chatChannelMember.findFirst({
        where: { channelId: channel.channelId, userId: { not: actor.id } },
        select: { userId: true }
    });
    if (!other) return [actor.id];

    // Not resolved as an administrator, for the same reason `receiptStateIn` is
    // not: these are the ticks under somebody's own messages, and the admin
    // exception is about reading somebody else's.
    const allowed = await receiptsBetween({ id: actor.id, isAdmin: false }, other.userId);
    return allowed ? [actor.id, other.userId] : [actor.id];
}

/**
 * The ticks for messages that are already on screen.
 *
 * Sending is not the only thing that moves them: the other person reading is,
 * and that happens to a message nothing is going to fetch again. So a screen
 * that has been told somebody caught up asks for the marks by themselves rather
 * than reloading the conversation - which would replace every message on it and
 * take the reader back to the bottom.
 *
 * Computed by the same path the page uses, privacy included, so a reader cannot
 * be shown a receipt the other person's settings withhold.
 */
export async function receiptsFor(
    actor: ChatActor,
    channelId: string,
    messageIds: readonly string[]
): Promise<Record<string, core.MessageReceipt>> {
    await requireChannel(actor, channelId);
    const wanted = [...new Set(messageIds)].slice(0, core.MAX_CHAT_RECEIPTS);
    if (wanted.length === 0) return {};

    const state = await receiptStateIn(actor, channelId);
    if (!state) return {};

    const rows = await prisma.chatMessage.findMany({
        where: { id: { in: wanted }, channelId, authorId: actor.id, deletedAt: null },
        select: { id: true, createdAt: true }
    });
    return Object.fromEntries(rows.map((row) => [row.id, receiptAt(state, row.createdAt)]));
}

/** When one message got where it was going. */
export interface MessageDelivery {
    readonly sentAt: string;
    /**
     * When the other person's device picked it up, and when they saw it.
     *
     * Null for a step that has not happened - and also for one that happened
     * before Polaris recorded the moment, which is why `state` is here too: it
     * is worked out from the marks that have always existed, so an old message
     * can say it was read without inventing an hour for it.
     */
    readonly deliveredAt: string | null;
    readonly readAt: string | null;
    readonly state: core.MessageReceipt;
}

/**
 * When a message was sent, arrived and was read.
 *
 * Only for the reader's own message in a one-to-one conversation where both
 * settings allow the ticks - the same rule that decides whether they are drawn.
 * Null when there is nothing to say, which is the panel's cue not to be offered.
 */
export async function deliveryOf(
    actor: ChatActor,
    messageId: string
): Promise<MessageDelivery | null> {
    const row = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: {
            channelId: true,
            authorId: true,
            createdAt: true,
            deletedAt: true,
            deliveredAt: true,
            readAt: true
        }
    });
    if (!row) return null;
    await requireChannel(actor, row.channelId);
    if (row.authorId !== actor.id || row.deletedAt) return null;

    const state = await receiptStateIn(actor, row.channelId);
    if (!state) return null;

    return {
        sentAt: row.createdAt.toISOString(),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        readAt: row.readAt?.toISOString() ?? null,
        state: receiptAt(state, row.createdAt)
    };
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
 *
 * The author's own setting is the third thing proved. The screen already hides
 * the action for a message that does not allow it, which is where somebody finds
 * out; this is where it is true, because a hidden button is a decoration and an
 * action anybody can call is the actual interface.
 */
export async function forward(actor: ChatActor, input: core.ChatForwardInput): Promise<string> {
    const original = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { id: true, authorId: true, deletedAt: true }
    });
    if (!original || original.deletedAt) throw new ChatAccessError("That message is gone");
    if (
        original.authorId &&
        !(await maySee(original.authorId, "forwarding", { id: actor.id, isAdmin: false }))
    ) {
        throw new ChatAccessError("They do not allow their messages to be passed on");
    }

    // The note as written, empty included: a space was here to get past the
    // blank-body rule, and it left a message whose text was one space.
    return send(actor, { channelId: input.channelId, body: input.note, parentId: null }, [], {
        messageId: input.messageId,
        forwarded: true
    });
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
export async function decorateMessages(
    actor: ChatActor,
    rows: readonly Row[]
): Promise<ChatMessageView[]> {
    if (rows.length === 0) return [];

    const authorIds = [
        ...new Set(rows.map((row) => row.authorId).filter((id): id is string => id !== null))
    ];
    const quotedIds = [
        ...new Set(rows.map((row) => row.replyToId).filter((id): id is string => id !== null))
    ];
    // The people a line Polaris wrote itself names - "Ada added Grace". They
    // have no author row to be found through, so they join the same lookup and
    // are resolved the same way, which is what keeps a notice calling somebody
    // what they are called now rather than what they were called in March.
    const noticeIds = [
        ...new Set(
            rows.filter((row) => row.kind === "system").flatMap((row) => noticePeople(row.body))
        )
    ];
    // The links in the page, looked up in one query rather than one per message.
    // Nothing is fetched here: a read path that could reach out to a third party
    // is a read path that hangs when they are slow.
    // The address this deployment answers on, for the bodies that still carry a
    // full `https://` one: anything written in the composer had its links folded
    // to a `polaris:` address when it was pasted, and needs no origin at all. A
    // body written before Chat knew its own links, or sent through the API,
    // does - and a page with no absolute address in it does not ask at all,
    // which is nearly every page.
    const origin = await polarisOrigin(anyAbsolute(rows.map((row) => row.body)));

    const links = new Map<string, string>();
    for (const row of rows) {
        if (row.deletedAt) continue;
        const link = core.firstLink(row.body);
        // Never our own. Fetching Polaris's own page to describe it back to
        // somebody already inside it is what this used to do, and the card it
        // drew said less than the address it replaced - the reference below is
        // what that link becomes instead.
        if (link && !referenceFromUrl(link, origin)) links.set(row.id, link);
    }

    // How far the reader's own messages got, in a one-to-one conversation where
    // both sides allow it. Worked out once for the page rather than per message:
    // it is one other person and two timestamps.
    const receipts = await receiptStateFor(actor, rows);

    const [authors, reactions, files, stars, quoted, previews] = await Promise.all([
        authorIds.length || noticeIds.length
            ? prisma.user.findMany({
                  where: { id: { in: [...new Set([...authorIds, ...noticeIds])] } },
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
    const called = await nicknamesFor(actor.id, [...authorIds, ...quoteAuthorIds, ...noticeIds]);
    // Who lets this reader pass their messages on. Not an administrator question
    // and deliberately not given one: chat has no instance-wide override, and a
    // setting about your own words is the last place to introduce the first.
    const mayForward = await allowedBy({ id: actor.id, isAdmin: false }, "forwarding", authorIds);
    // One query for the page, the same shape as the nicknames above: a block is
    // per reader, so it cannot be answered where the messages are.
    const shut = await blockedBy(actor.id, authorIds);

    const pointedAt = new Map<string, string[]>();
    for (const row of rows) {
        const keys = chatReferencesIn(row.body, origin);
        if (keys.length > 0) pointedAt.set(row.id, keys);
    }
    const references = await resolveChatReferences(actor, [...pointedAt.values()].flat());
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
        body: row.deletedAt
            ? ""
            : row.kind === "system"
              ? renderNotice(row.body, names, actor.id)
              : row.body,
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
        blocked: row.authorId !== null && shut.has(row.authorId),
        references: (pointedAt.get(row.id) ?? [])
            .map((key) => references.get(key))
            .filter((found): found is ChatReferenceView => found !== undefined),
        // A message whose author has since deleted their account carries no
        // setting to honour, and a deleted one has nothing left to send.
        forwardable:
            row.deletedAt === null && (row.authorId === null || mayForward.has(row.authorId)),
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
    return receiptStateIn(actor, mine[0]!.channelId);
}

/** The same question asked of a conversation rather than of a page of it, for the
 *  screen that only wants the marks. */
async function receiptStateIn(actor: ChatActor, channelId: string): Promise<ReceiptState | null> {
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
    return receiptAt(state, row.createdAt);
}

/** Which tick one of the reader's own messages has earned, given how far the
 *  other side has got. */
function receiptAt(state: ReceiptState, createdAt: Date): core.MessageReceipt {
    if (state.readAt && state.readAt >= createdAt) return "read";
    if (state.deliveredAt && state.deliveredAt >= createdAt) return "delivered";
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
