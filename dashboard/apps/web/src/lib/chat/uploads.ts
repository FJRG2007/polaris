/**
 * A file on its way into a conversation, before there is a message to put it on.
 *
 * Sending a file used to be one request: the message and its bytes together,
 * which meant the whole file was held in this process's memory while it was read
 * out of the form. That is the reason the per-file limit could not be raised past
 * a hundred megabytes - not a policy about what a conversation is for, but what
 * one request could be allowed to cost the server. An instance with a NAS behind
 * it could hold the file perfectly well; the dashboard in front of it could not.
 *
 * So a file goes to the storage first, streamed, under a request of its own, and
 * the message that follows names what was written. Nothing is held: the bytes go
 * from the socket to the storage driver, and what this module keeps is a row
 * saying where they landed.
 *
 * Three things follow, and they are the whole of what is here:
 *
 * - **What was written is not what the sender said.** The path is Polaris's own,
 *   the size is what the storage measured, and the type is only ever what the
 *   route that serves it is allowed to declare. A client that names its own file
 *   size is a client that can understate one.
 * - **A staged file belongs to one person and one conversation.** It is claimed
 *   by the message that carries it, once, and a claim that does not match both is
 *   refused - otherwise an id is a way to put somebody else's upload on your own
 *   message.
 * - **Nobody has to finish sending.** Somebody who drops a file in and closes the
 *   tab leaves bytes nothing points at, so an upload nobody claimed is swept, and
 *   taking a file back off in the composer deletes it there and then.
 */

import { prisma } from "@polaris/db";
import { chatTarget, type StoredAttachment } from "./attachments";
import { driverForTarget, LOCAL_TARGET, streamFile } from "@/lib/storage-target";

/** Under POLARIS_DATA_DIR, when the storage is this server. The same folder the
 *  finished attachments use: a staged file is already where it will stay, and
 *  claiming it moves no bytes. */
const LOCAL_FOLDER = "chat";

/** Inside whichever storage. The same root a sent file lives under, and under the
 *  conversation's own folder, so deleting a conversation takes its half-finished
 *  uploads with it. */
const ATTACHMENT_ROOT = "polaris/chat";

/**
 * How long a file nobody sent is kept.
 *
 * Long enough to survive what actually happens to a half-written message - a
 * closed laptop, a reload, a browser that dropped the connection and was opened
 * again an hour later - and short enough that an abandoned upload is not paying
 * for disk next week.
 */
export const UPLOAD_TTL_MS = 12 * 60 * 60 * 1000;

/** A staged file, as the composer needs it back. */
export interface StagedUpload {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly contentType: string;
}

/**
 * An upload that cannot become an attachment.
 *
 * Its own error because the sentence matters: a message that names an upload
 * nobody staged is not a storage failure and not an internal one, and whoever
 * pressed send has a file still in front of them.
 */
export class UploadRefused extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UploadRefused";
    }
}

/** An id from a request is a uuid or it is nothing: refused outright rather than
 *  scrubbed into a path, because a scrubbed id is a folder somebody else's
 *  conversation also scrubs to. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the sender called it, reduced to something a row can hold and a reader
 *  can see. Never used as a path. */
function readableName(name: string): string {
    return (
        name
            .replace(/[\r\n\t]/g, " ")
            .slice(0, 200)
            .trim() || "file"
    );
}

/**
 * Write one file to the storage and record where it went.
 *
 * The body is a stream and is never collected: what bounds it is the cap the
 * caller wrapped it in - see `cappedStream` - and the request itself.
 */
export async function stageUpload(input: {
    readonly userId: string;
    readonly channelId: string;
    readonly name: string;
    readonly contentType: string;
    readonly spoiler: boolean;
    readonly body: ReadableStream<Uint8Array>;
    /** What the sender said it weighs. Passed to the storage for the drivers that
     *  need a length before the first chunk; never recorded. */
    readonly declared?: number;
}): Promise<StagedUpload> {
    const folder = `${ATTACHMENT_ROOT}/${safeSegment(input.channelId)}`;
    const path = `${folder}/${crypto.randomUUID()}`;
    const contentType = input.contentType || "application/octet-stream";

    const placed = await streamFile({
        target: await chatTarget(),
        localFolder: LOCAL_FOLDER,
        folder,
        path,
        body: input.body,
        mime: contentType,
        declared: input.declared,
        what: "file"
    });

    const row = await prisma.chatUpload.create({
        data: {
            userId: input.userId,
            channelId: input.channelId,
            name: readableName(input.name),
            contentType,
            size: BigInt(placed.size),
            connectionId: placed.targetId === LOCAL_TARGET ? null : placed.targetId,
            path,
            spoiler: input.spoiler
        },
        select: { id: true, name: true, size: true, contentType: true }
    });

    return {
        id: row.id,
        name: row.name,
        size: Number(row.size),
        contentType: row.contentType
    };
}

