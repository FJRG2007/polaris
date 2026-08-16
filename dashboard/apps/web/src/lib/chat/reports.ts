/**
 * Reporting something said in a chat, and the queue that answers for it.
 *
 * Two rules decide the shape of this.
 *
 * Reporting is not a permission. Anybody who can see a message can report it -
 * there is nothing to grant, and a report that had to be unlocked is a report
 * nobody makes. What is checked is that the reader can reach the conversation at
 * all, which is the same check that let them read the message in the first
 * place; without it this would be a way to ask "does this id exist" one message
 * at a time.
 *
 * Settling one is. The queue is the instance's, and so is the decision, because
 * a report is about something a moderator may have to delete out of a room they
 * are not in. Nothing here is per-space: a space admin moderating their own
 * space is a different feature, and building it as a special case of this one
 * would put the instance's queue in front of somebody who only runs a room.
 *
 * What is copied onto the report - who wrote it and the first of what it said -
 * is the queue's whole reading surface. A moderator should not have to walk into
 * six private conversations to triage six rows, and an instance set to leave no
 * trace deletes the message outright, which would otherwise leave a record of
 * nothing.
 */

import { remove } from "./messages";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import { ChatAccessError, requireChannel, type ChatActor } from "./access";

/** How much of a message is copied onto the report. Enough to triage without
 *  opening the conversation, short of copying the conversation. */
const EXCERPT = 300;

/** One row of the queue. */
export interface ChatReportView {
    readonly id: string;
    readonly reason: core.ChatReportReason;
    readonly note: string;
    readonly status: core.ChatReportStatus;
    readonly createdAt: string;
    readonly handledAt: string | null;
    readonly handledByName: string | null;
    readonly reporterName: string;
    /** Who wrote what was reported, when they still have an account. */
    readonly authorName: string | null;
    readonly excerpt: string;
    /** Null once the message is gone - deleted by its author, by a moderator, or
     *  by an instance that leaves no trace. */
    readonly messageId: string | null;
    readonly channelId: string;
    readonly channelName: string;
    /** Whether the message is still there to be read or removed. */
    readonly live: boolean;
}

/**
 * Report a message.
 *
 * Idempotent per person: pressing it twice is the same report, updated - the
 * alternative is a queue where one annoyed reader is ten rows.
 */
export async function reportMessage(
    actor: ChatActor,
    input: core.ChatReportInput
): Promise<{ already: boolean }> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { id: true, channelId: true, authorId: true, body: true, deletedAt: true }
    });
    if (!message || message.deletedAt) throw new ChatAccessError("That message is not there");
    // The same check that let them read it. Without this, an id somebody
    // guessed would be answered with "reported" or "not there", which is a way
    // to walk the message table one press at a time.
    await requireChannel(actor, message.channelId);

    const existing = await prisma.chatReport.findUnique({
        where: { messageId_reporterId: { messageId: message.id, reporterId: actor.id } },
        select: { id: true }
    });

    const shape = {
        reason: input.reason,
        note: input.note,
        // Taken now rather than read later: an instance that leaves no trace
        // deletes the row, and the queue would be left with an id and nothing to
        // decide about.
        authorId: message.authorId,
        excerpt: plainExcerpt(message.body, EXCERPT)
    };

    if (existing) {
        await prisma.chatReport.update({ where: { id: existing.id }, data: shape });
        return { already: true };
    }

    await prisma.chatReport.create({
        data: {
            messageId: message.id,
            channelId: message.channelId,
            reporterId: actor.id,
            ...shape
        }
    });
    return { already: false };
}

/**
 * The queue, newest first.
 *
 * Open by default, because a moderator arriving here is arriving to do the ones
 * nobody has answered for. The settled ones are a record and are asked for.
 */
