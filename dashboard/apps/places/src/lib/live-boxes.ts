/**
 * Where each camera's detector says things are, right now.
 *
 * Held in memory and nowhere else, and that is the design rather than a shortcut
 * taken. A live position is true for about two hundred milliseconds: written to
 * the database it would be several hundred rows a second per busy camera, each
 * one obsolete before the transaction committed, and every one of them would
 * then have to be swept up. There is nothing here worth surviving a restart -
 * whatever is in front of the camera will publish itself again on the next
 * frame.
 *
 * It follows that this is per process. Polaris runs one dashboard, so the worker
 * publishing and the screen reading are the same process; if that ever stops
 * being true this becomes the shared cache the deployment already has, and the
 * shape below - publish a frame, read the fresh one - is what would move.
 *
 * Server-only.
 */

import { freshBoxes, LIVE_TTL_MS, type LiveBox, type LiveFrame } from "@polaris/core";

/**
 * The last frame published for each camera.
 *
 * Bounded by the number of cameras a house has, which is the only bound it
 * needs: a camera that stops publishing leaves one expired entry behind, not a
 * growing list, and the entry is a handful of numbers.
 */
const frames = new Map<string, LiveFrame>();

/**
 * How many cameras may hold a frame at once.
 *
 * A ceiling rather than a limit anybody will meet - a house with this many
 * cameras is not a house. It exists because the key comes from a request: a
 * worker whose id is wrong, or one that has been tampered with, must not be able
 * to grow this map one made-up camera at a time.
 */
const MAX_CAMERAS = 512;

/** Take what a worker published. */
export function publishLiveBoxes(cameraId: string, boxes: readonly LiveBox[]): void {
    // Stamped here rather than trusted from the worker. A worker's clock is not
    // this machine's, and one running a minute fast would have every box either
    // expire before it was drawn or outlive the person it was drawn around.
    const at = Date.now();
    if (!frames.has(cameraId) && frames.size >= MAX_CAMERAS) {
        for (const [id, frame] of frames) {
            if (at - frame.at > LIVE_TTL_MS) frames.delete(id);
        }
        if (frames.size >= MAX_CAMERAS) return;
    }
    frames.set(cameraId, { at, boxes });
}

/** What is worth drawing over this camera's picture. */
export function liveBoxes(cameraId: string): readonly LiveBox[] {
    return freshBoxes(frames.get(cameraId), Date.now());
}

/** Forget a camera, for when one is deleted or switched off. Not required for
 *  correctness - the frame expires on its own - but a removed camera leaving a
 *  box behind for two seconds is a rectangle over a tile that is going away. */
export function forgetLiveBoxes(cameraId: string): void {
    frames.delete(cameraId);
}
