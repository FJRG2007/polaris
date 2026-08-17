/**
 * What was on the message when somebody reported it.
 *
 * Most reports are about a picture. The queue showed the text and nothing else,
 * which for the commonest kind of report meant the one thing a moderator had to
 * look at to decide anything was the one thing that was not there - a report of
 * a photograph read "No text", which is true and useless.
 *
 * **Nothing is copied.** The row written here points at the very same stored file
 * the message points at. A conversation full of pictures does not cost twice as
 * much because one of them was objected to, and an instance where a lot gets
 * reported does not quietly grow a second attachment store.
 *
 * That leaves one moment where it breaks, and it is the moment that matters: the
 * author deletes the message, and the bytes go with it - which would mean
 * anybody could delete the evidence of what they were reported for. So when a
 * message is deleted, any file a report is holding is **moved** out from under it
 * into the report's own folder and the row is rewritten to say so. Still one
 * copy. It simply belongs to the report now.
 *
 * The deletion is never blocked. Somebody taking their own words back is not a
 * thing to refuse because a stranger objected to them, and an instance set to
 * leave no trace deletes the row outright by design. What is kept is what a
 * moderator was already given: a copy of what was reported, taken at the moment
 * it was reported.
 */

import { prisma } from "@polaris/db";
import { discardEvidence, holdFile, readStored } from "./attachments";

/** One file, as the queue draws it. */
export interface ChatReportFileView {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly contentType: string;
    /** For a recording, so the report draws the same player the conversation
     *  does rather than a link with no length on it. */
    readonly durationMs: number | null;
    readonly waveform: string | null;
    /** Whether the bytes now belong to the report, which is to say whether the
     *  message has been deleted since. Drawn, because "this is the copy that was
     *  kept" is a different claim from "this is the live file". */
    readonly held: boolean;
}

/**
 * Copy the message's files onto the report.
 *
 * Called when the report is made and again when it is updated, because the
 * second press is the same report and the message may have been edited in
 * between - a picture removed, another added.
 */
export async function copyOntoReport(reportId: string, messageId: string): Promise<void> {
    const files = await prisma.chatAttachment.findMany({
        where: { messageId },
        select: {
            id: true,
            name: true,
            size: true,
            contentType: true,
            connectionId: true,
            path: true,
            durationMs: true,
            waveform: true
        },
        orderBy: { createdAt: "asc" }
    });

    const already = await prisma.chatReportFile.findMany({
        where: { reportId },
        select: { id: true, attachmentId: true, held: true }
    });
    const known = new Set(already.map((row) => row.attachmentId).filter(Boolean));

    const fresh = files.filter((file) => !known.has(file.id));
    if (fresh.length > 0) {
        await prisma.chatReportFile.createMany({
            data: fresh.map((file) => ({
                reportId,
                attachmentId: file.id,
                name: file.name,
                size: file.size,
                contentType: file.contentType,
                connectionId: file.connectionId,
                path: file.path,
                durationMs: file.durationMs,
                waveform: file.waveform
            }))
        });
    }

    // A file that was on the message when it was first reported and is not on it
    // now was taken off by an edit. Dropped, unless the bytes have already been
    // moved here - once they are the report's, they are the record.
    const live = new Set(files.map((file) => file.id));
    const stale = already.filter(
        (row) => !row.held && (!row.attachmentId || !live.has(row.attachmentId))
    );
    if (stale.length > 0) {
        await prisma.chatReportFile.deleteMany({
            where: { id: { in: stale.map((row) => row.id) } }
        });
    }
}

/**
 * Rescue the files any report is holding, before the message loses them.
 *
 * Called with the attachments about to be deleted. Almost always finds nothing -
 * a reported message is a rare message - so it is one indexed lookup on the way
 * out of an ordinary delete.
 *
 * A file no report holds is left alone entirely, which is what keeps this from
 * being a second copy of every attachment in the instance.
 */
export async function keepForReports(attachmentIds: readonly string[]): Promise<void> {
    if (attachmentIds.length === 0) return;

    const held = await prisma.chatReportFile.findMany({
        where: { attachmentId: { in: [...attachmentIds] }, held: false },
        select: { id: true, reportId: true, connectionId: true, path: true }
    });
    if (held.length === 0) return;

    for (const row of held) {
        const moved = await holdFile(
            { connectionId: row.connectionId, path: row.path },
            row.reportId,
            row.id
        );
        // Left alone when it could not be moved: a row still pointing at the
        // file is a row that at least says what was there, and one pointing at
        // an address nothing was ever written to is worse.
        if (!moved) continue;
        await prisma.chatReportFile.update({
            where: { id: row.id },
            data: { connectionId: moved.connectionId, path: moved.path, held: true, attachmentId: null }
        });
    }
}

/** The same, for every file in a conversation that is being deleted whole. */
export async function keepChannelForReports(channelIds: readonly string[]): Promise<void> {
    const channels = [...new Set(channelIds)];
    if (channels.length === 0) return;

    const files = await prisma.chatAttachment.findMany({
        where: { message: { channelId: { in: channels } } },
        select: { id: true }
    });
    await keepForReports(files.map((file) => file.id));
}

/** What the queue draws for one report. */
export async function reportFiles(reportIds: readonly string[]): Promise<
    Map<string, ChatReportFileView[]>
> {
    if (reportIds.length === 0) return new Map();
    const rows = await prisma.chatReportFile.findMany({
        where: { reportId: { in: [...reportIds] } },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            reportId: true,
            name: true,
            size: true,
            contentType: true,
            durationMs: true,
            waveform: true,
            held: true
        }
    });

    const byReport = new Map<string, ChatReportFileView[]>();
    for (const row of rows) {
        const view: ChatReportFileView = {
            id: row.id,
            name: row.name,
            // Narrowed on the way out, the way every other file size in Polaris
            // is: a chat attachment is capped well inside what a number holds,
            // and the column is wide because the column it was copied from is.
            size: Number(row.size),
            contentType: row.contentType,
            durationMs: row.durationMs,
            waveform: row.waveform,
            held: row.held
        };
        byReport.set(row.reportId, [...(byReport.get(row.reportId) ?? []), view]);
    }
    return byReport;
}

/**
 * Read one back, for the moderator looking at it.
 *
 * Its own path rather than the attachment route, and not as a convenience: that
 * route asks whether the reader can reach the conversation, and an administrator
 * answering a report about a private conversation cannot - correctly, because
 * being an administrator is not being in somebody's direct messages. What they
 * can see is what was handed to them, which is this row, and the gate on it is
 * the same one that opens the queue.
 *
 * Addressed by report and file together so an id on its own reaches nothing.
 */
export async function readReportFile(
    reportId: string,
    fileId: string
): Promise<{ name: string; contentType: string; bytes: Uint8Array } | null> {
    const row = await prisma.chatReportFile.findFirst({
        where: { id: fileId, reportId },
        select: { name: true, contentType: true, connectionId: true, path: true }
    });
    if (!row) return null;

    const bytes = await readStored(row.connectionId, row.path, `reported file ${fileId}`);
    return bytes ? { name: row.name, contentType: row.contentType, bytes } : null;
}

/**
 * Let go of what a report was keeping.
 *
 * Only the files it moved: a report whose message is still there is holding
 * nothing of its own, and deleting the file would take it off the message.
 */
export async function releaseEvidence(reportIds: readonly string[]): Promise<void> {
    const holding = await prisma.chatReportFile.findMany({
        where: { reportId: { in: [...reportIds] }, held: true },
        select: { reportId: true },
        distinct: ["reportId"]
    });
    await discardEvidence(holding.map((row) => row.reportId));
}
