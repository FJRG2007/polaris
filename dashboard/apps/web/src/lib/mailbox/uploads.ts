/**
 * Files somebody attaches while writing.
 *
 * They go through the same storage targets everything else in Polaris writes
 * through, so an instance with a NAS puts them on it without this module knowing
 * a NAS exists. Which storage a file went to is recorded on its row rather than
 * read back from the setting, because pointing mail at a NAS next month must not
 * break every draft already written somewhere else.
 *
 * They are owned by the person rather than by the draft, because the upload
 * happens before there is a draft to hang it on - somebody drops a file into an
 * empty composer. One that never reaches a draft is swept.
 */

import { prisma } from "@polaris/db";
import { MAIL_MAX_ARCHIVE_BYTES, MAIL_MAX_ATTACHMENT_BYTES } from "@polaris/core";
import {
    LOCAL_TARGET,
    placeFile,
    driverForTarget,
    resolveStorageTarget
} from "@/lib/storage-target";

/** Where an operator points mail attachments. Absent is "work it out". */
export const MAIL_TARGET_KEY = "mail.attachments.target";

/** Under POLARIS_DATA_DIR, when the target is this server. */
const LOCAL_FOLDER = "mail";

/** Inside whichever storage, so a shared NAS stays legible from a file browser. */
const UPLOAD_ROOT = "polaris/mail";

/** The ceiling, from the shared schema, so the composer states the same number
 *  this enforces. */
export const MAX_ATTACHMENT_BYTES = MAIL_MAX_ATTACHMENT_BYTES;

/** The other ceiling: an archive being imported is not going anywhere near a
 *  mail server as one file, so what an attachment may be says nothing about it.
 *  See `MAIL_MAX_ARCHIVE_BYTES`. */
export const MAX_ARCHIVE_BYTES = MAIL_MAX_ARCHIVE_BYTES;

/** How long an upload nobody attached to a draft is kept before it is swept. */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

/** One file, as it was stored. */
/** What an upload is for. An archive is read by the importer and can never be
 *  attached to a message; an attachment is the other way round. The two have
 *  ceilings an order of magnitude apart, which is why this is a column rather
 *  than something the request that reads it back gets to say. */
export type UploadKind = "attachment" | "archive";

export interface StoredUpload {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly contentType: string;
    readonly inline: boolean;
    readonly contentId: string;
}

function safeName(name: string): string {
    return (
        name
            .replace(/[\r\n\t]/g, " ")
            .slice(0, 200)
            .trim() || "file"
    );
}

/**
 * Write one file and record it against its owner.
 *
 * The stored path is generated rather than taken from the upload: a name from
 * outside is a path traversal waiting to happen, and two people attaching
 * `invoice.pdf` must not collide. What they called it is kept on the row and is
 * what the recipient sees.
 */
export async function storeUpload(
    userId: string,
    file: { name: string; type: string; bytes: Uint8Array },
    options: { inline?: boolean; kind?: UploadKind } = {}
): Promise<StoredUpload> {
    // The ceiling follows the kind rather than being passed in beside it. They
    // were two arguments that had to agree, and the one place they did not was
    // the request deciding which ceiling applied to a file it then attached to a
    // message - the attachment limit, gone round.
    const kind: UploadKind = options.kind === "archive" ? "archive" : "attachment";
    if (file.bytes.length > (kind === "archive" ? MAX_ARCHIVE_BYTES : MAX_ATTACHMENT_BYTES)) {
        throw new Error(
            kind === "archive"
                ? "That archive is more than Polaris can read in one go."
                : "That file is bigger than most mail servers will accept."
        );
    }
    const folder = `${UPLOAD_ROOT}/${userId}`;
    const path = `${folder}/${crypto.randomUUID()}`;
    const placed = await placeFile({
        target: await resolveStorageTarget(MAIL_TARGET_KEY),
        localFolder: LOCAL_FOLDER,
        folder,
        path,
        bytes: file.bytes,
        mime: file.type || "application/octet-stream",
        what: "attachment"
    });

    const inline = Boolean(options.inline);
    const row = await prisma.mailUpload.create({
        data: {
            userId,
            name: safeName(file.name),
            contentType: file.type || "application/octet-stream",
            size: BigInt(file.bytes.length),
            connectionId: placed.targetId === LOCAL_TARGET ? null : placed.targetId,
            path,
            inline,
            kind,
            // A picture the body refers to needs an id the markup can name. Made
            // here rather than by the composer, so the id in the message and the
            // id on the part are the same by construction.
            contentId: inline ? `${crypto.randomUUID()}@polaris` : ""
        },
        select: {
            id: true,
            name: true,
            size: true,
            contentType: true,
            inline: true,
            contentId: true
        }
    });
    return { ...row, size: Number(row.size) };
}

