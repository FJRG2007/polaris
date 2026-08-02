/**
 * Files attached to a task, and where an instance keeps them.
 *
 * Polaris already knows how to talk to storage - a NAS over SMB, an NFS export,
 * an SFTP host - so an upload does not need a second way of writing bytes. It
 * needs a decision: which of those, or the disk Polaris itself runs on. That
 * decision is one setting, and until somebody makes it the default is the
 * obvious one: if this instance has a NAS connected, put the files on the NAS,
 * because that is the disk with the room and the backups. Otherwise keep them
 * next to Polaris's own data.
 *
 * Uploads land under one reserved folder per instance, laid out by task, so a
 * NAS owner browsing the share sees an arrangement rather than a pile of hashes.
 */

import { extname } from "node:path";
import { prisma } from "@polaris/db";
import { mkdir } from "node:fs/promises";
import { loadEnv } from "@polaris/config";
import { LocalDriver } from "@polaris/storage";
import type { StorageDriver } from "@polaris/storage";
import { getSetting, setSetting } from "@/lib/setting-store";
import { getDriverForConnection } from "@/lib/storage-service";

/** Where uploads go. Either a storage connection's id, or the local disk. */
export const UPLOAD_TARGET_KEY = "tasks.uploads.target";
/** The biggest single file this instance accepts, in bytes. */
export const UPLOAD_LIMIT_KEY = "tasks.uploads.maxBytes";

/** Chosen by nobody, so chosen by the rule below. */
export const AUTOMATIC_TARGET = "auto";
/** The disk Polaris runs on. */
export const LOCAL_TARGET = "local";

/** 100 MB. Big enough for the screenshots and recordings a task carries, small
 *  enough that one paste cannot fill a home NAS. Raise it in the settings. */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/** Everything under here belongs to Polaris; the folder is one level so a NAS
 *  owner can find, move or back up every upload at once. */
const UPLOAD_ROOT = "polaris/tasks";

/** The kinds that mean "a box built to hold files", in the order they are
 *  preferred when nobody has chosen. */
const NAS_KINDS = ["unifi-unas", "smb", "nfs"] as const;

export interface UploadTarget {
    /** A storage connection id, or `local`. */
    readonly id: string;
    readonly name: string;
    /** True when this was worked out rather than chosen. */
    readonly automatic: boolean;
}

export interface UploadSettings {
    /** What is stored: a connection id, `local`, or `auto`. */
    readonly choice: string;
    /** What that currently resolves to. */
    readonly resolved: UploadTarget;
    readonly maxBytes: number;
    /** The connections an administrator can pick from. */
    readonly options: { id: string; name: string; kind: string }[];
}

/** The biggest file this instance accepts. */
export async function uploadLimit(): Promise<number> {
    const stored = await getSetting(UPLOAD_LIMIT_KEY);
    const parsed = stored === null ? Number.NaN : Number(stored);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/**
 * Where uploads should go right now.
 *
 * The automatic answer prefers a NAS over anything else and the local disk over
 * nothing. It is re-read on each upload rather than frozen, so connecting a NAS
 * later moves new files onto it without a migration - the ones already written
 * keep the connection they were stored against, which is why every attachment
 * records its own.
 */
export async function resolveUploadTarget(): Promise<UploadTarget> {
    const choice = (await getSetting(UPLOAD_TARGET_KEY)) ?? AUTOMATIC_TARGET;
    if (choice === LOCAL_TARGET) return { id: LOCAL_TARGET, name: "This server", automatic: false };
    if (choice !== AUTOMATIC_TARGET) {
        const chosen = await prisma.storageConnection.findUnique({
            where: { id: choice },
            select: { id: true, name: true }
        });
        // A connection somebody deleted must not stop uploads; fall through to
        // the automatic rule rather than failing every attachment from now on.
        if (chosen) return { id: chosen.id, name: chosen.name, automatic: false };
    }

    const connections = await prisma.storageConnection.findMany({
        where: { kind: { in: [...NAS_KINDS] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, kind: true }
    });
    for (const kind of NAS_KINDS) {
        const match = connections.find((connection) => connection.kind === kind);
        if (match) return { id: match.id, name: match.name, automatic: true };
    }
    return { id: LOCAL_TARGET, name: "This server", automatic: true };
}

/** What the settings screen shows and edits. */
export async function uploadSettings(): Promise<UploadSettings> {
    const [choice, resolved, maxBytes, options] = await Promise.all([
        getSetting(UPLOAD_TARGET_KEY),
        resolveUploadTarget(),
        uploadLimit(),
        prisma.storageConnection.findMany({
            orderBy: { createdAt: "asc" },
            select: { id: true, name: true, kind: true }
        })
    ]);
    return { choice: choice ?? AUTOMATIC_TARGET, resolved, maxBytes, options };
}

export async function setUploadSettings(input: { target: string; maxBytes: number }): Promise<void> {
    await setSetting(UPLOAD_TARGET_KEY, input.target);
    await setSetting(UPLOAD_LIMIT_KEY, String(Math.max(1, Math.trunc(input.maxBytes))));
}

/** A driver onto whichever storage a target names. */
async function driverFor(targetId: string): Promise<StorageDriver> {
    if (targetId === LOCAL_TARGET) {
        const root = `${loadEnv().POLARIS_DATA_DIR}/uploads`;
        // The local driver refuses a root that is not there, and on a fresh
        // install it is not there until the first file is attached - so the
        // folder is made here rather than left to whoever installs Polaris.
        await mkdir(root, { recursive: true });
        const driver = new LocalDriver({ id: LOCAL_TARGET, root });
        await driver.connect();
        return driver;
    }
    return getDriverForConnection(targetId);
}

/**
 * A file name that is safe on every backend Polaris writes to.
 *
 * Windows, SMB and every archive tool disagree about what a name may contain, so
 * the stored name is reduced to the characters they all accept. The name the
 * uploader typed is kept in the database and used on the way out, so nothing a
 * person reads is affected by this.
 */
function safeName(name: string): string {
    const cleaned = name
        // An allowlist rather than a list of what to strip: the set of things
        // some filesystem objects to is open-ended, and the set that is safe
        // everywhere is short.
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^[.-]+/, "")
        .replace(/-{2,}/g, "-");
    return cleaned.slice(0, 120) || "file";
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
        select: { id: true, name: true, mime: true, size: true, uploadedById: true, createdAt: true }
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
}): Promise<AttachmentView> {
    const target = await resolveUploadTarget();
    const driver = await driverFor(target.id);
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
                connectionId: target.id === LOCAL_TARGET ? null : target.id,
                path: stored,
                uploadedById: input.uploadedById
            },
            select: { id: true, name: true, mime: true, size: true, uploadedById: true, createdAt: true }
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
    // The stream outlives this call, so the driver is disposed by whoever
    // finishes reading it rather than here.
    const body = await driver.readStream(row.path);
    return { name: row.name, mime: row.mime, size: row.size, body };
}

/** The task an attachment belongs to, so the caller can authorize against it. */
export async function attachmentTaskId(attachmentId: string): Promise<string | null> {
    const row = await prisma.taskAttachment.findUnique({ where: { id: attachmentId }, select: { taskId: true } });
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
