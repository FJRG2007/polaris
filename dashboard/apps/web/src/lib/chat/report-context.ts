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
import { channelAccess, ChatRuleError, type ChatActor } from "./access";
import * as sealedReport from "./e2ee/sealed-report";

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

/** The sealed fields of a message `sealedReport.openReported` checks. */
const SEALED_FIELDS = {
    channelId: true,
    clientKey: true,
    e2eeCiphertext: true,
    e2eeEpoch: true,
    e2eeSenderLeaf: true,
    e2eeSignature: true,
    e2eeSignatureKey: true,
    e2eeRevision: true
} as const;

/** The rows `recentReadable` copies, newest first; none when the actor cannot reach the conversation. */
async function recentRows(actor: ChatActor, channelId: string, authorId: string | null) {
    if (!(await channelAccess(actor, channelId))) return [];
    const floor = await history.readableSince(actor, channelId);
    return prisma.chatMessage.findMany({
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
        select: { id: true, authorId: true, authorLabel: true, body: true, createdAt: true, ...SEALED_FIELDS }
    });
}

/**
 * The sealed ones among the messages a report would carry, by id: the
 * reporter's browser hands over each one's own key (`messageDisclosure`) so
 * the moderators read their words (docs/chat-e2ee-mls.md, "Sealed reports").
 */
export async function recentSealed(actor: ChatActor, channelId: string, authorId: string | null = null): Promise<string[]> {
    return (await recentRows(actor, channelId, authorId)).filter(sealedReport.isSealedRow).map((row) => row.id);
}

/**
 * The last messages in a conversation the actor can read, oldest first,
 * optionally only one person's. Empty when the actor cannot reach the
 * conversation, so a report can never carry what its reporter could not see.
 *
 * A sealed one carries its words only when `disclosures` holds its key, and
 * then only once its sender's signature checks and the key opens it; without
 * one it goes with no words, and a key that does not open it refuses the
 * report (`errors.reportSealedUnreadable`) rather than file words nobody said.
 */
export async function recentReadable(
    actor: ChatActor,
    channelId: string,
    authorId: string | null = null,
    disclosures: Readonly<Record<string, string>> = {}
): Promise<ReportContextEntry[]> {
    const rows = await recentRows(actor, channelId, authorId);
    const ids = [...new Set(rows.flatMap((row) => (row.authorId ? [row.authorId] : [])))];
    const people = ids.length
        ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        : [];
    const names = new Map(people.map((person) => [person.id, person.name]));
    const said = async (row: (typeof rows)[number]): Promise<string> => {
        if (!sealedReport.isSealedRow(row)) return row.body;
        const disclosure = Object.hasOwn(disclosures, row.id) ? disclosures[row.id] : undefined;
        if (!disclosure) return "";
        const opened = await sealedReport.openReported(row, disclosure);
        if (!opened) throw new ChatRuleError({ key: "errors.reportSealedUnreadable" });
        return sealedReport.reportedText(opened);
    };
    const entries: ReportContextEntry[] = [];
    for (const row of [...rows].reverse()) {
        entries.push({
            authorId: row.authorId,
            authorName: (row.authorId ? names.get(row.authorId) : null) ?? row.authorLabel ?? "",
            excerpt: plainExcerpt(await said(row), EXCERPT),
            sentAt: row.createdAt.toISOString()
        });
    }
    return entries;
}
