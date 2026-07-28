/**
 * Folder weights for the Drive browser. A storage backend reports a size per
 * file but never per folder, so the only way to know what a folder weighs is to
 * walk it - far too slow to do while a listing renders, and pure waste to redo
 * on every visit.
 *
 * So a walk happens in the background and its result is stored per folder with
 * the time it was taken. Two things make the next walk cheap: a measurement is
 * reused while it is fresh (so a parent sums its children instead of descending
 * into them), and every folder the walk completes is stored too, not just the
 * one that was asked for. Work is bounded by a shared budget - a wall-clock
 * deadline and a directory count - so one huge tree can never hang a request;
 * what it did finish is stored, and the caller comes back for the rest.
 *
 * Accuracy: a measurement Polaris cannot vouch for is never presented as exact.
 * Writes made through Polaris drop the cached rows for the path, its subtree and
 * its ancestors; changes made outside Polaris are caught by the freshness
 * window. A walk cut short by its budget is not stored at all (it would be a
 * badly understated total), and one that skipped a gated subtree is stored and
 * flagged `partial`, meaning "at least this much".
 */

import { prisma } from "@polaris/db";
import type { StorageDriver } from "@polaris/storage";
import { isReservedRootPath } from "./system-paths";
import { isUuid } from "./uuid";

export interface FolderSize {
    readonly bytes: bigint;
    readonly files: number;
    readonly folders: number;
    /** A gated subtree was skipped, so `bytes` is a lower bound, not the total. */
    readonly partial: boolean;
    readonly computedAt: Date;
}

/** How long a measurement is served (and reused by parents) before a fresh walk. */
export const FOLDER_SIZE_TTL_MS = 30 * 60 * 1000;
/** Depth, relative to the walked folder, whose measurements are worth storing. */
const PERSIST_DEPTH = 3;
/** Rows one walk may store, so a broad tree cannot turn into a write storm. */
const PERSIST_LIMIT = 500;

/** Work allowance shared by every walk in one request. */
export interface SizeBudget {
    /** Epoch ms after which walks stop and report what they have. */
    deadline: number;
    /** Directories the walks may still list. */
    nodes: number;
}

/** A budget of `ms` wall-clock and `nodes` directory listings. */
export function createSizeBudget(ms: number, nodes = 20000): SizeBudget {
    return { deadline: Date.now() + ms, nodes };
}

/** Whether a stored measurement is still within the freshness window. */
export function isFresh(size: FolderSize, now = Date.now()): boolean {
    return now - size.computedAt.getTime() < FOLDER_SIZE_TTL_MS;
}

interface SizeRow {
    path: string;
    bytes: bigint;
    files: number;
    folders: number;
    partial: boolean;
    computedAt: Date;
}

function toSize(row: SizeRow): FolderSize {
    return {
        bytes: row.bytes,
        files: row.files,
        folders: row.folders,
        partial: row.partial,
        computedAt: row.computedAt
    };
}

/** Stored measurements for the given folders, fresh ones only. */
export async function getCachedFolderSizes(
    connectionId: string,
    paths: string[]
): Promise<Map<string, FolderSize>> {
    if (paths.length === 0 || !isUuid(connectionId)) return new Map();
    const rows = await prisma.driveFolderSize.findMany({
        where: { connectionId, path: { in: paths } },
        select: {
            path: true,
            bytes: true,
            files: true,
            folders: true,
            partial: true,
            computedAt: true
        }
    });
    const now = Date.now();
    const out = new Map<string, FolderSize>();
    for (const row of rows) {
        const size = toSize(row);
        if (isFresh(size, now)) out.set(row.path, size);
    }
    return out;
}

/** Every stored measurement under (and including) `root`, for one walk to reuse. */
async function loadSubtree(connectionId: string, root: string): Promise<Map<string, FolderSize>> {
    if (!isUuid(connectionId)) return new Map();
    const rows = await prisma.driveFolderSize.findMany({
        where: root
            ? { connectionId, OR: [{ path: root }, { path: { startsWith: `${root}/` } }] }
            : { connectionId },
        select: {
            path: true,
            bytes: true,
            files: true,
            folders: true,
            partial: true,
            computedAt: true
        }
    });
    return new Map(rows.map((row) => [row.path, toSize(row)]));
}

/** Store what a walk measured. Best effort: a cache write must never fail a read. */
async function persistSizes(connectionId: string, sizes: Map<string, FolderSize>): Promise<void> {
    if (sizes.size === 0 || !isUuid(connectionId)) return;
    try {
        await prisma.$transaction(
            [...sizes].map(([path, size]) =>
                prisma.driveFolderSize.upsert({
                    where: { connectionId_path: { connectionId, path } },
                    create: {
                        connectionId,
                        path,
                        bytes: size.bytes,
                        files: size.files,
                        folders: size.folders,
                        partial: size.partial,
                        computedAt: size.computedAt
                    },
                    update: {
                        bytes: size.bytes,
                        files: size.files,
                        folders: size.folders,
                        partial: size.partial,
                        computedAt: size.computedAt
                    }
                })
            )
        );
    } catch {
        // The measurement still reaches the caller; only the cache write was lost.
    }
}

