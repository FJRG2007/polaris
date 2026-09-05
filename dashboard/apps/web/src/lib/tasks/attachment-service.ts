/**
 * Files attached to a task.
 *
 * Where they are kept is not this module's decision: `storage-target` owns the
 * choice between a NAS, another connection, and the disk Polaris runs on, and
 * profile photos make the same choice separately.
 *
 * Uploads land under one reserved folder per instance, laid out by task, so a
 * NAS owner browsing the share sees an arrangement rather than a pile of hashes.
 */

import { extname } from "node:path";
import { prisma } from "@polaris/db";
import { pipeThenDispose } from "@/lib/drive-stream";
import { getSetting, setSetting } from "@/lib/setting-store";
import {
    AUTOMATIC_TARGET,
    driverForTarget,
    LOCAL_TARGET,
    openForWriting,
    resolveStorageTarget,
    safeName,
    storageTargetOptions,
    type TargetOption,
    type UploadTarget
} from "@/lib/storage-target";

/** Where uploads go. Either a storage connection's id, or the local disk. */
export const UPLOAD_TARGET_KEY = "tasks.uploads.target";
/** The biggest single file this instance accepts, in bytes. */
export const UPLOAD_LIMIT_KEY = "tasks.uploads.maxBytes";

/** 100 MB. Big enough for the screenshots and recordings a task carries, small
 *  enough that one paste cannot fill a home NAS. Raise it in the settings. */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/** Everything under here belongs to Polaris; the folder is one level so a NAS
 *  owner can find, move or back up every upload at once. */
const UPLOAD_ROOT = "polaris/tasks";

/** The folder under POLARIS_DATA_DIR used when uploads stay on this server. */
const LOCAL_FOLDER = "uploads";

export interface UploadSettings {
    /** What is stored: a connection id, `local`, or `auto`. */
    readonly choice: string;
    /** What that currently resolves to. */
    readonly resolved: UploadTarget;
    readonly maxBytes: number;
    /** The connections an administrator can pick from. */
    readonly options: TargetOption[];
}

/** The biggest file this instance accepts. */
export async function uploadLimit(): Promise<number> {
    const stored = await getSetting(UPLOAD_LIMIT_KEY);
    const parsed = stored === null ? Number.NaN : Number(stored);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/** Where task attachments should go right now. */
export function resolveUploadTarget(): Promise<UploadTarget> {
    return resolveStorageTarget(UPLOAD_TARGET_KEY);
}

/** What the settings screen shows and edits. */
export async function uploadSettings(): Promise<UploadSettings> {
    const [choice, resolved, maxBytes, options] = await Promise.all([
        getSetting(UPLOAD_TARGET_KEY),
        resolveUploadTarget(),
        uploadLimit(),
        storageTargetOptions()
    ]);
    return { choice: choice ?? AUTOMATIC_TARGET, resolved, maxBytes, options };
}

export async function setUploadSettings(input: {
    target: string;
    maxBytes: number;
}): Promise<void> {
    await setSetting(UPLOAD_TARGET_KEY, input.target);
    await setSetting(UPLOAD_LIMIT_KEY, String(Math.max(1, Math.trunc(input.maxBytes))));
}

/** A driver onto whichever storage attachments are kept on. */
function driverFor(targetId: string) {
    return driverForTarget(targetId, LOCAL_FOLDER);
}

/** Where one task's files live under the upload root. */
function taskFolder(taskId: string): string {
    return `${UPLOAD_ROOT}/${taskId}`;
}

export interface AttachmentView {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
    readonly uploadedById: string | null;
    readonly createdAt: string;
    /** True for the kinds a browser can show inline. */
    readonly previewable: boolean;
}

function view(row: {
    id: string;
    name: string;
    mime: string;
    size: number;
    uploadedById: string | null;
    createdAt: Date;
}): AttachmentView {
    return {
        id: row.id,
        name: row.name,
        mime: row.mime,
        size: row.size,
        uploadedById: row.uploadedById,
        createdAt: row.createdAt.toISOString(),
        previewable: row.mime.startsWith("image/") || row.mime.startsWith("video/")
    };
}

export async function listAttachments(taskId: string): Promise<AttachmentView[]> {
    const rows = await prisma.taskAttachment.findMany({
        where: { taskId },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            name: true,
            mime: true,
            size: true,
            uploadedById: true,
            createdAt: true
        }
    });
    return rows.map(view);
}

