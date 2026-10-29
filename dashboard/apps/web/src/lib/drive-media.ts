/**
 * The photo layout of a Drive folder, as pure functions.
 *
 * Kept apart from the component so the decisions - is this a folder of photos,
 * where do the date headings fall, which tile is above this one, which file is
 * next in the viewer - can be asserted without a browser.
 *
 * The layout follows the timeline technique of Nextcloud Photos and Immich's
 * square mode: day sections of equal square tiles, cropped to fill, virtualized
 * by row. Google Photos' justified rows need every picture's aspect ratio before
 * it is drawn, and a listing carries a name, a size and a date - so its rows
 * would reflow as each picture arrived, which is worse than a square crop.
 */

import { drawsItsOwnFrame, thumbnailKind } from "@/lib/drive-thumbnail-kind";

export type MediaKind = "image" | "video";

/** What a file is to the photo layout, by name, or null when it is neither. */
export function mediaKindOf(name: string): MediaKind | null {
    if (drawsItsOwnFrame(name)) return "video";
    return thumbnailKind(name) === "image" ? "image" : null;
}

/** The fewest files a folder needs before it is called a folder of photos:
 *  three screenshots next to a document are not an album. */
export const MEDIA_FOLDER_MIN_FILES = 6;

/** The share of a folder's files that must be pictures or videos. */
export const MEDIA_FOLDER_SHARE = 0.7;

interface Listed {
    readonly name: string;
    readonly kind: "file" | "dir" | "symlink";
}

/** Whether a folder is mostly pictures and videos. Subfolders are not counted:
 *  an album that keeps its edits in a folder of their own is still an album. */
export function isMediaFolder(entries: readonly Listed[]): boolean {
    let files = 0;
    let media = 0;
    for (const entry of entries) {
        if (entry.kind !== "file") continue;
        files++;
        if (mediaKindOf(entry.name)) media++;
    }
    return files >= MEDIA_FOLDER_MIN_FILES && media / files >= MEDIA_FOLDER_SHARE;
}

/** One line of the photo layout: a date heading, or a row of tiles holding
 *  positions in the listing's own order. */
export type PhotoRow =
    | { readonly kind: "heading"; readonly day: string; readonly count: number }
    | { readonly kind: "tiles"; readonly indices: readonly number[] };

/** The local calendar day of an ISO timestamp, as "YYYY-MM-DD", or "" when the
 *  date cannot be read. */
export function dayOf(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return "";
    const month = String(at.getMonth() + 1).padStart(2, "0");
    const day = String(at.getDate()).padStart(2, "0");
    return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * The rows of the layout.
 *
 * The tiles keep the listing's order, so selection, Shift ranges, the keyboard
 * and the viewer's next and previous all agree with what is on screen. Headings
 * are drawn only when that order is by date (`byDate`): grouping a list sorted
 * by name would scatter the same day into a heading per file. Folders lead,
 * under no heading, the way they lead every other view.
 */
export function photoRows(
    entries: readonly (Listed & { readonly modifiedAt: string })[],
    columns: number,
    byDate: boolean
): PhotoRow[] {
    const width = Math.max(1, Math.floor(columns));
    const rows: PhotoRow[] = [];
    let run: number[] = [];
    const flush = () => {
        for (let at = 0; at < run.length; at += width) {
            rows.push({ kind: "tiles", indices: run.slice(at, at + width) });
        }
        run = [];
    };
    let day: string | null = null;
    let heading: { kind: "heading"; day: string; count: number } | null = null;
    entries.forEach((entry, index) => {
        if (byDate && entry.kind === "file") {
            const next = dayOf(entry.modifiedAt);
            if (next !== day) {
                flush();
                day = next;
                heading = { kind: "heading", day: next, count: 0 };
                rows.push(heading);
            }
            if (heading) heading.count++;
        }
        run.push(index);
    });
    flush();
    return rows;
}

/** Where a listing position sits in the layout. */
function locate(rows: readonly PhotoRow[], index: number): { row: number; column: number } | null {
    for (let row = 0; row < rows.length; row++) {
        const line = rows[row];
        if (line?.kind !== "tiles") continue;
        const column = line.indices.indexOf(index);
        if (column >= 0) return { row, column };
    }
    return null;
}

/**
 * The listing position an arrow key lands on, or null when there is nowhere to
 * go. Left and right follow the listing's order; up and down move to the tile
 * above or below, clamped to the last tile of a shorter row - the end of a day
 * - and stepping over the headings in between.
 */
export function photoNeighbour(
    rows: readonly PhotoRow[],
    index: number,
    direction: "left" | "right" | "up" | "down",
    total: number
): number | null {
    if (total === 0) return null;
    if (index < 0) return direction === "left" || direction === "up" ? total - 1 : 0;
    if (direction === "left") return index > 0 ? index - 1 : null;
    if (direction === "right") return index < total - 1 ? index + 1 : null;
    const here = locate(rows, index);
    if (!here) return null;
    const step = direction === "down" ? 1 : -1;
    for (let row = here.row + step; row >= 0 && row < rows.length; row += step) {
        const line = rows[row];
        if (line?.kind !== "tiles") continue;
        return line.indices[Math.min(here.column, line.indices.length - 1)] ?? null;
    }
    return null;
}

/** The row a listing position is drawn on, for scrolling it into view. */
export function rowOfIndex(rows: readonly PhotoRow[], index: number): number {
    return locate(rows, index)?.row ?? -1;
}

/**
 * The file the viewer moves to from `path`, in the listing's order, skipping
 * folders. Null at either end, or when the open file is no longer listed.
 */
export function steppedFile<T extends { readonly path: string; readonly kind: string }>(
    entries: readonly T[],
    path: string,
    by: -1 | 1
): T | null {
    const at = entries.findIndex((entry) => entry.path === path);
    if (at < 0) return null;
    for (let index = at + by; index >= 0 && index < entries.length; index += by) {
        const entry = entries[index];
        if (entry && entry.kind === "file") return entry;
    }
    return null;
}

/** The open file's place among the listing's files: zero-based position and
 *  how many there are. */
export function fileSteps(
    entries: readonly { readonly path: string; readonly kind: string }[],
    path: string
): { index: number; count: number } {
    let count = 0;
    let index = -1;
    for (const entry of entries) {
        if (entry.kind !== "file") continue;
        if (entry.path === path) index = count;
        count++;
    }
    return { index, count };
}
