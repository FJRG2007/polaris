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
import { isReservedRootPath } from "@/lib/system-paths";
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
        throw new StorageError("permission_denied", "The whole connection cannot be deleted at once");
    }
    // Reached by name rather than by recursion, so this is a caller with a bug or a
    // visitor guessing at the one path the browser never shows them. Neither gets it.
    if (isReservedRootPath(target)) {
        throw new StorageError("permission_denied", "That folder belongs to Polaris");
    }
    await driver.delete(target, { recursive: true });
}

/**
 * The children of a folder that a delete or a move to the recycle bin may touch.
 *
 * Only the root has anything to filter, and only ever the one folder, but the
 * caller emptying a folder does not know which folder it was handed.
 */
export function deletableChildren(paths: readonly string[]): string[] {
    return paths.map((path) => normalizeRelPath(path)).filter((path) => path !== "" && !isReservedRootPath(path));
}