/** What a walk returns internally, before the caller learns whether it finished. */
interface WalkResult extends FolderSize {
    /** The budget ran out: the total is a fragment, not worth keeping or showing. */
    truncated: boolean;
    /** The folder itself could not be listed: nothing can be said about it. */
    unreadable: boolean;
}

/**
 * How a measurement ended. The three cases lead to different behavior, which is
 * why they are not collapsed into a nullable size: a deferred folder is worth
 * asking about again, an unreadable one never will be.
 */
export type MeasureOutcome =
    | { readonly status: "measured"; readonly size: FolderSize }
    | { readonly status: "deferred" }
    | { readonly status: "unreadable" };

export interface MeasureOptions {
    /** Shared allowance; walks stop when it runs out. */
    budget: SizeBudget;
    /** Folder paths never entered or counted (access-gated roots). */
    skip?: ReadonlySet<string>;
}

/**
 * Measure everything under `root`, reusing and refreshing the stored cache. When
 * the budget runs out the outcome is "deferred": the sub-folders that did finish
 * are now cached, so asking again picks up where this left off. A folder that
 * cannot be listed at all comes back "unreadable" instead, since repeating the
 * request would only repeat the failure.
 */
export async function measureFolder(
    driver: StorageDriver,
    connectionId: string,
    root: string,
    { budget, skip }: MeasureOptions
): Promise<MeasureOutcome> {
    const cache = await loadSubtree(connectionId, root);
    const persist = new Map<string, FolderSize>();
    const gated = skip ?? new Set<string>();
    const startedAt = Date.now();

    const empty = { bytes: 0n, files: 0, folders: 0, partial: true, computedAt: new Date() };

    const walk = async (path: string, depth: number): Promise<WalkResult> => {
        const cached = cache.get(path);
        if (cached && isFresh(cached, startedAt)) {
            return { ...cached, truncated: false, unreadable: false };
        }
        if (budget.nodes <= 0 || Date.now() >= budget.deadline) {
            return { ...empty, computedAt: new Date(), truncated: true, unreadable: false };
        }
        budget.nodes--;

        let listing;
        try {
            listing = await driver.list(path);
        } catch {
            // An unreadable folder is not a zero-byte folder; say so instead of
            // silently reporting a total that is missing everything inside it.
            return { ...empty, computedAt: new Date(), truncated: false, unreadable: true };
        }

        let bytes = 0n;
        let files = 0;
        let folders = 0;
        let partial = false;
        let truncated = false;
        for (const entry of listing.entries) {
            if (isReservedRootPath(entry.path)) continue;
            if (entry.kind !== "dir") {
                files++;
                bytes += entry.size;
                continue;
            }
            folders++;
            // A gated folder is counted as present but never opened, so the total
            // is honest about being a floor rather than leaking what is inside.
            if (gated.has(entry.path)) {
                partial = true;
                continue;
            }
            const child = await walk(entry.path, depth + 1);
            bytes += child.bytes;
            files += child.files;
            folders += child.folders;
            // A child that could not be read leaves the total a floor, but the
            // measurement still stands; only a spent budget makes it worthless.
            partial = partial || child.partial;
            truncated = truncated || child.truncated;
            if (truncated) break;
        }

        const result: WalkResult = {
            bytes,
            files,
            folders,
            partial,
            computedAt: new Date(),
            truncated,
            unreadable: false
        };
        if (!truncated && depth <= PERSIST_DEPTH && persist.size < PERSIST_LIMIT) {
            persist.set(path, result);
        }
        return result;
    };

    const measured = await walk(root, 0);
    await persistSizes(connectionId, persist);
    if (measured.unreadable) return { status: "unreadable" };
    if (measured.truncated) return { status: "deferred" };
    return {
        status: "measured",
        size: {
            bytes: measured.bytes,
            files: measured.files,
            folders: measured.folders,
            partial: measured.partial,
            computedAt: measured.computedAt
        }
    };
}

/**
 * Forget the measurements a write invalidates: the path itself, everything under
 * it, and every ancestor whose total just changed. Called after any Polaris-side
 * mutation; failures are swallowed because a stale cache row must never turn a
 * successful file operation into an error.
 */
export async function invalidateFolderSizes(connectionId: string, path: string): Promise<void> {
    if (!isUuid(connectionId)) return;
    const segments = path.split("/").filter(Boolean);
    const ancestors = [""];
    for (let index = 0; index < segments.length; index++) {
        ancestors.push(segments.slice(0, index + 1).join("/"));
    }
    try {
        await prisma.driveFolderSize.deleteMany({
            where: {
                connectionId,
                OR: [
                    { path: { in: ancestors } },
                    ...(path ? [{ path: { startsWith: `${path}/` } }] : [])
                ]
            }
        });
    } catch {
        // Best effort: the freshness window still bounds how long a stale row lives.
    }
}
