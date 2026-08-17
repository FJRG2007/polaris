/**
 * Keeping footage, and getting rid of it again.
 *
 * A clip is a segment of the good stream, copied straight from the relay to
 * whichever storage the house writes to. Copied, not re-encoded: the bytes that
 * arrive are the bytes that are written, so recording four cameras costs disk
 * and almost no processor. It is also why this can live in the dashboard process
 * at all, where decoding never could.
 *
 * Two ways a clip comes to exist, and they are different promises:
 *
 * - **On movement.** Something happened, and the next stretch of video is worth
 *   keeping. Deliberately from the moment it fired rather than from a moment
 *   before it: keeping the seconds before would mean holding every camera's
 *   stream in memory all day, which is the exact cost this app exists to avoid.
 * - **Always.** A segment at a time, back to back, on a schedule. Segments
 *   rather than one endless file, so retention can drop an afternoon without
 *   rewriting anything and a clip somebody wants is a clip they can download.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { getCamera } from "@/lib/home/cameras";
import { footageTarget } from "@/lib/home/stills";
import { relayEndpoint, relayServerFor, relayStream, streamPath } from "@/lib/home/relay";
import { LOCAL_TARGET, driverForTarget, safeName } from "@/lib/storage-target";

/** Where clips sit on whichever storage they land on. */
const CLIP_ROOT = "polaris/home/clips";

/** The folder under Polaris's own data directory, for the local fallback. */
const LOCAL_FOLDER = "home";

/** How long one segment is. Five minutes is the compromise every recorder makes:
 *  short enough that retention is granular and a download is reasonable, long
 *  enough that a day is not thousands of files. */
export const SEGMENT_SECONDS = 300;

/** How much is kept after something happened. */
export const MOTION_SECONDS = 30;

/** A ceiling on any single clip, whatever asked for it. A stream that never ends
 *  and a bug that never stops it are the same thing to a disk. */
const MAX_SECONDS = 900;

export interface ClipView {
    readonly id: string;
    readonly cameraId: string;
    readonly cameraName: string;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly reason: string;
    readonly bytes: number;
    readonly durationMs: number;
    readonly pinned: boolean;
}

/**
 * Record one segment of a camera and write it where the house keeps footage.
 *
 * Returns the clip, or null when there was nothing to record - the relay is not
 * up, the camera is not answering, or it sent nothing at all. A camera that is
 * down must never leave a zero-byte clip behind claiming otherwise.
 */
export async function recordClip(
    installedAppId: string,
    cameraId: string,
    reason: "motion" | "continuous" | "manual",
    seconds: number
): Promise<ClipView | null> {
    const camera = await getCamera(installedAppId, cameraId);
    if (!camera || !camera.enabled) return null;
    const endpoint = await relayEndpoint(relayServerFor(camera.reachVia));
    if (!endpoint) return null;

    const duration = Math.min(Math.max(seconds, 5), MAX_SECONDS);
    const startedAt = new Date();
    const folder = `${CLIP_ROOT}/${safeName(cameraId)}`;
    const path = `${folder}/${startedAt.toISOString().slice(0, 10)}-${randomUUID()}.mp4`;

    // The camera's own disk when it names one, the instance's otherwise.
    const target = await footageTarget(camera.storageTarget || null);
    const driver = await driverForTarget(target.id, LOCAL_FOLDER);
    try {
        const upstream = await relayStream(endpoint, streamPath(cameraId, "mp4", "main"));
        if (!upstream.ok || !upstream.body) return null;

        // The stream never ends on its own - it is live - so the clip's length is
        // decided here, by stopping reading. Anything already written stays: half
        // a clip of something happening is worth keeping.
        const reader = upstream.body.getReader();
        let written = 0;
        const stopAt = Date.now() + duration * 1000;
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (Date.now() >= stopAt) {
                    await reader.cancel().catch(() => undefined);
                    controller.close();
                    return;
                }
                const { done, value } = await reader.read();
                if (done || !value) {
                    controller.close();
                    return;
                }
                written += value.byteLength;
                controller.enqueue(value);
            },
            async cancel() {
                await reader.cancel().catch(() => undefined);
            }
        });

        await driver.mkdir(folder).catch(() => undefined);
        // No size given: a live stream has no length, and the drivers take that.
        await driver.writeStream(path, body, { mime: "video/mp4" });
        if (written === 0) {
            await driver.delete(path).catch(() => undefined);
            return null;
        }

        const row = await prisma.cameraClip.create({
            data: {
                cameraId,
                startedAt,
                endedAt: new Date(),
                reason,
                connectionId: target.id === LOCAL_TARGET ? null : target.id,
                path: `${target.id}:${path}`,
                bytes: BigInt(written),
                durationMs: Date.now() - startedAt.getTime()
            }
        });
        return toView(row, camera.name);
    } finally {
        await driver.dispose?.();
    }
}