/** The bytes of one upload, for putting it on a message. */
export async function readUpload(
    userId: string,
    uploadId: string
): Promise<{
    name: string;
    contentType: string;
    contentId: string;
    inline: boolean;
    bytes: Buffer;
} | null> {
    const row = await prisma.mailUpload.findFirst({
        where: { id: uploadId, userId },
        select: {
            name: true,
            contentType: true,
            contentId: true,
            inline: true,
            connectionId: true,
            path: true
        }
    });
    if (!row) return null;
    const driver = await driverForTarget(row.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER);
    const bytes = await drain(await driver.readStream(row.path));
    return {
        name: row.name,
        contentType: row.contentType,
        contentId: row.contentId,
        inline: row.inline,
        bytes
    };
}

/** A storage stream, read whole. Bounded by whichever ceiling let the file be
 *  uploaded - twenty-five megabytes for an attachment, the archive ceiling for
 *  an import - rather than by anything read here. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/** Take a file off a draft, and off the disk with it. */
export async function removeUpload(userId: string, uploadId: string): Promise<void> {
    const row = await prisma.mailUpload.findFirst({
        where: { id: uploadId, userId },
        select: { id: true, connectionId: true, path: true }
    });
    if (!row) return;
    await prisma.mailUpload.delete({ where: { id: row.id } });
    await deleteBytes(row);
}

/**
 * The bytes behind a row that has just gone, unless another row still names
 * them.
 *
 * Every upload is written to a path of its own today - a forward copies the
 * original's bytes into a new file rather than pointing at them - but the check
 * is what makes that a fact this code relies on rather than an assumption: a
 * file another message or draft still lists is never deleted from under it.
 *
 * The row going is what matters; a file left behind is found by the storage
 * sweep. Failing the delete because a NAS is briefly down would leave the
 * attachment on screen after somebody removed it.
 */
async function deleteBytes(row: { connectionId: string | null; path: string; }): Promise<void> {
    try {
        const still = await prisma.mailUpload.count({
            where: { path: row.path, connectionId: row.connectionId }
        });
        if (still > 0) return;
        const driver = await driverForTarget(row.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER);
        await driver.delete(row.path, { recursive: false });
    } catch {
        /* swept later */
    }
}

/** The files on one draft, for a composer reopening it. */
export async function listDraftUploads(userId: string, draftId: string): Promise<StoredUpload[]> {
    const rows = await prisma.mailUpload.findMany({
        where: { userId, draftId, kind: "attachment" },
        orderBy: { createdAt: "asc" },
        select: {
            id: true,
            name: true,
            size: true,
            contentType: true,
            inline: true,
            contentId: true
        },
        take: 200
    });
    return rows.map((row) => ({ ...row, size: Number(row.size) }));
}

/**
 * Take the files off drafts that are about to be deleted.
 *
 * A draft's rows cascade with it, but a row is not the file: once the cascade
 * has run, nothing points at the bytes and nothing could ever find them again.
 * So every place that deletes a draft - sending it, discarding it, pruning one
 * nobody can reach - calls this first, while the paths can still be read. A
 * message that went keeps nothing here: what was sent is in the Sent folder on
 * the mail server, bytes and all.
 */
export async function releaseDraftUploads(draftIds: readonly string[]): Promise<number> {
    if (draftIds.length === 0) return 0;
    const rows = await prisma.mailUpload.findMany({
        where: { draftId: { in: [...draftIds] } },
        select: { id: true, connectionId: true, path: true }
    });
    if (rows.length === 0) return 0;
    await prisma.mailUpload.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    for (const row of rows) await deleteBytes(row);
    return rows.length;
}

/** Hang the files somebody uploaded onto the draft they were uploading into. */
export async function attachUploads(
    userId: string,
    draftId: string,
    uploadIds: readonly string[]
): Promise<void> {
    // `kind` is in the match, not checked after it: an archive is a file that
    // was allowed to be two hundred megabytes because nothing was ever going to
    // send it, and attaching one is how that ceiling becomes the attachment
    // ceiling.
    await prisma.mailUpload.updateMany({
        where: { userId, id: { in: [...uploadIds] }, kind: "attachment" },
        data: { draftId }
    });
    // Anything that was on this draft and is not on it now was removed in the
    // composer, so it goes with the save rather than lingering as a file the
    // next send would attach.
    const stale = await prisma.mailUpload.findMany({
        where: { userId, draftId, id: { notIn: [...uploadIds] } },
        select: { id: true }
    });
    for (const row of stale) await removeUpload(userId, row.id);
}

