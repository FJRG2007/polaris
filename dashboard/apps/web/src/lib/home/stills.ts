/**
 * The picture that goes with an event, and reading one back.
 *
 * Written through the same placement every other upload in Polaris uses, which
 * means a house with a NAS puts its footage on the NAS without anybody wiring
 * anything: that is the disk with the room and the backups, and stills are the
 * thing that accumulates. Where each one actually landed is recorded on the row,
 * so changing the destination later never orphans what is already there.
 *
 * A still is one frame at the moment something happened. It is not the recording
 * - that is a clip - and it exists because a list of events with no pictures is a
 * list nobody can judge without opening every one of them.
 *
 * Server-only.
 */

import { randomUUID } from "node:crypto";
import { driverForTarget, placeFile, resolveStorageTarget, safeName, LOCAL_TARGET } from "@/lib/storage-target";

/** The setting an administrator points the house's footage at. Its own, rather
 *  than sharing the uploads one: footage is the biggest thing Polaris writes and
 *  is the most likely to want a disk of its own. */
export const HOME_TARGET_KEY = "home.storage.target";

/** Where these sit on whichever storage they land on. */
const STILL_ROOT = "polaris/home/stills";

/** The folder under Polaris's own data directory, for the local fallback. */
const LOCAL_FOLDER = "home";

/**
 * A stored still's address: the storage it went to and the path inside it, in
 * one string, so an event row carries one column instead of two.
 *
 * `local:<path>` for this server, `<connectionId>:<path>` otherwise.
 */
export function stillKey(targetId: string, path: string): string {
    return `${targetId}:${path}`;
}

/** The two halves back, or null when the key is not one of ours. */
export function parseStillKey(key: string): { targetId: string; path: string } | null {
    const split = key.indexOf(":");
    if (split <= 0) return null;
    return { targetId: key.slice(0, split), path: key.slice(split + 1) };
}

/** Keep one frame, and answer with the key that finds it again. */
export async function storeStill(cameraId: string, bytes: Uint8Array): Promise<string> {
    const path = `${STILL_ROOT}/${safeName(cameraId)}/${randomUUID()}.jpg`;
    const placed = await placeFile({
        target: await resolveStorageTarget(HOME_TARGET_KEY),
        localFolder: LOCAL_FOLDER,
        folder: `${STILL_ROOT}/${safeName(cameraId)}`,
        path,
        bytes,
        mime: "image/jpeg",
        what: "camera picture"
    });
    return stillKey(placed.targetId, path);
}

/** Read a still back, or null when the storage it was on is gone. Never throws:
 *  a missing picture is a tile with no picture, not a screen that fails. */
export async function readStill(key: string): Promise<Buffer | null> {
    const parsed = parseStillKey(key);
    if (!parsed) return null;
    try {
        const driver = await driverForTarget(parsed.targetId, LOCAL_FOLDER);
        const stream = await driver.readStream(parsed.path);
        const chunks: Buffer[] = [];
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        await driver.dispose?.();
        return Buffer.concat(chunks);
    } catch {
        return null;
    }
}

/** Remove a still. Best effort: retention removing rows must not stop because a
 *  NAS is unplugged this morning. */
export async function deleteStill(key: string): Promise<void> {
    const parsed = parseStillKey(key);
    if (!parsed) return;
    try {
        const driver = await driverForTarget(parsed.targetId, LOCAL_FOLDER);
        await driver.delete(parsed.path).catch(() => undefined);
        await driver.dispose?.();
    } catch {
        // The storage is unreachable; the row is going either way.
    }
}

/** Whether a key points at this server rather than at a connection. */
export function isLocalStill(key: string): boolean {
    return parseStillKey(key)?.targetId === LOCAL_TARGET;
}
