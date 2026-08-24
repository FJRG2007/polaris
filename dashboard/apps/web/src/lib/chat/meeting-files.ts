/**
 * What a call stores, and how it stops storing it.
 *
 * The bytes go through the same storage targets everything else here uses, so a
 * NAS the instance already writes to is where they land - but under a root of
 * the meeting's own rather than the chat's, and that placement is the whole
 * design.
 *
 * Two reasons, and each of them is a bug avoided rather than a preference. The
 * chat's housekeeping deletes any folder under `polaris/chat` that no
 * conversation answers for, so a meeting's files kept there would be swept by
 * the sweep they have to survive. And what is written in a call goes when the
 * call goes - which wants one folder to delete rather than a walk of rows, and
 * wants that folder to hold nothing else.
 *
 * Which storage a file went to is recorded on its row, not read back from the
 * setting when it is asked for: an operator who points uploads at a NAS next
 * month must not break every file already written somewhere else.
 *
 * Clearing a call out lives here as well, rather than beside the messages, so
 * that the module the room itself calls when it ends is one nothing else imports
 * back - the rows and the bytes go together, and neither half is useful without
 * the other.
 */

import { prisma } from "@polaris/db";
import { chatTarget, readStored, removeStoredFiles } from "./attachments";
import { driverForTarget, LOCAL_TARGET, placeFile } from "@/lib/storage-target";

/** Under POLARIS_DATA_DIR, when the target is this server. Shared with the
 *  chat's, because it is the same disk and the same layout below it. */
const LOCAL_FOLDER = "chat";

/** Inside whichever storage. Beside the chat's root rather than under it, so
 *  neither one's housekeeping can reach the other's files. */
const MEETING_ROOT = "polaris/meetings";

/**
 * The most one file in a call may be.
 *
 * Lower than the chat's ceiling on purpose. A file here is a screenshot or a
 * document being handed to the room mid-conversation, it is held in memory whole
 * on the way in and on the way back out, and it is deleted within the hour -
 * anything bigger belongs in Drive with its address pasted into the call.
 */
export const MAX_MEETING_FILE_BYTES = 25 * 1024 * 1024;

/** How many files one message may carry. */
export const MAX_MEETING_FILES = 5;

/** What the browser may be asked to draw inline. Everything else is a download.
 *  The list is the formats that are images and cannot carry script, which is why
 *  SVG is not on it. */
const INLINE_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export function isMeetingImage(contentType: string): boolean {
    return INLINE_IMAGE.has((contentType.split(";")[0] ?? "").trim().toLowerCase());
}

/** Anything that is not a path segment. A meeting id is a uuid, so this only
 *  ever matters if one day it is not. */
function safe(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "");
}

/** One file, as it was written. */
export interface StoredMeetingFile {
    readonly name: string;
    readonly size: number;
    readonly contentType: string;
    readonly connectionId: string | null;
    readonly path: string;
}

/**
 * Write one file for a meeting and say where it went.
 *
 * The stored name is generated rather than taken from the upload: a name from
 * outside is a path traversal waiting to happen, and two people sending
 * `screenshot.png` must not collide. What they called it is kept on the row and
 * is what a download is served as.
 */
export async function storeMeetingFile(
    meetingId: string,
    file: { name: string; type: string; bytes: Uint8Array }
): Promise<StoredMeetingFile> {
    if (file.bytes.length > MAX_MEETING_FILE_BYTES) throw new Error("That file is too big");

    const folder = `${MEETING_ROOT}/${safe(meetingId)}`;
    const path = `${folder}/${crypto.randomUUID()}`;
    const placed = await placeFile({
        target: await chatTarget(),
        localFolder: LOCAL_FOLDER,
        folder,
        path,
        bytes: file.bytes,
        mime: file.type || "application/octet-stream",
        what: "file"
    });

    return {
        name: file.name.slice(0, 200) || "file",
        size: file.bytes.length,
        contentType: file.type || "application/octet-stream",
        connectionId: placed.targetId === LOCAL_TARGET ? null : placed.targetId,
        path
    };
}

