/**
 * Where the room in a Drive connection actually went.
 *
 * A total is not an answer. "89 GB" tells somebody their disk is nearly full and
 * nothing about what to do next; what they need is the three lists everybody
 * opens a disk analyser for - the heaviest folders, the biggest single files,
 * and which kinds of file add up to the most - each one a place they can go and
 * look at.
 *
 * One walk produces all three, because they are all the same walk. It is bounded
 * by a wall-clock deadline and a directory count, so a share with a million
 * files answers in seconds instead of hanging the request; what it did not reach
 * is reported as `partial`, which means every figure here is "at least this
 * much" rather than "this much". Saying so is the difference between a tool
 * somebody trusts and one that quietly under-reports.
 *
 * Deliberately not the folder-size cache in `drive-folder-size.ts`. That one
 * serves a listing and reuses whatever it measured last; a subtree served from
 * it would contribute a total with no files behind it, and the formats here
 * would silently be missing everything under it.
 *
 * Server-only.
 */

import { isReservedRootPath } from "./system-paths";
import type { StorageDriver } from "@polaris/storage";

/** How long one walk may spend before it reports what it has. */
export const BREAKDOWN_BUDGET_MS = 9000;
/** Directories one walk may list, so a broad tree cannot outlast the deadline
 *  by being fast. */
const MAX_DIRS = 20000;
/** How many of each list is worth showing. Past this it is a file manager. */
const TOP = 12;

export interface BreakdownFolder {
    readonly path: string;
    readonly name: string;
    readonly bytes: number;
    readonly files: number;
}

export interface BreakdownFile {
    readonly path: string;
    readonly name: string;
    /** The folder it is in, which is where "open it" has to go. */
    readonly folder: string;
    readonly bytes: number;
}

export interface BreakdownFormat {
    /** Lower-case extension with no dot, or "" for a file that has none. */
    readonly ext: string;
    readonly label: string;
    readonly bytes: number;
    readonly files: number;
}

export interface DriveBreakdown {
    readonly folders: readonly BreakdownFolder[];
    readonly files: readonly BreakdownFile[];
    readonly formats: readonly BreakdownFormat[];
    readonly bytes: number;
    readonly fileCount: number;
    readonly folderCount: number;
    /** The walk ran out of its allowance. Every figure is a lower bound. */
    readonly partial: boolean;
    readonly at: string;
}

/** What a file is called, for somebody who thinks in "photos" rather than in
 *  ".heic". Only the ones worth a word; everything else keeps its extension. */
const FORMAT_LABELS: Record<string, string> = {
    "": "No extension",
    mp4: "MP4 video",
    mkv: "MKV video",
    mov: "MOV video",
    avi: "AVI video",
    jpg: "JPEG image",
    jpeg: "JPEG image",
    png: "PNG image",
    heic: "HEIC photo",
    webp: "WebP image",
    gif: "GIF",
    mp3: "MP3 audio",
    flac: "FLAC audio",
    wav: "WAV audio",
    pdf: "PDF",
    zip: "ZIP archive",
    rar: "RAR archive",
    "7z": "7z archive",
    tar: "TAR archive",
    gz: "Gzip archive",
    iso: "Disc image",
    vmdk: "Virtual disk",
    qcow2: "Virtual disk",
    sql: "SQL dump",
    log: "Log file",
    bak: "Backup file"
};

function labelFor(ext: string): string {
    return FORMAT_LABELS[ext] ?? (ext ? `.${ext}` : "No extension");
}

/** The extension, lower-cased, without the dot. A dotfile has none: `.env` is a
 *  name, not a format. */
function extensionOf(name: string): string {
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) return "";
    const ext = name.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]{1,12}$/.test(ext) ? ext : "";
}

/** A size that cannot be trusted is not counted: a driver that reports a
 *  negative or absurd length would otherwise decide the whole ranking. */
