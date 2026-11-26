/**
 * Sealed reactions: how a message in a sealed conversation is reacted to
 * (docs/chat-e2ee-mls.md, "Sealed reactions").
 *
 * The reactor's browser seals the emoji they have on a message under the
 * conversation's history key and hands the set over; this module keeps one per
 * person and message and never learns which emoji it holds. Every member's
 * browser opens the sets and makes the counts itself. That is how Signal,
 * WhatsApp and the MLS apps treat a reaction - an encrypted message that names
 * the message it is on - kept here as one row per person so a conversation's
 * history still loads its reactions in one read. What the server still knows
 * is who reacted to which message and when, which is what a reaction sent as a
 * message tells their servers too.
 *
 * The rules a plain reaction has hold the same way: only for people who may
 * react in the room, never on an ephemeral answer. What the server cannot check
 * is which emoji: a browser that opens a set discards one that is not a set,
 * and a space emoji the space no longer has is drawn by its name like a plain
 * one is.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { isEphemeral } from "./ephemeral";
import { publishChatChange } from "./live";
import * as history from "./history-visibility";
import { fromText, toText } from "./e2ee/base64url";
import { conversationSealed } from "./e2ee/sealed-conversation";
import { isSealedReactionsSize } from "@polaris/chat-crypto/message-content";
import { ChatAccessError, ChatRuleError, requireChannel, requirePostable } from "./access";

/** Rows handed out per read; a browser reads on until `next` is null. */
export const REACTION_PAGE = 1_000;
/** Messages asked about in one read: a page of a conversation. */
export const REACTION_MESSAGES = 100;
/**
 * The largest set a browser sends, in plaintext bytes: a few thousand emoji
 * from one person on one message. Only the sweep, from rows the server already
 * holds, seals larger ones.
 */
const PUT_PLAINTEXT_MAX = 64 * 1024;

export const putReactionsSchema = z.object({
    messageId: z.string().uuid(),
    /** Null takes every reaction of this person off the message. */
    set: z
        .object({
            setId: z.string().uuid(),
            epoch: z.string().regex(/^\d{1,19}$/),
            // base64url of the largest set taken (`PUT_PLAINTEXT_MAX` and its 17 bytes of version and tag).
            sealed: z.string().regex(/^[A-Za-z0-9_-]+$/).max(Math.ceil(((PUT_PLAINTEXT_MAX + 17) * 4) / 3))
        })
        .nullable()
});
export type PutReactionsInput = z.infer<typeof putReactionsSchema>;

export const readReactionsSchema = z.object({
    channelId: z.string().uuid(),
    messageIds: z.array(z.string().uuid()).min(1).max(REACTION_MESSAGES),
    /** The last row of the page before. */
    after: z.object({ messageId: z.string().uuid(), userId: z.string().uuid() }).nullable().default(null)
});
export type ReadReactionsInput = z.infer<typeof readReactionsSchema>;

export interface SealedReactionRow {
    readonly messageId: string;
    readonly userId: string;
    readonly setId: string;
    readonly epoch: string;
    readonly sealed: string;
    /** This reader's own set. */
    readonly mine: boolean;
}

export interface SealedReactionsPage {
    readonly rows: readonly SealedReactionRow[];
    readonly next: { readonly messageId: string; readonly userId: string } | null;
}

const NOT_TAKEN = { key: "errors.sealedOnlyReload" } as const;

/** Replace, or take back, this person's sealed set on a message of a sealed conversation. */
export async function putReactions(actor: { id: string }, input: PutReactionsInput, now: Date = new Date()): Promise<void> {
    const message = await prisma.chatMessage.findUnique({ where: { id: input.messageId }, select: { channelId: true, audience: true } });
    if (!message || isEphemeral(message.audience)) throw new ChatAccessError({ key: "errors.messageGone" });
    // A plain conversation is reacted to in the clear, by `messages.react`.
    if (!(await conversationSealed(message.channelId))) throw new ChatRuleError(NOT_TAKEN);
    await requirePostable(actor, message.channelId, { reacting: true });
    await history.requireReadable(actor, message.channelId, input.messageId);

    const set = input.set;
    let sealed: Uint8Array<ArrayBuffer> | null = null;
    let epoch = 0n;
    if (set) {
        sealed = new Uint8Array(fromText(set.sealed));
        epoch = BigInt(set.epoch);
        if (!isSealedReactionsSize(sealed.length, PUT_PLAINTEXT_MAX)) throw new ChatRuleError(NOT_TAKEN);
        // An epoch the group has not reached opens for nobody.
        const group = await prisma.mlsGroup.findUnique({ where: { channelId: message.channelId }, select: { epoch: true } });
        if (!group || epoch > group.epoch) throw new ChatRuleError(NOT_TAKEN);
    }

    await prisma.$transaction(async (tx) => {
        // What this person had on it in the clear before goes with their first set: the browser sealed it in.
        await tx.chatReaction.deleteMany({ where: { messageId: input.messageId, userId: actor.id } });
        if (!set || !sealed) {
            await tx.chatSealedReaction.deleteMany({ where: { messageId: input.messageId, userId: actor.id } });
            return;
        }
        const fields = { setId: set.setId, epoch, sealed, updatedAt: now };
        await tx.chatSealedReaction.upsert({
            where: { messageId_userId: { messageId: input.messageId, userId: actor.id } },
            create: { messageId: input.messageId, userId: actor.id, ...fields },
            update: fields
        });
    });

    publishChatChange({ channelId: message.channelId, kind: "posted", actorId: actor.id, messageIds: [input.messageId] });
}

/** One page of the sealed sets on these messages, for a reader of the conversation. */
export async function readReactions(actor: { id: string }, input: ReadReactionsInput): Promise<SealedReactionsPage> {
    await requireChannel(actor, input.channelId);
    // Only the messages of this conversation the reader may read: past their floor, not hidden, not expired.
    const floor = await history.readableSince(actor, input.channelId);
    const readable = await prisma.chatMessage.findMany({
        where: { id: { in: [...new Set(input.messageIds)] }, channelId: input.channelId, AND: [history.sinceClause(floor, actor.id)] },
        select: { id: true }
    });
    if (!readable.length) return { rows: [], next: null };
    const after = input.after;
    const rows = await prisma.chatSealedReaction.findMany({
        where: {
            messageId: { in: readable.map((row) => row.id) },
            ...(after ? { OR: [{ messageId: { gt: after.messageId } }, { messageId: after.messageId, userId: { gt: after.userId } }] } : {})
        },
        orderBy: [{ messageId: "asc" }, { userId: "asc" }],
        take: REACTION_PAGE + 1,
        select: { messageId: true, userId: true, setId: true, epoch: true, sealed: true }
    });
    const page = rows.slice(0, REACTION_PAGE);
    const last = page[page.length - 1];
    return {
        rows: page.map((row) => ({
            messageId: row.messageId,
            userId: row.userId,
            setId: row.setId,
            epoch: row.epoch.toString(),
            sealed: toText(row.sealed),
            mine: row.userId === actor.id
        })),
        next: rows.length > REACTION_PAGE && last ? { messageId: last.messageId, userId: last.userId } : null
    };
}