/**
 * Turn staged files into the attachments a message carries, in the order asked
 * for.
 *
 * The rows go: what they described is now the message's, and a second send naming
 * the same upload has nothing to claim. The bytes are left exactly where they
 * are, which is the point of staging them there.
 *
 * Refuses the whole list rather than quietly sending some of it. A message that
 * arrived with three of its four files, and nothing said about the fourth, is
 * worse than a message that did not send: the sender reads the three and believes
 * the fourth went.
 */
export async function claimUploads(
    userId: string,
    channelId: string,
    ids: readonly string[],
    extra?: readonly (SoundAndStill | undefined)[]
): Promise<StoredAttachment[]> {
    if (ids.length === 0) return [];
    for (const id of ids) {
        if (!UUID.test(id)) throw new UploadRefused("One of those files is no longer here");
    }
    const rows = await prisma.chatUpload.findMany({
        where: { id: { in: [...ids] }, userId, channelId }
    });
    if (rows.length !== new Set(ids).size) {
        // Either it was never staged here, it belongs to somebody else, it was
        // staged into another conversation, or the sweep has already taken it.
        throw new UploadRefused("One of those files is no longer here");
    }
    const found = new Map(rows.map((row) => [row.id, row]));

    await prisma.chatUpload.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });

    return ids.map((id, at) => {
        const row = found.get(id)!;
        const beside = extra?.[at];
        return {
            name: row.name,
            size: Number(row.size),
            contentType: row.contentType,
            connectionId: row.connectionId,
            path: row.path,
            posterPath: beside?.posterPath ?? null,
            posterConnectionId: beside?.posterConnectionId ?? null,
            borrowed: false,
            spoiler: row.spoiler,
            durationMs: beside?.durationMs ?? null,
            waveform: beside?.waveform ?? null
        };
    });
}

/** What the message request knows about a staged file that the upload itself did
 *  not: how long it plays for, what the sound looks like, and the still the
 *  browser took from it. All of them ride the message because all of them are
 *  small, and none of them is worth a second upload. */
export interface SoundAndStill {
    readonly durationMs?: number | null;
    readonly waveform?: string | null;
    readonly posterPath?: string | null;
    readonly posterConnectionId?: string | null;
}

/**
 * Take a staged file back off, bytes and all.
 *
 * What the X beside a file in the composer does. Without it, changing your mind
 * leaves the upload for the sweep, and somebody who picked the wrong file has
 * paid for it twice - once to send and once to store for half a day.
 */
export async function discardUpload(userId: string, id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const row = await prisma.chatUpload.findFirst({ where: { id, userId } });
    if (!row) return false;
    await prisma.chatUpload.delete({ where: { id: row.id } });
    await removeBytes(row.connectionId, row.path);
    return true;
}

/**
 * Sweep the files nobody sent.
 *
 * Rows first, bytes second: a row without its file draws a message nobody can
 * open, and bytes without a row are invisible to everything - so the harmless
 * order is the one that can only leak disk, and the sweep runs again tomorrow.
 */
export async function sweepUploads(
    olderThanMs: number = UPLOAD_TTL_MS
): Promise<{ swept: number }> {
    const before = new Date(Date.now() - olderThanMs);
    const stale = await prisma.chatUpload.findMany({
        where: { createdAt: { lt: before } },
        select: { id: true, connectionId: true, path: true }
    });
    if (stale.length === 0) return { swept: 0 };

    await prisma.chatUpload.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    for (const row of stale) await removeBytes(row.connectionId, row.path);
    return { swept: stale.length };
}

/** One staged file's bytes, best effort: it is already unreferenced, and a
 *  storage that is not answering right now is not a reason to keep the row. */
async function removeBytes(connectionId: string | null, path: string): Promise<void> {
    const driver = await driverForTarget(connectionId ?? LOCAL_TARGET, LOCAL_FOLDER).catch(
        () => null
    );
    if (!driver) return;
    try {
        await driver.delete(path);
    } catch {
        // Already gone, or unreachable. Either way there is nothing further here.
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}

/**
 * The conversation's folder, spelled exactly as a sent file spells it.
 *
 * The same `polaris/chat/<channel>` an attachment lands in, deliberately: a
 * staged file is already where it will live once it is claimed, so claiming it
 * moves no bytes - and deleting a conversation, which removes that folder whole,
 * takes its half-finished uploads with it instead of leaving them for the sweep.
 */
function safeSegment(channelId: string): string {
    if (!UUID.test(channelId)) throw new UploadRefused("That conversation is not one of ours");
    return channelId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
}
