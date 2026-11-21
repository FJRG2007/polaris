/**
 * Message requests (ledger row 17).
 *
 * Somebody whose "who can message me" (`messages`) leaves the sender out is not
 * refused a conversation: it opens as a request on their side. Their member row
 * carries `requestedAt` and is muted, so it is off their rail, rings nothing,
 * counts toward no badge and sends no read receipt (`markRead` skips it). They
 * read the waiting messages at /chat/requests and accept, delete or block.
 * Answering in the conversation accepts it too (`sendMessage`).
 *
 * Only a new one-to-one is ever held: a conversation that already exists stays
 * exactly as it was, and so does every account that never touched the field,
 * whose default is everybody.
 */

import { prisma } from "@polaris/db";
import { publishChatChange } from "./live";
import { block, BlockError, blockedBetween } from "@/lib/blocks";
import { ChatAccessError, type ChatActor } from "./access";
import { allowedBy, colleaguesAmong } from "@/lib/privacy-service";

/** The most requests listed at once; older ones wait their turn. */
export const MOST_MESSAGE_REQUESTS_LISTED = 50;

/** How much of the newest waiting message the list shows. */
const PREVIEW_CHARS = 160;

/** One waiting request, as the recipient's list draws it. */
export interface MessageRequestView {
    readonly channelId: string;
    readonly senderId: string;
    readonly senderName: string;
    /** For the link to their profile; null for an account without a handle. */
    readonly senderUsername: string | null;
    readonly preview: string;
    readonly waiting: number;
    readonly requestedAt: string;
}

/**
 * Whether a new conversation from the actor would land in the recipient's
 * requests. Colleagues count as friends, as they do for calls and group adds;
 * the viewer is never treated as an administrator.
 */
export async function landsInRequests(actorId: string, recipientId: string): Promise<boolean> {
    if (actorId === recipientId) return false;
    const colleagues = await colleaguesAmong(actorId, [recipientId]);
    const allowed = await allowedBy({ id: actorId, isAdmin: false }, "messages", [recipientId], colleagues);
    return !allowed.has(recipientId);
}

/** The requests waiting on the actor, newest first, each with a short preview. */
export async function pendingMessageRequests(actor: ChatActor): Promise<MessageRequestView[]> {
    const rows = await prisma.chatChannelMember.findMany({
        where: { userId: actor.id, requestedAt: { not: null }, channel: { kind: "dm" } },
        orderBy: { requestedAt: "desc" },
        take: MOST_MESSAGE_REQUESTS_LISTED,
        select: {
            channelId: true,
            requestedAt: true,
            channel: {
                select: {
                    members: {
                        where: { userId: { not: actor.id } },
                        take: 1,
                        select: { user: { select: { id: true, name: true, username: true } } }
                    }
                }
            }
        }
    });
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.channelId);

    // The newest visible message of each and how many are waiting, in two
    // set-based reads rather than two per request.
    const [newest, counts] = await Promise.all([
        prisma.$queryRaw<{ channelId: string; body: string }[]>`
            SELECT c."id" AS "channelId", m."body"
            FROM unnest(${ids}::uuid[]) AS c("id")
            CROSS JOIN LATERAL (
                SELECT "body" FROM "ChatMessage"
                WHERE "channelId" = c."id" AND "parentId" IS NULL AND "deletedAt" IS NULL
                    AND "authorId" IS NOT NULL AND cardinality("audience") = 0
                ORDER BY "createdAt" DESC
                LIMIT 1
            ) AS m`,
        prisma.chatMessage.groupBy({
            by: ["channelId"],
            where: { channelId: { in: ids }, deletedAt: null, authorId: { not: null } },
            _count: { _all: true }
        })
    ]);
    const bodies = new Map(newest.map((row) => [row.channelId, row.body]));
    const waiting = new Map(counts.map((row) => [row.channelId, row._count._all]));

    return rows.flatMap((row) => {
        const sender = row.channel.members[0]?.user;
        if (!sender) return [];
        const body = (bodies.get(row.channelId) ?? "").replace(/\s+/g, " ").trim();
        return [
            {
                channelId: row.channelId,
                senderId: sender.id,
                senderName: sender.name || (sender.username ? `@${sender.username}` : ""),
                senderUsername: sender.username ?? null,
                preview: body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS - 1)}...` : body,
                waiting: waiting.get(row.channelId) ?? 0,
                requestedAt: (row.requestedAt ?? new Date()).toISOString()
            }
        ];
    });
}

/** How many requests are waiting, for the link that leads to them. */
export async function messageRequestCount(actor: ChatActor): Promise<number> {
    return prisma.chatChannelMember.count({
        where: { userId: actor.id, requestedAt: { not: null }, channel: { kind: "dm" } }
    });
}

/** The actor's own pending request row in this conversation, or a refusal. */
async function requestRow(actor: ChatActor, channelId: string) {
    const row = await prisma.chatChannelMember.findFirst({
        where: { channelId, userId: actor.id, requestedAt: { not: null }, channel: { kind: "dm" } },
        select: { id: true, channel: { select: { members: { select: { userId: true } } } } }
    });
    if (!row) throw new ChatAccessError({ key: "errors.messageRequestGone" });
    const senderId = row.channel.members.find((member) => member.userId !== actor.id)?.userId;
    return { id: row.id, senderId };
}

/**
 * Accept: the conversation joins the rail, unmuted, and from here on behaves
 * like any other. A block set since refuses, with the sentence every block gives.
 */
export async function acceptMessageRequest(actor: ChatActor, channelId: string): Promise<string> {
    const { id, senderId } = await requestRow(actor, channelId);
    if (senderId && (await blockedBetween(actor.id, [senderId])).size > 0) {
        throw new ChatAccessError({ key: "errors.cannotStartConversation" });
    }
    await prisma.chatChannelMember.update({
        where: { id },
        data: { requestedAt: null, muted: false }
    });
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [actor.id] });
    return channelId;
}

/**
 * Delete: the recipient leaves the conversation. The sender is not told - their
 * side keeps what they wrote - and the conversation gives up its one-to-one
 * key, so a later conversation from them (or to them) is a new one: a fresh
 * request rather than a way back into this one. With `andBlock`, the sender is
 * blocked as well.
 */
export async function declineMessageRequest(
    actor: ChatActor,
    channelId: string,
    andBlock: boolean
): Promise<void> {
    const { id, senderId } = await requestRow(actor, channelId);
    if (andBlock && senderId) {
        // Blocking says its own reasons in English (the list is full, the
        // account is gone); here it is one translated sentence instead.
        try {
            await block(actor.id, senderId);
        } catch (caught) {
            if (caught instanceof BlockError) {
                throw new ChatAccessError({ key: "errors.messageRequestBlockFailed" });
            }
            throw caught;
        }
    }
    await prisma.$transaction([
        prisma.chatChannelMember.delete({ where: { id } }),
        prisma.chatChannel.update({ where: { id: channelId }, data: { dmKey: null } })
    ]);
    publishChatChange({ channelId, kind: "channels", actorId: actor.id, audience: [actor.id] });
}
