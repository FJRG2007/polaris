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
import { LOCAL_TARGET } from "@polaris/core";
import { host } from "@polaris/app-host";

const { driverForTarget, placeFile, safeName } = host.storageTarget;

/** Where footage goes: the camera's own choice, or the setting for every camera. */
export const { footageTarget } = host.footageStorage;

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
export async function storeStill(
    camera: { id: string; storageTarget: string | null },
    bytes: Uint8Array
): Promise<string> {
    const cameraId = camera.id;
    const folder = `${STILL_ROOT}/${await safeName(cameraId)}`;
    const path = `${folder}/${randomUUID()}.jpg`;
    const placed = await placeFile({
        target: await footageTarget(camera.storageTarget),
        localFolder: LOCAL_FOLDER,
        folder,
        path,
        bytes,
        mime: "image/jpeg",
        what: "camera picture"
    });
    return stillKey(placed.targetId, path);
}

/**
 * Read a still back, or null when the storage it was on is gone.
 *
 * Never throws: a missing picture is a tile with no picture, not a screen that
 * fails. It does say why, though, in the server's log and never to the reader -
 * this used to swallow the reason, and a wall of events with no pictures whose
 * files are sitting on the disk, readable, is a morning of guessing. The row
 * points at a file somebody expected to be there, so a read that fails is worth
 * a line whichever way it failed.
 */
export async function readStill(key: string): Promise<Buffer | null> {
    const parsed = parseStillKey(key);
    if (!parsed) {
        console.error(`stills: ${key} is not an address this Polaris wrote`);
        return null;
    }
    let driver: Awaited<ReturnType<typeof driverForTarget>> | null = null;
    try {
        driver = await driverForTarget(parsed.targetId, LOCAL_FOLDER);
        const stream = await driver.readStream(parsed.path);
        const chunks: Buffer[] = [];
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks);
    } catch (error) {
        console.error(`stills: could not read ${parsed.path} from ${parsed.targetId}:`, error);
        return null;
    } finally {
        // Released on the way out however this ended. A storage session left open
        // per failed read is the leak that turns one unreachable share into a
        // NAS that stops answering the reads that would have worked.
        await driver?.dispose?.().catch(() => undefined);
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
