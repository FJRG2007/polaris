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
    // The row going is what matters; a file left behind is swept. Failing the
    // delete because a NAS is briefly down would leave the attachment on screen
    // after somebody removed it.
    try {
        const driver = await driverForTarget(row.connectionId ?? LOCAL_TARGET, LOCAL_FOLDER);
        await driver.delete(row.path, { recursive: false });
    } catch {
        /* swept later */
    }
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

/** Uploads nobody attached to anything, gone. Run from the schedule. */
/**
 * Take every file attached to a mailbox's drafts off the disk.
 *
 * Deleting a mailbox deletes its drafts, and the rows for the files on them go
 * with the drafts - but a row is not the file. The bytes sit on whatever storage
 * they were written to with nothing left pointing at them: the sweep below only
 * knows about uploads whose ROW is still here, so once the cascade has run there
 * is nothing that could ever find them again.
 *
 * Called before the mailbox row goes, which is the only moment the paths can
 * still be read.
 */
export async function removeAccountUploads(accountId: string): Promise<number> {
    const rows = await prisma.mailUpload.findMany({
        where: { draft: { accountId } },
        select: { id: true, userId: true }
    });
    for (const row of rows) await removeUpload(row.userId, row.id);
    return rows.length;
}

export async function sweepOrphanUploads(): Promise<number> {
    const orphans = await prisma.mailUpload.findMany({
        where: { draftId: null, createdAt: { lt: new Date(Date.now() - ORPHAN_TTL_MS) } },
        select: { id: true, userId: true },
        take: 500
    });
    for (const row of orphans) await removeUpload(row.userId, row.id);
    return orphans.length;
}
