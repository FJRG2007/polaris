/**
 * The bin, in the shape the explorer listing draws. Client-safe: shared by the
 * Trash page, its view and the batched bin actions.
 */

import type { DriveEntry } from "../types";

/** Most bin rows one restore or delete request carries; a larger selection is sent in pieces. */
export const TRASH_BATCH_MAX = 1000;

/** One bin row, serialized for the client. */
export interface TrashRow {
    id: string;
    name: string;
    /** Where it lived before it was deleted, on its connection. */
    originalPath: string;
    connectionId: string;
    connectionName: string;
    /** Where it sits now, so its picture can still be drawn. */
    trashPath: string;
    kind: string;
    size: string;
    deletedAt: string;
}

/**
 * A bin row as a listing entry. The row id stands in for the path, because two
 * rows can share a name and an original path; when it was deleted fills both
 * dates, which is the one date that means anything in the bin.
 */
export function trashEntry(row: TrashRow): DriveEntry {
    return {
        name: row.name,
        path: row.id,
        kind: row.kind === "dir" ? "dir" : row.kind === "symlink" ? "symlink" : "file",
        size: row.size,
        modifiedAt: row.deletedAt,
        createdAt: row.deletedAt
    };
}

/** The folder an item was deleted from, empty for the root of its connection. */
export function originalFolder(row: TrashRow): string {
    const slash = row.originalPath.lastIndexOf("/");
    return slash > 0 ? row.originalPath.slice(0, slash) : "";
}

/** Split ids into pieces no larger than one request takes. */
export function trashBatches(ids: readonly string[]): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < ids.length; i += TRASH_BATCH_MAX)
        out.push(ids.slice(i, i + TRASH_BATCH_MAX));
    return out;
}