export async function listReports(status: core.ChatReportStatus | "all"): Promise<ChatReportView[]> {
    const rows = await prisma.chatReport.findMany({
        where: status === "all" ? {} : { status },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: {
            id: true,
            reason: true,
            note: true,
            status: true,
            excerpt: true,
            authorId: true,
            messageId: true,
            channelId: true,
            createdAt: true,
            handledAt: true,
            reporter: { select: { name: true } },
            handledBy: { select: { name: true } },
            message: { select: { deletedAt: true } }
        }
    });
    if (rows.length === 0) return [];

    // Two lookups for the whole page rather than a join per row: the author is
    // an id without a foreign key - a message outlives the account that wrote it
    // - and the channel name is what tells a moderator where this happened.
    const [authors, channels] = await Promise.all([
        prisma.user.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.authorId).filter(Boolean))] as string[] } },
            select: { id: true, name: true }
        }),
        prisma.chatChannel.findMany({
            where: { id: { in: [...new Set(rows.map((row) => row.channelId))] } },
            select: { id: true, name: true, spaceId: true }
        })
    ]);
    const named = new Map(authors.map((user) => [user.id, user.name]));
    const where = new Map(channels.map((channel) => [channel.id, channel]));

    return rows.map((row) => {
        const channel = where.get(row.channelId);
        return {
            id: row.id,
            reason: row.reason as core.ChatReportReason,
            note: row.note,
            status: row.status as core.ChatReportStatus,
            createdAt: row.createdAt.toISOString(),
            handledAt: row.handledAt?.toISOString() ?? null,
            handledByName: row.handledBy?.name ?? null,
            reporterName: row.reporter.name,
            authorName: row.authorId ? (named.get(row.authorId) ?? null) : null,
            excerpt: row.excerpt,
            messageId: row.messageId,
            channelId: row.channelId,
            // A direct message has no name of its own, and naming the people in
            // it here would put a roster in a moderation queue.
            channelName: channel
                ? channel.spaceId
                    ? `#${channel.name}`
                    : "A private conversation"
                : "A conversation that is gone",
            live: row.messageId !== null && row.message?.deletedAt === null
        };
    });
}

/** How many are waiting, for the badge beside the link. */
export function openReportCount(): Promise<number> {
    return prisma.chatReport.count({ where: { status: "open" } });
}

/**
 * Settle one.
 *
 * `removed` deletes the message through the ordinary path - the same one a
 * moderator uses inside the conversation, so the instance's "leave a trace"
 * setting decides what is left behind and the attachments go with it where it
 * says no trace. A moderator is not made a member of the conversation to do it:
 * this runs as the instance, which is what an instance-wide queue means.
 */
export async function settleReport(
    admin: { id: string },
    reportId: string,
    decision: "kept" | "removed"
): Promise<void> {
    const report = await prisma.chatReport.findUnique({
        where: { id: reportId },
        select: { id: true, messageId: true, status: true }
    });
    if (!report) throw new ChatAccessError("That report is not there");

    if (decision === "removed" && report.messageId) {
        // As the instance rather than as a member: `remove` takes the author or
        // somebody who administers the channel, and a moderator answering the
        // queue is neither. What makes that safe is the gate on this function -
        // it is the administrator check, and it is the only one there is.
        await removeAsInstance(report.messageId);
    }

    await prisma.chatReport.update({
        where: { id: report.id },
        data: { status: decision, handledById: admin.id, handledAt: new Date() }
    });
}

/**
 * Delete a message on the instance's authority.
 *
 * `remove` asks the conversation whether this account may - which is the right
 * question everywhere except here, where the answer is "an administrator said
 * so". So it is called as the message's own author, the one identity that check
 * always accepts, and the authority that actually matters was proved before this
 * was reached.
 *
 * Deleting rather than hiding, and through that path rather than a direct write,
 * so the instance's "leave a trace" setting decides what is left behind and the
 * attachments go with it where it says none.
 */
async function removeAsInstance(messageId: string): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { authorId: true }
    });
    if (!message) return;
    // A system message has no author to borrow, and is not something anybody
    // reports for what it says.
    if (!message.authorId) return;
    await remove({ id: message.authorId }, messageId, { asModerator: true });
}
