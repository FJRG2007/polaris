/**
 * Name clashes in a Drive folder, and the writes that settle them the way the
 * person chose: replace what is there, keep both, or refuse.
 *
 * Two rules hold everywhere in here:
 *
 * - **A clash is decided on `driveNameKey`**, so "Report.pdf" clashes with
 *   "report.pdf" on every storage, the way Drive already compares names. A
 *   storage that is case-sensitive could hold both, but the person cannot tell
 *   two such files apart in a listing, so Drive asks instead.
 * - **Deciding a name and taking it are one step.** Both run under the folder's
 *   name lock (`withNameLock`, shared with the visitors' uploads), and the name
 *   is taken with an empty file before the bytes start, so a second upload that
 *   was told the name was free finds it taken and fails with a
 *   `NameConflictError` instead of writing over the first. The lock is held for
 *   the claim only, never for a transfer.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pathExists, withNameLock } from "@/lib/upload-naming";
import { StorageError, type StorageDriver } from "@polaris/storage";
import { baseName, driveNameKey, parentPath, withCopyNumber } from "@polaris/core";

/** What a write does when its name is already taken in the folder. */
export const conflictModeSchema = z.enum(["fail", "keepBoth", "replace"]);
export type ConflictMode = z.infer<typeof conflictModeSchema>;

/** How many "(n)" names to try before calling the folder full of this name. */
const MAX_COPIES = 500;

/** Listing pages read per folder before giving up on finding a clash in it. */
const MAX_PAGES = 200;

/** An item already in the folder under the name something is arriving with. */
export interface Clash {
    /** The path that was asked for. */
    readonly path: string;
    /** Where the item that holds the name actually is (its own spelling). */
    readonly existingPath: string;
    readonly existingName: string;
    readonly existingKind: "file" | "dir";
}

/**
 * Raised when a name turned out to be taken at the moment of writing - another
 * upload or person got there between the check and the write. Typed so a route
 * can answer 409 with the clash and the screen can ask again.
 */
export class NameConflictError extends Error {
    public readonly clash: Clash;
    public constructor(clash: Clash) {
        super(`An item named "${clash.existingName}" already exists`);
        this.name = "NameConflictError";
        this.clash = clash;
    }
}

/** Every name in `folder`, keyed by `driveNameKey`. A folder that is not there is empty. */
async function folderNames(
    driver: StorageDriver,
    folder: string
): Promise<Map<string, { name: string; path: string; kind: "file" | "dir" }>> {
    const names = new Map<string, { name: string; path: string; kind: "file" | "dir" }>();
    let cursor: string | undefined;
    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            const result = await driver.list(folder, cursor ? { cursor } : undefined);
            for (const entry of result.entries) {
                names.set(driveNameKey(entry.name), {
                    name: entry.name,
                    path: entry.path,
                    kind: entry.kind === "dir" ? "dir" : "file"
                });
            }
            if (!result.nextCursor) break;
            cursor = result.nextCursor;
        }
    } catch (error) {
        if (error instanceof StorageError && error.code === "not_found") return names;
        // Anything else is not an answer: a folder that could not be read is not
        // a folder known to be free of clashes.
        throw error;
    }
    return names;
}

/**
 * The clashes among `paths` (normalized, relative to the storage root), one
 * listing per distinct parent folder however many paths share it.
 */
export async function findClashes(
    driver: StorageDriver,
    paths: readonly string[]
): Promise<Clash[]> {
    const byFolder = new Map<string, string[]>();
    for (const path of paths) {
        const folder = parentPath(path);
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), path]);
    }
    const clashes: Clash[] = [];
    for (const [folder, wanted] of byFolder) {
        const names = await folderNames(driver, folder);
        for (const path of wanted) {
            const found = names.get(driveNameKey(baseName(path)));
            if (!found) continue;
            clashes.push({
                path,
                existingPath: found.path || (folder ? `${folder}/${found.name}` : found.name),
                existingName: found.name,
                existingKind: found.kind
            });
        }
    }
    return clashes;
}

/**
 * The clash for one path, or null when its name is free. The stat answers the
 * exact name for the price of one call - the usual case when a replace is
 * settled under the lock - and the folder is only read when it misses, to find
 * the same name in another case. A storage that matches names its own way (or
 * a listing that hides an entry) still cannot have a file written over without
 * anyone being asked.
 */
export async function findClash(driver: StorageDriver, path: string): Promise<Clash | null> {
    const exact = await statClash(driver, path);
    if (exact) return exact;
    const [clash] = await findClashes(driver, [path]);
    return clash ?? null;
}

/**
 * The clash at exactly `path` as the storage itself resolves it - no listing.
 * The write-time guard for a name already checked with `findClashes`: it is
 * what stops an overwrite (a storage that ignores case finds "Report.pdf" for
 * "report.pdf" here too), and it costs one stat instead of reading the folder
 * once per file of a large upload.
 */
export async function statClash(driver: StorageDriver, path: string): Promise<Clash | null> {
    if (!(await pathExists(driver, path))) return null;
    const stat = await driver.stat(path);
    return {
        path,
        existingPath: stat.path || path,
        existingName: stat.name || baseName(path),
        existingKind: stat.kind === "dir" ? "dir" : "file"
    };
}

