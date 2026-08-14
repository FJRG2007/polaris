/**
 * Where the vault's ciphertext blobs live: the files attached to an item, and
 * the files handed out in a Send.
 *
 * They are bytes nobody here can read, so there is nothing clever to do with
 * them - they go wherever this instance sends uploads, through the same module
 * that decides that for task attachments and profile photos. The operator picks
 * one destination under Management > Uploads and everything follows it.
 *
 * The stored name is a random id, never the file's own: the name is encrypted in
 * the database, and writing it onto a NAS share would put in the clear the one
 * thing the vault was asked to hide.
 */

import { randomBytes } from "node:crypto";
import type { StorageDriver } from "@polaris/storage";
import { UPLOAD_TARGET_KEY } from "@/lib/tasks/attachment-service";
import { driverForTarget, resolveStorageTarget } from "@/lib/storage-target";

/** One folder for everything the vault stores, so it can be found and backed up. */
const VAULT_ROOT = "polaris/vault";

/** The folder under POLARIS_DATA_DIR used when uploads stay on this server. */
const LOCAL_FOLDER = "uploads";

/** The biggest blob the vault will take, in bytes. Bitwarden's own ceiling. */
export const MAX_BLOB_BYTES = 500 * 1024 * 1024;

/** A driver onto wherever this instance keeps uploads. */
export async function vaultBlobDriver(): Promise<StorageDriver> {
    // The same setting task attachments use: an operator chooses one destination
    // for uploads, not one per feature. The key keeps its original name.
    const target = await resolveStorageTarget(UPLOAD_TARGET_KEY);
    return driverForTarget(target.id, LOCAL_FOLDER);
}

/** A fresh path for a blob, laid out so a person browsing the share can tell
 *  what belongs to what without being able to read any of it. */
export function vaultBlobPath(kind: "attachment" | "send", ownerId: string): string {
    return `${VAULT_ROOT}/${kind}/${ownerId}/${randomBytes(16).toString("hex")}`;
}

/** Write a blob, returning what was stored. */
export async function writeVaultBlob(
    path: string,
    body: ReadableStream<Uint8Array>
): Promise<{ size: bigint }> {
    const driver = await vaultBlobDriver();
    try {
        const stat = await driver.writeStream(path, body, {});
        return { size: stat.size };
    } finally {
        await driver.dispose();
    }
}

/** Remove a blob. Never throws: a blob already gone is the end state wanted. */
export async function deleteVaultBlob(path: string | null | undefined): Promise<void> {
    if (!path) return;
    const driver = await vaultBlobDriver();
    try {
        await driver.delete(path);
    } catch {
        // Already gone, or the storage moved. The row is what is authoritative.
    } finally {
        await driver.dispose();
    }
}
