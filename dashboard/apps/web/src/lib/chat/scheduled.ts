/**
 * Messages written now and sent later.
 *
 * A scheduled message is deliberately not a message. Nothing about it is in the
 * conversation, nothing counts it as unread, nobody is notified, and taking it
 * back leaves no trace - the room hears about it at the moment it is sent and
 * not a second before. That is the difference between this and a draft that
 * posts itself, and it is why the row lives in a table of its own rather than as
 * a message with a flag on it: a flag would have to be honoured by every read
 * path in the app, and the day one of them forgot, somebody's unsent message
 * would appear in a room.
 *
 * Two things are settled twice on purpose. Whether the writer may post here is
 * checked when they schedule it AND again when it goes, because the hours in
 * between are exactly when somebody is removed from a room or timed out in it -
 * and a message that lands from somebody who was shown the door is worse than
 * one that never arrives. Whether the room still exists is the same question.
 *
 * The files are written at the moment it is scheduled. They are on the machine
 * that wrote them, and a laptop closed overnight takes them with it - so the
 * bytes go to storage now and what is kept here is exactly what an attachment
 * row keeps, which makes sending the same call the live path makes.
 *
 * Server-only.
 */

import { send } from "./messages";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { removeStoredFiles, type StoredAttachment } from "./attachments";
import { ChatAccessError, requirePostable, type ChatActor } from "./access";

/** One waiting message, as the screen that lists them draws it. */
export interface ScheduledMessageView {
    readonly id: string;
    readonly channelId: string;
    readonly body: string;
    readonly sendAt: string;
    /** What it carries, named so the list can say "2 files" rather than a count
     *  of nothing in particular. */
    readonly files: readonly { readonly name: string; readonly contentType: string }[];
    /** Whether it answers something, which is why it may read oddly on its own. */
    readonly replying: boolean;
    /** Why it did not go, for one the sweep could not send. Null for everything
     *  still waiting, which is nearly all of them. */
    readonly failure: string | null;
}

function view(row: {
    id: string;
    channelId: string;
    body: string;
    sendAt: Date;
    replyToId: string | null;
    failure: string | null;
    files: { name: string; contentType: string }[];
}): ScheduledMessageView {
    return {
        id: row.id,
        channelId: row.channelId,
        body: row.body,
        sendAt: row.sendAt.toISOString(),
        files: row.files.map((file) => ({ name: file.name, contentType: file.contentType })),
        replying: row.replyToId !== null,
        failure: row.failure
    };
}

/**
 * Write one down for later.
 *
 * The files have already been stored by the caller - the route that took them -
 * so this is the row and nothing else. A refusal here is the caller's to clean
 * up after, the same way it is when a live message fails to send.
 */
export async function scheduleMessage(
    actor: ChatActor,
    input: core.ChatScheduleInput,
    attachments: readonly StoredAttachment[] = []
): Promise<string> {
    await requirePostable(actor, input.channelId);

    const sendAt = new Date(input.sendAt);
    const refusal = core.scheduleRefusal(sendAt);
    if (refusal) throw new ChatAccessError(refusal);
    if (attachments.length === 0 && !input.body.trim()) {
        throw new ChatAccessError("Write something first");
    }

    const row = await prisma.chatScheduledMessage.create({
        data: {
            channelId: input.channelId,
            authorId: actor.id,
            body: input.body,
            parentId: input.parentId ?? null,
            replyToId: input.replyToId ?? null,
            forwarded: input.forwarded,
            sendAt,
            files: {
                create: attachments.map((file) => ({
                    name: file.name,
                    size: BigInt(file.size),
                    contentType: file.contentType,
                    connectionId: file.connectionId,
                    path: file.path,
                    durationMs: file.durationMs,
                    waveform: file.waveform,
                    posterPath: file.posterPath,
                    posterConnectionId: file.posterConnectionId
                }))
            }
        },
        select: { id: true }
    });
    return row.id;
}

/**
 * What this person has waiting in this conversation.
 *
 * Theirs only, and that is not a scope decision but the whole privacy of the
 * feature: a message nobody has sent yet belongs to the person writing it, and a
 * room where anybody could read what is coming would be a room nobody schedules
 * anything in.
 */
export async function listScheduled(
    actor: ChatActor,
    channelId: string
): Promise<ScheduledMessageView[]> {
    const rows = await prisma.chatScheduledMessage.findMany({
        where: { channelId, authorId: actor.id },
        orderBy: { sendAt: "asc" },
        select: {
            id: true,
            channelId: true,
            body: true,
            sendAt: true,
            replyToId: true,
            failure: true,
            files: { select: { name: true, contentType: true } }
        }
    });
    return rows.map(view);
}

/** Everything this person has waiting, anywhere. What the rail counts. */
export async function countScheduled(actor: ChatActor): Promise<number> {
    return prisma.chatScheduledMessage.count({ where: { authorId: actor.id } });
}

/**
 * Take one back.
 *
 * The files go with it. They were written when it was scheduled, nothing else
 * points at them, and a cancelled message that left a video on a NAS is a disk
 * that only fills up.
 */
