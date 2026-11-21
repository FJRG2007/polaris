import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { chatPrivacyIn } from "./vanish";
import { publishChatChange } from "./live";
import { GROUP_RECEIPT_MAX_MEMBERS } from "./group-receipts";

/**
 * The second tick: a device of the recipient holds the message.
 *
 * WhatsApp's meaning, and the one the ticks were always drawn for. It used to be
 * recorded only when the conversation itself was fetched - which is opening it,
 * which also reads it - so the sender went from one tick straight to two in
 * colour and never saw the grey pair in between. Now any screen that is told a
 * message arrived says so (`/api/chat/delivered`), and so does loading Polaris at
 * all, through `deliverEverywhere`.
 *
 * The mark is `ChatChannelMember.lastDeliveredAt`, one row per member: nothing
 * per message is written for a group. A one-to-one also stamps the moment on the
 * messages themselves, as opening it always did, because the information panel
 * there names when the one other person got each one.
 *
 * Only conversations of people - a one-to-one or a group outside a space - are
 * touched. Nothing draws ticks anywhere else, so a mark there is a write nobody
 * reads.
 *
 * Every call is idempotent and monotonic. A row moves only when a message from
 * somebody else is newer than its mark, and only ever forwards, so a repeated or
 * late acknowledgement writes nothing, announces nothing, and can never undo a
 * newer one. That guard is also what coalesces: a burst of acknowledgements for
 * the same conversation is one write and one frame, and the rest find nothing to
 * move.
 */

/** The most conversations one "everything" pass moves. Somebody back after a
 *  month in a thousand conversations has them caught up by the next pass - a
 *  page load or a message arriving - rather than in one statement. */
const MAX_EVERYWHERE = 200;

/** One conversation whose mark moved. */
interface Moved {
    readonly channelId: string;
    readonly kind: string;
    /** Where the mark was before, which bounds the per-message stamp. */
    readonly previous: Date | null;
    /** Where it is now: the later of this moment and the conversation's newest
     *  message, so a server clock a little behind the one that stamped the
     *  message still reaches it. */
    readonly reach: Date;
}

/**
 * Move the mark for these conversations, or for every conversation of the
 * person's when `channelIds` is "all". Answers the conversations that moved.
 *
 * Membership is the filter, not a check done beforehand: the statement only ever
 * touches rows whose `userId` is the caller's, so naming somebody else's
 * conversation - or one that does not exist - moves nothing. Nobody can mark a
 * delivery on anybody else's behalf, because the only row it writes is theirs.
 */
