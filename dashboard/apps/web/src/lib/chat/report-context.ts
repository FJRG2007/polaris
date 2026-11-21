/**
 * The recent messages a report of a conversation or a person carries.
 *
 * Prior art: WhatsApp attaches the last five messages from that person or group
 * when somebody reports them, so a moderator can see what happened without
 * walking into the conversation.
 *
 * Only what the reporter can read right now: the same floor Polar reads by
 * (`history.readableSince`), nothing deleted, nothing shown to one other reader
 * only, nothing in a thread. Copied when the report is made, because the queue
 * must still say what was reported after the messages are gone, and read back
 * only by the moderation queue, which only an administrator opens.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import * as history from "./history-visibility";
import { channelAccess, type ChatActor } from "./access";

/** How many messages travel with a report. */
export const REPORT_CONTEXT = 5;

/** The longest any one of them is kept. */
const EXCERPT = 500;

const contextEntrySchema = z.object({
    authorId: z.string().nullable(),
    authorName: z.string(),
    excerpt: z.string(),
    sentAt: z.string()
});

export type ReportContextEntry = z.infer<typeof contextEntrySchema>;

/** A stored list read back. Anything unreadable is nothing, never an error:
 *  the queue still draws the report. */
export function readReportContext(value: unknown): ReportContextEntry[] {
    const parsed = z.array(contextEntrySchema).max(REPORT_CONTEXT).safeParse(value);
    return parsed.success ? parsed.data : [];
}

/**
 * The last messages in a conversation the actor can read, oldest first,
 * optionally only one person's. Empty when the actor cannot reach the
 * conversation, so a report can never carry what its reporter could not see.
 */
export async function recentReadable(
    actor: ChatActor,
    channelId: string,
    authorId: string | null = null
): Promise<ReportContextEntry[]> {
    if (!(await channelAccess(actor, channelId))) return [];
    const floor = await history.readableSince(actor, channelId);
    const rows = await prisma.chatMessage.findMany({
        where: {
            channelId,
            parentId: null,
            deletedAt: null,
            kind: "text",
            audience: { isEmpty: true },
            ...(authorId ? { authorId } : {}),
            AND: [history.sinceClause(floor, actor.id)]
        },
        orderBy: { createdAt: "desc" },
        take: REPORT_CONTEXT,
        select: { authorId: true, authorLabel: true, body: true, createdAt: true }
    });
    const ids = [...new Set(rows.flatMap((row) => (row.authorId ? [row.authorId] : [])))];
    const people = ids.length
        ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        : [];
    const names = new Map(people.map((person) => [person.id, person.name]));
    return rows.reverse().map((row) => ({
        authorId: row.authorId,
        authorName: (row.authorId ? names.get(row.authorId) : null) ?? row.authorLabel ?? "",
        excerpt: plainExcerpt(row.body, EXCERPT),
        sentAt: row.createdAt.toISOString()
    }));
}