/** The first "name (n).ext" that is free in the folder, for "Keep both". */
async function freeCopyPath(driver: StorageDriver, path: string): Promise<string> {
    const folder = parentPath(path);
    const names = await folderNames(driver, folder);
    for (let copy = 1; copy <= MAX_COPIES; copy++) {
        const name = withCopyNumber(baseName(path), copy);
        if (names.has(driveNameKey(name))) continue;
        const candidate = folder ? `${folder}/${name}` : name;
        if (await pathExists(driver, candidate)) continue;
        return candidate;
    }
    throw new StorageError("already_exists", `No free name for ${baseName(path)}`);
}

/** An empty stream, for taking a name before the real bytes arrive. */
function emptyBody(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.close();
        }
    });
}

/**
 * Take a name for a new file: the one asked for when it is free, or under
 * `keepBoth` the first free "(n)" variant. Under `fail` a taken name throws
 * `NameConflictError`. Returns the path now holding an empty placeholder, which
 * the caller writes the bytes over and must delete if the transfer fails.
 */
export async function claimFileName(
    driver: StorageDriver,
    path: string,
    mode: "fail" | "keepBoth"
): Promise<string> {
    return withNameLock(driver, parentPath(path), async () => {
        let target = path;
        const clash =
            mode === "fail" ? await statClash(driver, path) : await findClash(driver, path);
        if (clash) {
            if (mode === "fail") throw new NameConflictError(clash);
            target = await freeCopyPath(driver, path);
        }
        await driver.writeStream(target, emptyBody(), { size: 0n });
        return target;
    });
}

/**
 * Make a folder under a name of its own: the one asked for when free, else (for
 * `keepBoth`, "Keep both" on a folder) the first free "(n)" variant. Under
 * `fail` a taken name throws `NameConflictError`. Returns its path.
 */
export async function claimFolderName(
    driver: StorageDriver,
    path: string,
    mode: "fail" | "keepBoth" = "keepBoth"
): Promise<string> {
    return withNameLock(driver, parentPath(path), async () => {
        const clash = await findClash(driver, path);
        if (clash && mode === "fail") throw new NameConflictError(clash);
        const target = clash ? await freeCopyPath(driver, path) : path;
        await driver.mkdir(target);
        return target;
    });
}

/**
 * Move an item to `path` (or, under `keepBoth`, its first free "(n)" variant)
 * as one step with deciding the name, so nothing that arrived meanwhile is
 * moved over. Under `fail` a taken name throws `NameConflictError`. Returns
 * where it landed.
 */
export async function moveToName(
    driver: StorageDriver,
    from: string,
    path: string,
    mode: "fail" | "keepBoth"
): Promise<string> {
    return withNameLock(driver, parentPath(path), async () => {
        const clash = await findClash(driver, path);
        if (clash && mode === "fail") throw new NameConflictError(clash);
        const target = clash ? await freeCopyPath(driver, path) : path;
        await driver.move(from, target);
        return target;
    });
}

/** A hidden name next to `path` that incoming bytes can land on before they replace it. */
export function stagingPath(path: string): string {
    const folder = parentPath(path);
    const name = `.${baseName(path)}.polaris-upload-${randomUUID()}`;
    return folder ? `${folder}/${name}` : name;
}

/**
 * Put a fully written `staged` item at `path`, retiring whatever holds the name
 * now (by its own spelling). Re-checked under the lock, so what is retired is
 * what is there at this moment, not what was there when the person was asked.
 *
 * With a `trash`, the old item goes to the bin first, where it can be restored
 * from - if the move after it fails, nothing is lost, it is in the bin. Without
 * one (a source Drive keeps no bin for) the old item is moved aside, only
 * dropped once the new one is in place, and put back if that fails.
 *
 * A folder is never retired for a file, nor a file for a folder: that is a
 * `NameConflictError`, because "replace" was a choice about a file. `guard`
 * runs on the item about to be retired and throws to stop it - the permission
 * to replace is a fact about that item, which may not be the one the person
 * was shown.
 */
export async function replaceWith(
    driver: StorageDriver,
    staged: string,
    path: string,
    options: {
        readonly guard?: (clash: Clash) => Promise<void>;
        readonly trash: ((existingPath: string) => Promise<void>) | null;
    }
): Promise<void> {
    const { guard, trash } = options;
    const stagedKind = (await driver.stat(staged)).kind === "dir" ? "dir" : "file";
    await withNameLock(driver, parentPath(path), async () => {
        const clash = await findClash(driver, path);
        if (!clash) return driver.move(staged, path);
        if (clash.existingKind !== stagedKind) throw new NameConflictError(clash);
        await guard?.(clash);
        if (trash) {
            await trash(clash.existingPath);
            return driver.move(staged, path);
        }
        const aside = `${clash.existingPath}.polaris-replaced-${randomUUID()}`;
        await driver.move(clash.existingPath, aside);
        try {
            await driver.move(staged, path);
        } catch (error) {
            await driver.move(aside, clash.existingPath).catch(() => undefined);
            throw error;
        }
        await driver.delete(aside).catch(() => undefined);
    });
}