/**
 * Write one file and record it.
 *
 * The row is written after the bytes land, so a failed upload leaves nothing
 * behind to explain. The reverse - a row for a file that was never written -
 * would put a permanent broken link on the task.
 */
export async function storeAttachment(input: {
    taskId: string;
    uploadedById: string;
    name: string;
    mime: string;
    size: number;
    body: ReadableStream<Uint8Array>;
    /** Set when the file was sent in the thread rather than added to the task's
     *  files. It is on both either way; this is what lets the thread draw it. */
    commentId?: string | null;
}): Promise<AttachmentView> {
    // The storage uploads are sent to, or this server when that one cannot be
    // opened. A share that is away must not be the reason somebody cannot
    // attach a file to their work; the row records where it really went.
    const target = await openForWriting(await resolveUploadTarget(), LOCAL_FOLDER);
    const driver = target.driver;
    const folder = taskFolder(input.taskId);
    // A name of its own, so two people uploading "screenshot.png" to the same
    // task do not overwrite each other, and so a name cannot escape the folder.
    const stored = `${folder}/${crypto.randomUUID()}${extname(safeName(input.name))}`;

    try {
        await driver.mkdir(folder).catch(() => undefined);
        const written = await driver.writeStream(stored, input.body, { mime: input.mime });
        const size = Number(written.size) || input.size;
        const row = await prisma.taskAttachment.create({
            data: {
                taskId: input.taskId,
                name: safeName(input.name),
                mime: input.mime,
                size,
                connectionId: target.targetId === LOCAL_TARGET ? null : target.targetId,
                path: stored,
                uploadedById: input.uploadedById,
                commentId: input.commentId ?? null
            },
            select: {
                id: true,
                name: true,
                mime: true,
                size: true,
                uploadedById: true,
                createdAt: true
            }
        });
        return view(row);
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}

/** The bytes of one attachment, for the download route. */
export async function readAttachment(
    attachmentId: string
): Promise<{ name: string; mime: string; size: number; body: ReadableStream<Uint8Array> } | null> {
    const row = await prisma.taskAttachment.findUnique({ where: { id: attachmentId } });
    if (!row) return null;
    const driver = await driverFor(row.connectionId ?? LOCAL_TARGET);
    // The stream outlives this call, so the driver comes back when the response
    // finishes rather than here; a read that never starts gives it back now.
    let body: ReadableStream<Uint8Array>;
    try {
        body = await driver.readStream(row.path);
    } catch (error) {
        await driver.dispose().catch(() => undefined);
        throw error;
    }
    return { name: row.name, mime: row.mime, size: row.size, body: pipeThenDispose(body, driver) };
}

/** The task an attachment belongs to, so the caller can authorize against it. */
export async function attachmentTaskId(attachmentId: string): Promise<string | null> {
    const row = await prisma.taskAttachment.findUnique({
        where: { id: attachmentId },
        select: { taskId: true }
    });
    return row?.taskId ?? null;
}

/**
 * Forget an attachment, and take the file with it where that is possible.
 *
 * A file the storage refuses to delete (a NAS that is away, a connection that
 * has been removed) still loses its row: leaving the task pointing at something
 * nobody can remove is worse than leaving a file behind on a disk, and the disk
 * is somewhere its owner can reach.
 */
export async function deleteAttachment(attachmentId: string): Promise<void> {
    const row = await prisma.taskAttachment.findUnique({ where: { id: attachmentId } });
    if (!row) return;
    try {
        const driver = await driverFor(row.connectionId ?? LOCAL_TARGET);
        try {
            await driver.delete(row.path);
        } finally {
            await driver.dispose().catch(() => undefined);
        }
    } catch (error) {
        console.error(`tasks: could not remove the file for attachment ${attachmentId}:`, error);
    }
    await prisma.taskAttachment.delete({ where: { id: attachmentId } });
}
