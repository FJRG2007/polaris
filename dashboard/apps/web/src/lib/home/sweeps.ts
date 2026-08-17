/**
 * The two things the house does on a timer.
 *
 * Keeping a camera that records all day recording, and getting rid of what
 * nobody asked to keep. The second one matters more than it sounds: footage is
 * the only part of Home that grows whether or not anybody uses it, and a
 * recorder with no retention is a disk that fills silently and then takes
 * something else down with it.
 *
 * Server-only. Called by the scheduler; safe to re-run.
 */

import { prisma } from "@polaris/db";
import { deleteStill } from "@/lib/home/stills";
import { SEGMENT_SECONDS, deleteClipFile, recordClip } from "@/lib/home/recording";

/** Segments in flight in this process, so a pass that comes round while a
 *  five-minute segment is still being written does not start a second one on the
 *  same camera. */
const recording = new Set<string>();

/** How long an event is kept when its camera keeps no footage at all. A row is
 *  small, but "everything since 2026" is still a list nobody can read and an
 *  index that stops fitting in memory. */
const EVENT_DAYS = 90;

/**
 * Keep the cameras that record continuously recording.
 *
 * Each pass tops up: a camera with no segment in flight starts one. The segment
 * ends on its own, and the next pass starts the next one - so a restart loses at
 * most the tail of one segment rather than the day.
 */
export async function sweepContinuousRecording(): Promise<{ started: number }> {
    const cameras = await prisma.camera.findMany({
        where: { enabled: true, recording: "continuous" },
        select: { id: true, installedAppId: true }
    });
    let started = 0;
    for (const camera of cameras) {
        if (recording.has(camera.id)) continue;
        recording.add(camera.id);
        started += 1;
        void recordClip(camera.installedAppId, camera.id, "continuous", SEGMENT_SECONDS)
            .catch((error) => console.error("polaris: a camera segment failed:", error))
            .finally(() => recording.delete(camera.id));
    }
    return { started };
}

/**
 * Drop what is past its keeping.
 *
 * Per camera, because the retention is per camera: a doorbell and a garage do
 * not deserve the same month. Pinned clips are never dropped - that is what
 * pinning is for - and the file is removed before the row, so a failure leaves a
 * row pointing at a file rather than a file nothing points at.
 */
export async function sweepHomeRetention(): Promise<{ clips: number; events: number }> {
    const cameras = await prisma.camera.findMany({ select: { id: true, retentionDays: true } });
    let clips = 0;
    for (const camera of cameras) {
        const cutoff = new Date(Date.now() - camera.retentionDays * 24 * 60 * 60 * 1000);
        // Bounded per pass. A house coming back from a month of downtime should
        // catch up over a few passes rather than in one transaction that holds
        // the storage open for an hour.
        const due = await prisma.cameraClip.findMany({
            where: { cameraId: camera.id, pinned: false, startedAt: { lt: cutoff } },
            orderBy: { startedAt: "asc" },
            take: 200,
            select: { id: true, path: true }
        });
        for (const clip of due) {
            await deleteClipFile(clip.path);
            await prisma.cameraClip.delete({ where: { id: clip.id } });
            clips += 1;
        }
    }

    // Events outlive their footage on purpose: knowing that somebody was at the
    // door on the 3rd is worth having after the video of it has gone.
    const eventCutoff = new Date(Date.now() - EVENT_DAYS * 24 * 60 * 60 * 1000);
    const oldEvents = await prisma.cameraEvent.findMany({
        where: { at: { lt: eventCutoff } },
        orderBy: { at: "asc" },
        take: 500,
        select: { id: true, stillKey: true }
    });
    for (const event of oldEvents) {
        if (event.stillKey) await deleteStill(event.stillKey);
    }
    if (oldEvents.length > 0) {
        await prisma.cameraEvent.deleteMany({ where: { id: { in: oldEvents.map((event) => event.id) } } });
    }
    return { clips, events: oldEvents.length };
}
