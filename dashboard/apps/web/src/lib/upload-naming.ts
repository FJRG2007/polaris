/**
 * Where an incoming upload is allowed to land, when the person sending it does
 * not get to overwrite what is already there.
 *
 * Anyone uploading through a drop point or a shared folder is a visitor: they
 * cannot see the destination, so they cannot know their filename is already
 * taken, and a plain write would silently replace somebody else's file. The
 * answer is not to rewrite their filename - a document that arrives as
 * "contrato-firmado.pdf" has to stay that, or the recipient is left guessing
 * what they were sent - it is to give the first arrival the name verbatim and
 * number only a genuine collision.
 *
 * Picking a free name and taking it have to happen together, or two uploads that
 * both find "contrato.pdf" free will both write it and the second silently wins.
 * They are serialized per destination folder and the winner claims the name with
 * an empty file before the bytes start, so the loser sees it taken and numbers
 * itself. The lock is held only for the claim, never for the transfer, so a
 * large upload never blocks a small one behind it.
 *
 * In-process, like the deploy queue: Polaris serves its storage from one web
 * process, and a claim is worthless across processes anyway unless the backend
 * offers an atomic create - which the driver contract, deliberately, does not.
 */

import { baseName, numberedName, parentPath } from "@polaris/core";
import { StorageError, type StorageDriver } from "@polaris/storage";

/**
 * How many numbered variants to try before giving up. A folder holding this many
 * files of one name is not a collision any more, it is a loop somewhere.
 */
const MAX_ATTEMPTS = 200;

/** Serializes name claims per destination folder. */
const claims = new Map<string, Promise<unknown>>();

/** Run `job` after any prior job for the same folder has finished. */
async function serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prior = claims.get(key) ?? Promise.resolve();
    // The chain only orders the work; a failed claim must not break the ones queued
    // behind it, and its error still reaches this caller through `next`.
    const next = prior.then(job, job);
    const settled = next.catch(() => undefined);
    claims.set(key, settled);
    try {
        return await next;
    } finally {
        // Drop the chain once nothing is queued behind it, so a long-lived process
        // does not accumulate one entry per folder ever written to.
        if (claims.get(key) === settled) claims.delete(key);
    }
}

/** Whether something already exists at `path`. Any other failure propagates. */
async function exists(driver: StorageDriver, path: string): Promise<boolean> {
    try {
        await driver.stat(path);
        return true;
    } catch (error) {
        if (error instanceof StorageError && error.code === "not_found") return false;
        // A permissions or I/O failure is not an answer. Treating it as "free"
        // would overwrite the very file we cannot see.
        throw error;
    }
}

/** An empty stream, for claiming a name before the real bytes arrive. */
function emptyBody(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.close();
        }
    });
}

/**
 * Reserve a path for an upload that must not overwrite anything: the requested
 * name when it is free, otherwise the first numbered variant that is. Returns
 * the claimed path, which now holds an empty file - the caller writes the real
 * bytes over it, and must delete it if the upload fails.
 */
export async function claimUploadPath(driver: StorageDriver, target: string): Promise<string> {
    const parent = parentPath(target);
    const name = baseName(target);
    return serialized(`${driver.id}:${parent}`, async () => {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            const candidate = numberedName(name, attempt);
            const path = parent ? `${parent}/${candidate}` : candidate;
            if (await exists(driver, path)) continue;
            await driver.writeStream(path, emptyBody(), { size: 0n });
            return path;
        }
        throw new StorageError("already_exists", `No free name for ${name} after ${MAX_ATTEMPTS} tries`);
    });
}