function sizeOf(value: bigint): number {
    const bytes = Number(value);
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

/** The top-level folder a path is under, which is the unit somebody moves,
 *  archives or deletes. */
function topFolder(root: string, path: string): string | null {
    const relative = root ? path.slice(root.length + 1) : path;
    const slash = relative.indexOf("/");
    if (slash < 0) return null;
    const head = relative.slice(0, slash);
    return root ? `${root}/${head}` : head;
}

function parentOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash < 0 ? "" : path.slice(0, slash);
}

/** Keep the biggest `TOP`, without sorting the whole disk. */
function offer(list: BreakdownFile[], entry: BreakdownFile): void {
    if (list.length < TOP) {
        list.push(entry);
        list.sort((left, right) => right.bytes - left.bytes);
        return;
    }
    const smallest = list[list.length - 1];
    if (!smallest || entry.bytes <= smallest.bytes) return;
    list[list.length - 1] = entry;
    list.sort((left, right) => right.bytes - left.bytes);
}

/**
 * Walk a connection from `root` and say where its room went.
 *
 * `skip` is the access-gated set: a folder somebody may not open is not entered
 * and not counted, exactly as it is not listed.
 */
export async function driveBreakdown(
    driver: StorageDriver,
    root: string,
    options: { skip?: ReadonlySet<string>; budgetMs?: number } = {}
): Promise<DriveBreakdown> {
    const gated = options.skip ?? new Set<string>();
    const deadline = Date.now() + (options.budgetMs ?? BREAKDOWN_BUDGET_MS);
    let dirs = MAX_DIRS;
    let partial = false;

    const folders = new Map<string, { bytes: number; files: number }>();
    const formats = new Map<string, { bytes: number; files: number }>();
    const biggest: BreakdownFile[] = [];
    let bytes = 0;
    let fileCount = 0;
    let folderCount = 0;

    // Iterative rather than recursive: a deep tree is a stack overflow, and the
    // one thing a walk of somebody's whole disk must not do is take the request
    // down with it.
    const queue: string[] = [root];
    while (queue.length > 0) {
        if (dirs <= 0 || Date.now() >= deadline) {
            partial = true;
            break;
        }
        const path = queue.shift() as string;
        dirs--;

        let listing;
        try {
            listing = await driver.list(path);
        } catch {
            // An unreadable folder is not an empty one. It is left out and the
            // result says it is a lower bound.
            partial = true;
            continue;
        }

        for (const entry of listing.entries) {
            if (isReservedRootPath(entry.path) || gated.has(entry.path)) continue;
            if (entry.kind === "dir") {
                folderCount++;
                queue.push(entry.path);
                continue;
            }
            if (entry.kind !== "file") continue;

            const weight = sizeOf(entry.size);
            fileCount++;
            bytes += weight;

            const ext = extensionOf(entry.name);
            const format = formats.get(ext) ?? { bytes: 0, files: 0 };
            format.bytes += weight;
            format.files += 1;
            formats.set(ext, format);

            const top = topFolder(root, entry.path);
            if (top) {
                const folder = folders.get(top) ?? { bytes: 0, files: 0 };
                folder.bytes += weight;
                folder.files += 1;
                folders.set(top, folder);
            }

            offer(biggest, {
                path: entry.path,
                name: entry.name,
                folder: parentOf(entry.path),
                bytes: weight
            });
        }
    }

    return {
        folders: [...folders.entries()]
            .map(([path, totals]) => ({
                path,
                name: path.slice(path.lastIndexOf("/") + 1),
                bytes: totals.bytes,
                files: totals.files
            }))
            .sort((left, right) => right.bytes - left.bytes)
            .slice(0, TOP),
        files: biggest,
        formats: [...formats.entries()]
            .map(([ext, totals]) => ({ ext, label: labelFor(ext), bytes: totals.bytes, files: totals.files }))
            .sort((left, right) => right.bytes - left.bytes)
            .slice(0, TOP),
        bytes,
        fileCount,
        folderCount,
        partial,
        at: new Date().toISOString()
    };
}