export async function markDelivered(
    userId: string,
    channelIds: readonly string[] | "all",
    now: Date = new Date()
): Promise<string[]> {
    const ids = channelIds === "all" ? [] : [...new Set(channelIds)].slice(0, core.MAX_CHAT_DELIVERED);
    if (channelIds !== "all" && ids.length === 0) return [];
    const everywhere = channelIds === "all";
    const at = now.toISOString();

    // One statement: pick the rows behind, lock them, move them, and say where
    // each was. `lastMessageAt` is the cheap filter - it moves on every post,
    // thread replies included - and the EXISTS is the real one: only a message
    // from somebody else moves the mark, so the sender's own post never claims
    // that their message reached them. Ephemeral answers addressed to somebody
    // (`audience`) are nobody's ticks and do not count. Skipped when locked: a
    // concurrent acknowledgement for the same row is already doing this.
    const moved = await prisma.$queryRaw<Moved[]>`
        WITH due AS (
            SELECT m.id, m."channelId", m."lastDeliveredAt" AS previous, c.kind,
                   GREATEST(${at}::timestamp(3), c."lastMessageAt") AS reach
            FROM "ChatChannelMember" m
            JOIN "ChatChannel" c ON c.id = m."channelId"
            WHERE m."userId" = ${userId}::uuid
              AND (${everywhere} OR m."channelId" = ANY(${ids}::uuid[]))
              AND c."spaceId" IS NULL
              AND c.kind IN ('dm', 'group')
              AND c."lastMessageAt" > COALESCE(m."lastDeliveredAt", '-infinity'::timestamp)
              AND EXISTS (
                  SELECT 1 FROM "ChatMessage" x
                  WHERE x."channelId" = m."channelId"
                    AND x."authorId" <> ${userId}::uuid
                    AND cardinality(x."audience") = 0
                    AND x."createdAt" > COALESCE(m."lastDeliveredAt", '-infinity'::timestamp)
              )
            LIMIT ${everywhere ? MAX_EVERYWHERE : core.MAX_CHAT_DELIVERED}::int
            FOR UPDATE OF m SKIP LOCKED
        )
        UPDATE "ChatChannelMember" t
        SET "lastDeliveredAt" = due.reach
        FROM due
        WHERE t.id = due.id
          AND (t."lastDeliveredAt" IS NULL OR t."lastDeliveredAt" < due.reach)
        RETURNING due."channelId"::text AS "channelId", due.kind, due.previous, due.reach`;
    if (moved.length === 0) return [];

    // The moment on each one-to-one message it crossed, in one statement for
    // every conversation that moved. From where the last pick-up left off:
    // everything older arrived long ago - possibly before Polaris recorded the
    // moment at all - and stamping it now would put today's time on a message
    // from March.
    const direct = moved.filter((row) => row.kind === "dm");
    if (direct.length > 0) {
        await prisma.chatMessage.updateMany({
            where: {
                authorId: { not: userId },
                deliveredAt: null,
                OR: direct.map((row) => ({
                    channelId: row.channelId,
                    createdAt: { lte: row.reach, ...(row.previous ? { gte: row.previous } : {}) }
                }))
            },
            data: { deliveredAt: now }
        });
    }

    await announceDelivered(userId, moved);
    return moved.map((row) => row.channelId);
}

/**
 * Everything waiting for this person, delivered: they have Polaris open, so
 * their device has what the conversation list and the badge are about to show.
 * Never throws - a page render or a count is not the place to fail over a tick.
 */
export async function deliverEverywhere(userId: string): Promise<void> {
    try {
        await markDelivered(userId, "all");
    } catch (error) {
        console.error("[chat] could not record deliveries", error);
    }
}

/**
 * Tell the senders, so the tick under their message turns into a pair while
 * they watch.
 *
 * To the other members of each conversation and nobody else - not the person's
 * own screens, which have no tick to move. Delivered is shown whatever either
 * side's read-receipt setting says, as WhatsApp does: that setting withholds when
 * somebody *read* a message, and saying their device has it is what keeps the
 * sender from wondering whether it was ever sent. A conversation whose own rule
 * turns receipts off draws no ticks at all, so it is told nothing, and neither is
 * a group past the receipt cap, which has none.
 */
async function announceDelivered(userId: string, moved: readonly Moved[]): Promise<void> {
    const ids = moved.map((row) => row.channelId);
    const [members, rules] = await Promise.all([
        prisma.chatChannelMember.findMany({
            where: { channelId: { in: ids }, userId: { not: userId } },
            select: { channelId: true, userId: true },
            take: ids.length * GROUP_RECEIPT_MAX_MEMBERS
        }),
        chatPrivacyIn(ids)
    ]);
    const others = new Map<string, string[]>();
    for (const row of members) {
        const list = others.get(row.channelId) ?? [];
        list.push(row.userId);
        others.set(row.channelId, list);
    }
    for (const channelId of ids) {
        const audience = others.get(channelId) ?? [];
        if (audience.length === 0 || audience.length > GROUP_RECEIPT_MAX_MEMBERS - 1) continue;
        if (rules.get(channelId)?.receipts === "off") continue;
        publishChatChange({ channelId, kind: "delivered", actorId: userId, audience });
    }
}
