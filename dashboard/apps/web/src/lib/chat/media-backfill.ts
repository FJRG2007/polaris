/**
 * The size and blur of pictures sent before they were measured.
 *
 * A picture sent now carries its pixel size and a ThumbHash, measured by the
 * browser that sent it (see `media-shape`). The ones sent before that have
 * neither and are drawn in a neutral box until they arrive. This pass works
 * through them in the background, a batch at a time, reading each one back from
 * the storage it is on - nothing waits on it, and it never runs at boot.
 *
 * Idempotent by construction: a row is written only while its width is still
 * null, so two passes, or a pass racing a fresh upload, never write twice. A
 * file the image library cannot read is written with a width of 0, which every
 * reader takes as "not measured" (`fittedSize`), so it is not read again.
 *
 * Videos are left alone: their still is a separate file, and reading a video's
 * size needs a decoder this server does not have. They keep the neutral box.
 */

import { prisma } from "@polaris/db";
import { readStored } from "./attachments";
import { encodeThumbHash, MEDIA_SIDE_CEILING } from "./media-shape";

export const BACKFILL_BATCH = 50;
/** Batches per pass, so one pass is bounded however much is waiting. */
export const BACKFILL_BATCHES_PER_PASS = 20;
/** Past this a picture is not read into memory to be measured. */
const LARGEST_READ_BYTES = 64 * 1024 * 1024;
/** What a ThumbHash is encoded from: the picture scaled to fit this box. */
const THUMB_SIDE = 100;

export interface MeasuredImage {
    readonly width: number;
    readonly height: number;
    readonly thumbhash: string | null;
}

/**
 * Measure one picture: its displayed size, EXIF rotation applied, and a
 * ThumbHash of it scaled to fit 100x100. Null when it cannot be read.
 */
export async function measureImage(bytes: Uint8Array): Promise<MeasuredImage | null> {
    const { default: sharp } = await import("sharp");
    try {
        const meta = await sharp(bytes, { animated: false }).metadata();
        if (!meta.width || !meta.height) return null;
        // Orientations 5 to 8 turn the picture a quarter, so its sides swap.
        const turned = (meta.orientation ?? 1) >= 5;
        const width = turned ? meta.height : meta.width;
        const height = turned ? meta.width : meta.height;
        if (width > MEDIA_SIDE_CEILING || height > MEDIA_SIDE_CEILING) return null;
        const { data, info } = await sharp(bytes, { animated: false })
            .rotate()
            .resize(THUMB_SIDE, THUMB_SIDE, { fit: "inside", withoutEnlargement: true })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        let thumbhash: string | null = null;
        try {
            thumbhash = encodeThumbHash(info.width, info.height, data);
        } catch {
            thumbhash = null;
        }
        return { width, height, thumbhash };
    } catch {
        return null;
    }
}

/**
 * Where the walk is, across passes. Ids are UUIDv7, so they grow with time: the
 * walk never goes back to the start once it reaches the end, and each later
 * pass reads only the pictures sent since, through the primary key. Without it
 * every hourly pass would scan the whole table to find nothing.
 */
let cursor: string | null = null;
/** The first picture a pass could not read from its storage, read again next pass. */
let retry: string | null = null;

/** Forget where the walk is. For tests. */
export function resetBackfillCursor(): void {
    cursor = null;
    retry = null;
}

/**
 * One pass: up to `BACKFILL_BATCHES_PER_PASS` batches of pictures with no size,
 * oldest id first, from where the last one stopped (or from the first picture it
 * could not read).
 */
export async function backfillMediaShapes(): Promise<{ measured: number; unreadable: number }> {
    let measured = 0;
    let unreadable = 0;
    // Inclusive for the picture to read again, exclusive past the last one read.
    let from: { gte: string } | { gt: string } | null = retry ? { gte: retry } : cursor ? { gt: cursor } : null;
    retry = null;
    for (let batch = 0; batch < BACKFILL_BATCHES_PER_PASS; batch += 1) {
        const rows = await prisma.chatAttachment.findMany({
            where: {
                width: null,
                contentType: { startsWith: "image/" },
                viewOnce: false,
                borrowed: false,
                ...(from ? { id: from } : {})
            },
            orderBy: { id: "asc" },
            take: BACKFILL_BATCH,
            select: { id: true, connectionId: true, path: true, size: true }
        });
        if (rows.length === 0) break;
        const last = rows[rows.length - 1]!.id;
        if (!cursor || last > cursor) cursor = last;
        from = { gt: last };
        for (const row of rows) {
            const shape =
                Number(row.size) > LARGEST_READ_BYTES
                    ? null
                    : await (async () => {
                          const bytes = await readStored(row.connectionId, row.path, `picture ${row.id}`);
                          // Not there to read right now: left for a later pass
                          // rather than marked, since a storage that is down
                          // comes back.
                          if (!bytes) return undefined;
                          return measureImage(bytes);
                      })();
            if (shape === undefined) {
                retry ??= row.id;
                continue;
            }
            const data = shape ?? { width: 0, height: null, thumbhash: null };
            await prisma.chatAttachment.updateMany({ where: { id: row.id, width: null }, data });
            if (shape) measured += 1;
            else unreadable += 1;
        }
        if (rows.length < BACKFILL_BATCH) break;
    }
    return { measured, unreadable };
}