/**
 * Take every file attached to a mailbox's drafts off the disk.
 *
 * Deleting a mailbox deletes its drafts, and the rows for the files on them go
 * with the drafts - but a row is not the file. The bytes sit on whatever storage
 * they were written to with nothing left pointing at them. Called before the
 * mailbox row goes, which is the only moment the paths can still be read.
 */
export async function removeAccountUploads(accountId: string): Promise<number> {
    const rows = await prisma.mailUpload.findMany({
        where: { draft: { accountId } },
        select: { id: true, userId: true }
    });
    for (const row of rows) await removeUpload(row.userId, row.id);
    return rows.length;
}

/** Uploads nobody attached to anything, gone - then whatever bytes no row names
 *  at all. Run from the schedule. */
export async function sweepOrphanUploads(): Promise<number> {
    const orphans = await prisma.mailUpload.findMany({
        where: { draftId: null, createdAt: { lt: new Date(Date.now() - ORPHAN_TTL_MS) } },
        select: { id: true, userId: true },
        take: 500
    });
    for (const row of orphans) await removeUpload(row.userId, row.id);
    const loose = await sweepLooseBytes().catch((caught: unknown) => {
        console.warn("polaris: the mail attachment storage could not be swept:", caught);
        return 0;
    });
    return orphans.length + loose;
}

/** A file in the mail folder of some storage, as the sweep sees it. */
export interface StoredFile {
    readonly path: string;
    readonly modifiedAt: Date;
}

/** The one shape `storeUpload` writes: `polaris/mail/<user>/<uuid>`. */
const UPLOAD_PATH = /^polaris\/mail\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/i;

/**
 * Which files in storage no upload row names, and are old enough to be sure.
 *
 * The bytes are written before the row, so a file younger than the window may be
 * an upload whose row is a moment away: those are left alone. So is anything not
 * shaped like `polaris/mail/<user>/<id>`, which this code never wrote. Pure, so
 * what the sweep would delete can be checked without a disk.
 */
export function looseFiles(
    files: readonly StoredFile[],
    named: ReadonlySet<string>,
    now: number,
    ageMs: number = ORPHAN_TTL_MS
): string[] {
    return files
        .filter((file) => UPLOAD_PATH.test(file.path))
        .filter((file) => !named.has(file.path))
        .filter((file) => now - file.modifiedAt.getTime() > ageMs)
        .map((file) => file.path);
}

/** How many files one pass may delete, so a large backlog is worked through over
 *  several runs rather than in one that holds a NAS for minutes. */
const LOOSE_PER_RUN = 1000;

/**
 * Bytes on a storage with no row left pointing at them.
 *
 * Before drafts released their files on the way out, every sent or discarded
 * message with an attachment left its bytes behind with no row: the cascade took
 * the row and nothing took the file. This finds those on every install, existing
 * ones included, on the next run of the schedule after an update. It walks the
 * disk Polaris runs on, the storage mail is pointed at now, and every storage a
 * current upload was written to.
 */
async function sweepLooseBytes(): Promise<number> {
    const targets = new Set<string>([LOCAL_TARGET]);
    targets.add((await resolveStorageTarget(MAIL_TARGET_KEY)).id);
    const used = await prisma.mailUpload.findMany({
        where: { connectionId: { not: null } },
        distinct: ["connectionId"],
        select: { connectionId: true },
        take: 50
    });
    for (const row of used) if (row.connectionId) targets.add(row.connectionId);

    let removed = 0;
    for (const target of targets) {
        if (removed >= LOOSE_PER_RUN) break;
        const driver = await driverForTarget(target, LOCAL_FOLDER).catch(() => null);
        if (!driver) continue;
        const owners = await driver.list(UPLOAD_ROOT).catch(() => null);
        if (!owners) continue;
        for (const owner of owners.entries) {
            if (owner.kind !== "dir" || removed >= LOOSE_PER_RUN) continue;
            const listed = await driver.list(owner.path).catch(() => null);
            if (!listed) continue;
            const files = listed.entries.filter((entry) => entry.kind === "file");
            if (files.length === 0) continue;
            const rows = await prisma.mailUpload.findMany({
                where: { path: { in: files.map((file) => file.path) } },
                select: { path: true }
            });
            const loose = looseFiles(files, new Set(rows.map((row) => row.path)), Date.now());
            for (const path of loose.slice(0, LOOSE_PER_RUN - removed)) {
                // Asked again right before the delete: an upload whose row
                // landed while this pass was listing is not loose.
                if ((await prisma.mailUpload.count({ where: { path } })) > 0) continue;
                await driver.delete(path, { recursive: false }).catch(() => undefined);
                removed += 1;
            }
        }
    }
    return removed;
}
