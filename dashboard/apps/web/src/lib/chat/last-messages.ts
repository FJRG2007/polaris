import { prisma } from "@polaris/db";
import type { MessageReceipt } from "@polaris/core";
import { plainExcerpt } from "@/components/rich-text/excerpt";

/** The newest top-level message in a conversation, as its row in the list shows it. */
export interface ChatLastMessage {
    readonly authorId: string | null;
    readonly kind: string;
    /** Plain text, cut short: the row shows one line of it. Never the stored
     *  Markdown - a link read `[https://...](https://...)` in the list. Empty
     *  for a deleted message. */
    readonly body: string;
    readonly at: string;
    /** Whether the ticks may be drawn at all: the reader's own message in a
     *  one-to-one whose two sides allow read receipts, or in a group that has
     *  ticks (see `group-receipts.ts`). */
    readonly receipts: boolean;
    /** Stamped on the message in a one-to-one - see `ChatMessage.readAt` - and
     *  worked out from the members' marks in a group. */
    readonly delivered: boolean;
    readonly read: boolean;
    readonly deleted: boolean;
}

interface Row {
    channelId: string;
    authorId: string | null;
    kind: string;
    body: string;
    createdAt: Date;
    delivered: boolean;
    read: boolean;
    deleted: boolean;
}

/** As much of a body as one row can show, with room to spare. */
const PREVIEW_CHARS = 160;

/**
 * How much of the stored Markdown is read to make that line. More than the line
 * itself, since the marks around a link or a code block take room and a cut
 * through the middle of one would leave half of it showing as text.
 */
const SOURCE_CHARS = 2000;

/**
 * The last message of each conversation, in one round trip.
 *
 * One lateral lookup per id, each answered from the
 * `(channelId, parentId, createdAt)` index with a single row, so the cost is
 * bounded by the conversations already being listed and not by how much was
 * ever said in them. Thread replies are left out: they are not what the
 * conversation last said.
 *
 * Every number handed to a function is cast: Prisma binds a JS number as a
 * bigint, and `left(text, bigint)` does not exist, so an uncast length failed
 * the whole read and every row in the list drew with nothing under its name.
 */
export async function lastMessages(
    channelIds: readonly string[]
): Promise<Map<string, ChatLastMessage>> {
    if (channelIds.length === 0) return new Map();
    const rows = await prisma.$queryRaw<Row[]>`
        SELECT c.id::text AS "channelId", m."authorId"::text AS "authorId", m.kind,
               CASE WHEN m."deletedAt" IS NULL THEN left(m.body, ${SOURCE_CHARS}::int) ELSE '' END AS body,
               m."createdAt", m."deliveredAt" IS NOT NULL AS delivered,
               m."readAt" IS NOT NULL AS read, m."deletedAt" IS NOT NULL AS deleted
        FROM unnest(${[...channelIds]}::uuid[]) AS c(id)
        CROSS JOIN LATERAL (
            SELECT "authorId", kind, body, "createdAt", "deliveredAt", "readAt", "deletedAt"
            FROM "ChatMessage"
            WHERE "channelId" = c.id AND "parentId" IS NULL
            ORDER BY "createdAt" DESC
            LIMIT 1
        ) m`;
    return new Map(
        rows.map((row) => [
            row.channelId,
            {
                authorId: row.authorId,
                kind: row.kind,
                body: row.deleted ? "" : plainExcerpt(row.body, PREVIEW_CHARS),
                at: row.createdAt.toISOString(),
                receipts: false,
                delivered: row.delivered,
                read: row.read,
                deleted: row.deleted
            }
        ])
    );
}

/**
 * The same message with its ticks allowed or withheld; withheld also clears
 * them, so nothing on the wire says what the screen may not.
 *
 * `true` keeps the marks stamped on the message, which is a one-to-one. A tick
 * replaces them: a group's, worked out from its members' read marks.
 */
export function withReceipt(
    last: ChatLastMessage | null,
    allowed: boolean | MessageReceipt
): ChatLastMessage | null {
    if (!last) return null;
    if (allowed === true) return { ...last, receipts: true };
    if (allowed === false) return { ...last, receipts: false, delivered: false, read: false };
    return { ...last, receipts: true, delivered: allowed !== "sent", read: allowed === "read" };
}