type ClipRow = Awaited<ReturnType<typeof prisma.cameraClip.create>>;

function toView(row: ClipRow, cameraName: string): ClipView {
    return {
        id: row.id,
        cameraId: row.cameraId,
        cameraName,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        reason: row.reason,
        bytes: Number(row.bytes),
        durationMs: row.durationMs,
        pinned: row.pinned
    };
}

/** The house's footage, newest first, bounded and keyset-paged like the events. */
export async function listClips(
    installedAppId: string,
    query: { cameraId?: string | null; before?: Date | null; limit?: number } = {}
): Promise<ClipView[]> {
    const limit = Math.min(Math.max(query.limit ?? 40, 1), 200);
    const cameras = await prisma.camera.findMany({
        where: { installedAppId, ...(query.cameraId ? { id: query.cameraId } : {}) },
        select: { id: true, name: true }
    });
    if (cameras.length === 0) return [];
    const names = new Map(cameras.map((camera) => [camera.id, camera.name]));
    const rows = await prisma.cameraClip.findMany({
        where: {
            cameraId: { in: [...names.keys()] },
            ...(query.before ? { startedAt: { lt: query.before } } : {})
        },
        orderBy: { startedAt: "desc" },
        take: limit
    });
    return rows.map((row) => toView(row, names.get(row.cameraId) ?? ""));
}

/** Keep this one whatever the retention says, or stop keeping it. */
export async function pinClip(installedAppId: string, id: string, pinned: boolean): Promise<void> {
    const clip = await prisma.cameraClip.findFirst({
        where: { id, camera: { installedAppId } },
        select: { id: true }
    });
    if (!clip) throw new Error("Clip not found");
    await prisma.cameraClip.update({ where: { id }, data: { pinned } });
}

/**
 * Read a clip back for a viewer.
 *
 * A stream rather than a link into the storage: the file may be on a NAS nobody
 * outside the house can reach, and it is footage of somebody's home either way.
 * The range is honored, because without it a browser cannot scrub - it can only
 * play the whole thing from the start.
 */
export async function openClip(
    installedAppId: string,
    id: string,
    range?: { start: number; end?: number }
): Promise<{ stream: ReadableStream<Uint8Array>; bytes: number; dispose: () => Promise<void> } | null> {
    const clip = await prisma.cameraClip.findFirst({
        where: { id, camera: { installedAppId } },
        select: { path: true, bytes: true }
    });
    if (!clip) return null;
    const split = clip.path.indexOf(":");
    if (split <= 0) return null;
    const driver = await driverForTarget(clip.path.slice(0, split), LOCAL_FOLDER);
    try {
        const stream = await driver.readStream(clip.path.slice(split + 1), range);
        return { stream, bytes: Number(clip.bytes), dispose: async () => void (await driver.dispose?.()) };
    } catch {
        await driver.dispose?.();
        return null;
    }
}

/** Remove a clip and its file. */
export async function deleteClip(installedAppId: string, id: string): Promise<void> {
    const clip = await prisma.cameraClip.findFirst({
        where: { id, camera: { installedAppId } },
        select: { id: true, path: true }
    });
    if (!clip) throw new Error("Clip not found");
    await deleteClipFile(clip.path);
    await prisma.cameraClip.delete({ where: { id } });
}

/** Drop a stored file, wherever it went. Best effort: a NAS that is unplugged
 *  this morning must not stop the row being removed, or retention would stall
 *  forever on one unreachable disk. */
export async function deleteClipFile(key: string): Promise<void> {
    const split = key.indexOf(":");
    if (split <= 0) return;
    try {
        const driver = await driverForTarget(key.slice(0, split), LOCAL_FOLDER);
        await driver.delete(key.slice(split + 1)).catch(() => undefined);
        await driver.dispose?.();
    } catch {
        // Unreachable storage; the row goes either way.
    }
}
