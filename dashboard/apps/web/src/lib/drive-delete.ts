/**
 * Deleting something from a connection, without deleting Polaris's own folder.
 *
 * Everything Polaris keeps for a connection - the recycle bin, the malware
 * quarantine - lives in one hidden folder at its root, and every listing the file
 * browser draws already filters it out. Deletion did not. A recursive delete of the
 * root walked straight into it and destroyed the copies a delete is supposed to be
 * recoverable from, then failed partway through on the half-emptied folder it could
 * no longer remove - which is how this surfaced at all, as a delete that reported
 * "directory not empty" after having already taken the bin with it.
 *
 * The root is not a folder anybody deletes, either. Asking to delete it is asking
 * to empty an entire connection, which is never what one row, one share or one drop
 * point meant, so it is refused here rather than interpreted.
 */

import { normalizeRelPath } from "@polaris/core";
import { isReservedPath } from "@/lib/system-paths";
import { StorageError, type StorageDriver } from "@polaris/storage";

/**
 * Delete one entry and everything under it.
 *
 * @param driver - Opened on the connection the path belongs to.
 * @param path - Relative to that connection's root.
 */
export async function deleteDriveEntry(driver: StorageDriver, path: string): Promise<void> {
    const target = normalizeRelPath(path);
    if (target === "") {
        throw new StorageError(
            "permission_denied",
            "The whole connection cannot be deleted at once"
        );
    }
    // Reached by name rather than by recursion, so this is a caller with a bug or a
    // visitor guessing at the one path the browser never shows them. Neither gets it,
    // and neither does the bin one level inside it.
    if (isReservedPath(target)) {
        throw new StorageError("permission_denied", "That folder belongs to Polaris");
    }
    await driver.delete(target, { recursive: true });
}

/**
 * Whether a failure says the thing is simply not there.
 *
 * Drivers answer that with `not_found` - except the local driver's delete, which
 * hands Node's own ENOENT back as it came.
 */
export function isMissingError(caught: unknown): boolean {
    if (caught instanceof StorageError) return caught.code === "not_found";
    const code = (caught as { code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Delete one entry and everything under it, where "it is already gone" is the
 * outcome that was asked for rather than a failure.
 *
 * That is what somebody removing a drop point usually meets: they deleted its
 * folder themselves first. A backend that answers a delete of something missing
 * with an error of its own is asked directly whether it is there, and only a
 * folder that still exists turns the failure into one.
 *
 * @returns "deleted" when it was removed now, "absent" when there was nothing to
 *     remove.
 */
export async function deleteDriveEntryIfPresent(
    driver: StorageDriver,
    path: string
): Promise<"deleted" | "absent"> {
    try {
        await deleteDriveEntry(driver, path);
        return "deleted";
    } catch (caught) {
        if (isMissingError(caught)) return "absent";
        // A refusal that is about the path itself - the root, Polaris's own
        // folder - is never a question of whether it exists.
        if (caught instanceof StorageError && caught.code === "permission_denied") throw caught;
        let present = true;
        try {
            await driver.stat(normalizeRelPath(path));
        } catch (asked) {
            present = !isMissingError(asked);
        }
        if (!present) return "absent";
        throw caught;
    }
}

/**
 * The children of a folder that a delete or a move to the recycle bin may touch.
 *
 * The caller emptying a folder does not know which folder it was handed - the root,
 * whose listing carries Polaris's own folder, or that folder itself, whose listing
 * is the bin and the quarantine.
 */
export function deletableChildren(paths: readonly string[]): string[] {
    return paths
        .map((path) => normalizeRelPath(path))
        .filter((path) => path !== "" && !isReservedPath(path));
}
