/**
 * Ephemeral messages: an answer Polar or an app gives only to the people it
 * names - "Only you can see this" under a button somebody pressed, as Discord's
 * ephemeral flag (64) does.
 *
 * `ChatMessage.audience` lists who may see one; empty is everybody. The rule
 * is kept in the queries, never on the screen:
 *
 * - the conversation itself (a page, a thread, what changed, one message by
 *   its id) shows it to its audience and to nobody else (`seenByClause`);
 * - everything that speaks for the conversation - unread counts, search,
 *   toasts, phone notices, the rail's last line, previews - never counts it at
 *   all, for anybody (`everyoneClause`);
 * - nothing is built on one: no reply, thread, forward, reaction, star or pin.
 *
 * It disappears on its own a day after it was written, or when its reader
 * dismisses it.
 *
 * Server-only, apart from the pure checks the stream and the tests share.
 */

import { prisma, type Prisma } from "@polaris/db";

/** How long an ephemeral answer stays before the sweep takes it. */
export const EPHEMERAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** The most people one ephemeral message is for. */
export const MOST_AUDIENCE = 25;

/** Messages everybody in the conversation sees: every one but an ephemeral answer. */
export function everyoneClause(): Prisma.ChatMessageWhereInput {
    return { audience: { isEmpty: true } };
}

/** Messages this reader sees: everybody's, and the ephemeral ones addressed to them. */
export function seenByClause(viewerId: string): Prisma.ChatMessageWhereInput {
    return { OR: [everyoneClause(), { audience: { has: viewerId } }] };
}

/** Whether a stored message is ephemeral. */
export function isEphemeral(audience: readonly string[] | null | undefined): boolean {
    return Boolean(audience && audience.length > 0);
}

/** Whether this reader may see a message with this audience. */
export function seesMessage(audience: readonly string[] | null | undefined, viewerId: string): boolean {
    return !isEphemeral(audience) || Boolean(audience?.includes(viewerId));
}

/**
 * Whether a live frame about messages reaches this reader. A frame addressed
 * to an audience (an ephemeral answer posted, edited or dismissed) wakes only
 * the screens of the people in it, so nobody else so much as learns an id.
 */
export function frameReaches(
    change: { readonly kind: string; readonly audience?: readonly string[] },
    viewerId: string
): boolean {
    if (change.kind !== "posted" || !change.audience) return true;
    return change.audience.includes(viewerId);
}

/** When a new ephemeral answer goes: a day from now, or sooner if the conversation's timer says so. */
export function ephemeralExpiry(now: Date, channelExpiry: Date | null): Date {
    const own = new Date(now.getTime() + EPHEMERAL_LIFETIME_MS);
    return channelExpiry && channelExpiry < own ? channelExpiry : own;
}

/**
 * The reader dismisses an ephemeral answer. Only they stop seeing it: the
 * last of its audience to dismiss it ends it (it expires now, and the sweep
 * deletes it); anyone before that is taken off its audience - never down to
 * an empty one, which would be a message for everybody.
 *
 * Returns the conversation it was in, or null when there was nothing of
 * theirs to dismiss.
 */
export async function dismissEphemeral(
    viewerId: string,
    messageId: string
): Promise<{ channelId: string; audience: string[] } | null> {
    // Twice at most: a second reader dismissing at the same moment can turn a
    // two-person audience into a one-person one between the two statements.
    for (let attempt = 0; attempt < 2; attempt++) {
        const row = await prisma.chatMessage.findFirst({
            where: { id: messageId, audience: { has: viewerId } },
            select: { channelId: true, audience: true }
        });
        if (!row) return null;
        const ended = await prisma.chatMessage.updateMany({
            where: { id: messageId, audience: { equals: [viewerId] } },
            data: { expiresAt: new Date() }
        });
        if (ended.count > 0) return { channelId: row.channelId, audience: [viewerId] };
        const narrowed = await prisma.$executeRaw`
            UPDATE "ChatMessage" SET "audience" = array_remove("audience", ${viewerId}::uuid)
            WHERE "id" = ${messageId}::uuid AND ${viewerId}::uuid = ANY("audience")
              AND cardinality("audience") > 1`;
        if (narrowed > 0) return { channelId: row.channelId, audience: [viewerId] };
    }
    return null;
}