/** One file back out, or null when the storage no longer has it - which the
 *  caller turns into a 410 rather than a 500, because from the reader's side a
 *  swept file and an unreachable share are the same thing. */
export async function readMeetingFile(attachmentId: string): Promise<{
    bytes: Uint8Array;
    name: string;
    contentType: string;
} | null> {
    const row = await prisma.meetingAttachment.findUnique({
        where: { id: attachmentId },
        select: { name: true, contentType: true, connectionId: true, path: true }
    });
    if (!row) return null;
    const bytes = await readStored(row.connectionId, row.path, "a file in a call");
    return bytes ? { bytes, name: row.name, contentType: row.contentType } : null;
}

/** Which meeting a file belongs to, so the route can ask whether whoever is
 *  asking has a seat in it. Read from the row rather than taken from the URL:
 *  the URL is what the caller wants to be true. */
export async function meetingOfFile(attachmentId: string): Promise<string | null> {
    const row = await prisma.meetingAttachment.findUnique({
        where: { id: attachmentId },
        select: { message: { select: { meetingId: true } } }
    });
    return row?.message.meetingId ?? null;
}

/** Which storages a meeting's files were written to, as the rows still say.
 *  Asked before the rows are deleted, because the rows are the only record: a
 *  file written when the instance pointed at a NAS is on that NAS whatever the
 *  setting says today. */
export async function storagesHoldingMeetingFiles(meetingId: string): Promise<readonly string[]> {
    const stored = await prisma.meetingAttachment.findMany({
        where: { message: { meetingId } },
        select: { connectionId: true },
        distinct: ["connectionId"]
    });
    return stored.map((row) => row.connectionId ?? LOCAL_TARGET);
}

/**
 * Everything a meeting ever stored, gone with the meeting.
 *
 * One recursive delete per storage rather than a walk of the rows: the files are
 * all in one folder named after the meeting, so this costs the same whether it
 * held two files or two hundred. The storages come from the caller because it
 * asked while the rows were still there; the current target is added here, so a
 * folder left behind by a write that failed goes with the rest.
 *
 * Never throws. It runs while a call is ending, and a call that failed to end
 * because a share was unreachable would leave everybody in a room that is over.
 */
export async function discardMeetingFiles(
    meetingId: string,
    wroteTo: readonly string[] = []
): Promise<void> {
    try {
        const targets = new Set(wroteTo);
        targets.add((await chatTarget()).id);

        await Promise.all(
            [...targets].map(async (target) => {
                const driver = await driverForTarget(target, LOCAL_FOLDER).catch(() => null);
                if (!driver) return;
                try {
                    await driver
                        .delete(`${MEETING_ROOT}/${safe(meetingId)}`, { recursive: true })
                        .catch(() => undefined);
                } finally {
                    await driver.dispose().catch(() => undefined);
                }
            })
        );
    } catch (error) {
        console.error("polaris: could not remove the files from a call that ended:", error);
    }
}

/** The files on one message, gone. For the narrow case of a send that wrote its
 *  bytes and then could not write the row - an orphan on a NAS is somebody's
 *  disk quietly filling up. */
export async function dropStoredFiles(
    files: readonly { connectionId: string | null; path: string }[]
): Promise<void> {
    await removeStoredFiles(files).catch(() => undefined);
}

/**
 * Everything said in a call, gone with the call.
 *
 * A meeting is never deleted - it is marked ended, and every join after that is
 * refused - so nothing was taking the messages with it. They sat in the database
 * for good, unreachable from every screen in Polaris and readable by anybody who
 * could read the database, which is the opposite of what the room promised the
 * people in it.
 *
 * The rows go first and the bytes after: the rows are what says where the bytes
 * are, and a storage that will not answer must not leave the messages standing.
 * Cascades take the attachment rows, the poll and its votes with the message.
 */
export async function discardMeetingChat(meetingId: string): Promise<void> {
    const wroteTo = await storagesHoldingMeetingFiles(meetingId);
    await prisma.meetingMessage.deleteMany({ where: { meetingId } });
    if (wroteTo.length > 0) await discardMeetingFiles(meetingId, wroteTo);
}