export async function cancelScheduled(actor: ChatActor, id: string): Promise<void> {
    const row = await prisma.chatScheduledMessage.findFirst({
        where: { id, authorId: actor.id },
        select: {
            id: true,
            files: {
                select: {
                    connectionId: true,
                    path: true,
                    posterPath: true,
                    posterConnectionId: true
                }
            }
        }
    });
    // Silent for one that is not theirs or is already gone: both are "there is
    // nothing waiting under that id", and telling them apart would answer
    // questions about somebody else's messages.
    if (!row) return;

    await prisma.chatScheduledMessage.delete({ where: { id: row.id } });
    await removeStoredFiles([
        ...row.files,
        // The still goes with the file it is of.
        ...row.files
            .filter((file) => file.posterPath)
            .map((file) => ({ connectionId: file.posterConnectionId, path: file.posterPath! }))
    ]);
}

/**
 * Send one now rather than at the hour it was written for.
 *
 * The half of the feature that stops it being a trap: plans change, and a person
 * who has to wait for their own message to be sent - or cancel it, retype it and
 * send it again - is a person who will not schedule the next one.
 */
export async function sendScheduledNow(actor: ChatActor, id: string): Promise<void> {
    const row = await prisma.chatScheduledMessage.findFirst({
        where: { id, authorId: actor.id },
        select: rowForSending
    });
    if (!row) throw new ChatAccessError("There is nothing waiting under that id");

    await deliver(row);
}

/** Everything sending one needs, in one shape both callers read. */
const rowForSending = {
    id: true,
    channelId: true,
    authorId: true,
    body: true,
    parentId: true,
    replyToId: true,
    forwarded: true,
    files: {
        select: {
            name: true,
            size: true,
            contentType: true,
            connectionId: true,
            path: true,
            durationMs: true,
            waveform: true,
            posterPath: true,
            posterConnectionId: true
        }
    }
} as const;

interface SendableRow {
    id: string;
    channelId: string;
    authorId: string;
    body: string;
    parentId: string | null;
    replyToId: string | null;
    forwarded: boolean;
    files: {
        name: string;
        size: bigint;
        contentType: string;
        connectionId: string | null;
        path: string;
        durationMs: number | null;
        waveform: string | null;
        posterPath: string | null;
        posterConnectionId: string | null;
    }[];
}

/**
 * Put one into the room, and take the row away.
 *
 * The row is deleted rather than marked sent, and the files are deliberately not
 * removed with it: they belong to the message now. Marking it would leave a
 * table that only grows, holding the text of every message anybody ever
 * scheduled - a second copy of the conversation, in a place nothing shows and
 * nothing deletes.
 */
async function deliver(row: SendableRow): Promise<void> {
    const attachments: StoredAttachment[] = row.files.map((file) => ({
        name: file.name,
        size: Number(file.size),
        contentType: file.contentType,
        connectionId: file.connectionId,
        path: file.path,
        durationMs: file.durationMs,
        waveform: file.waveform,
        posterPath: file.posterPath,
        posterConnectionId: file.posterConnectionId
    }));

    await send(
        { id: row.authorId },
        {
            channelId: row.channelId,
            // A message that is only a file has no body, and the schema behind
            // `send` refuses an empty one. The same space the live path uses.
            body: row.body || " ",
            parentId: row.parentId
        },
        attachments,
        row.replyToId ? { messageId: row.replyToId, forwarded: row.forwarded } : null
    );
    await prisma.chatScheduledMessage.delete({ where: { id: row.id } });
}

/**
 * How many are sent in one pass.
 *
 * A bound rather than a limit anybody meets: the sweep runs every minute, and a
 * pass that tried to send ten thousand at once would hold its lease until the
 * next one had already given up on it. Whatever is left is due at the next pass,
 * a minute later.
 */
const PER_PASS = 200;

/**
 * Send everything that has come due.
 *
 * Leased by the scheduler, because sending twice is the one thing this must not
 * do - and the row being deleted on the way out is what makes a second pass over
 * the same message impossible even if a lease is ever lost.
 *
 * A message that cannot be sent is kept and marked rather than dropped: the
 * usual reason is that its author has been timed out or taken out of the room
 * since they wrote it, and the honest outcome is that they still have their
 * words and can see why they never went. It is not retried, for the same reason
 * it is not dropped - retrying a refusal every minute for a year is not a
 * feature.
 */
export async function sweepDueScheduledMessages(): Promise<{ sent: number; failed: number }> {
    const due = await prisma.chatScheduledMessage.findMany({
        where: { sendAt: { lte: new Date() }, failedAt: null },
        orderBy: { sendAt: "asc" },
        take: PER_PASS,
        select: rowForSending
    });

    let sent = 0;
    let failed = 0;
    for (const row of due) {
        try {
            await deliver(row);
            sent += 1;
        } catch (caught) {
            failed += 1;
            const reason =
                caught instanceof ChatAccessError
                    ? caught.message
                    : "Polaris could not send this message";
            // Never the raw error: this line is drawn to whoever wrote the
            // message, and a stack or a storage path is neither theirs nor
            // useful to them. The log has the rest.
            if (!(caught instanceof ChatAccessError)) console.error("scheduled message:", caught);
            await prisma.chatScheduledMessage
                .update({
                    where: { id: row.id },
                    data: { failure: reason, failedAt: new Date() }
                })
                .catch(() => undefined);
        }
    }
    return { sent, failed };
}
