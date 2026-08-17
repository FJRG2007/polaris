/**
 * What the cameras saw, written down.
 *
 * Every detector - the camera's own, the movement watcher, the recognizer -
 * arrives here, so there is one place that decides what counts as a new event
 * and what is the same one still happening. That decision is the reason a house
 * is usable: a doorbell with somebody standing at it reports movement forty
 * times a minute, and forty rows an event is a list nobody reads twice.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { parseDetection } from "@/lib/home/cameras";
import { createNotification } from "@/lib/notification-service";
import type { ObjectClass } from "@/lib/home/detection";
import { MOTION_SECONDS, recordClip } from "@/lib/home/recording";

/** What a detector reports. The kinds are the ladder's own vocabulary. */
export interface Detection {
    readonly cameraId: string;
    readonly kind: "motion" | "person" | "vehicle" | "animal" | "face" | "offline" | "tamper";
    /** A name, when the stage that fired can put one to it. */
    readonly label?: string | null;
    /** 0-100, as the detector reported it. */
    readonly score?: number | null;
    /** Where the still was written, in the house's storage. */
    readonly stillKey?: string | null;
    readonly at?: Date;
}

/** Which detections are one of the object classes a camera can be told to care
 *  about. A recognized face is a person, so it is filtered as one - somebody who
 *  turned people off did not mean "except the ones you know". */
const OBJECT_CLASS_OF: Readonly<Partial<Record<Detection["kind"], ObjectClass>>> = {
    person: "person",
    face: "person",
    vehicle: "vehicle",
    animal: "animal"
};

export interface EventView {
    readonly id: string;
    readonly cameraId: string;
    readonly cameraName: string;
    readonly at: string;
    readonly kind: string;
    readonly label: string | null;
    readonly score: number | null;
    readonly stillKey: string | null;
    readonly clipId: string | null;
    readonly acked: boolean;
}

/**
 * Record a detection, unless the same camera already reported the same thing
 * inside its own quiet window.
 *
 * The window is the camera's `minGapSeconds`, which is the knob the owner set
 * for exactly this. Compared per kind rather than per camera: a person arriving
 * while the branches are moving is two different things worth knowing, and
 * collapsing them would drop the one that matters.
 *
 * Returns the event when one was written, and null when it was folded into the
 * one before it - which callers use to decide whether to do the expensive next
 * thing (grab a still, ask who it is).
 */
export async function recordDetection(detection: Detection): Promise<EventView | null> {
    const camera = await prisma.camera.findFirst({
        where: { id: detection.cameraId },
        select: { id: true, name: true, detectionConfig: true, recording: true, installedAppId: true }
    });
    if (!camera) return null;

    const settings = parseDetection(camera.detectionConfig);
    // A camera told to care about people and not about cars should not fill its
    // list with cars, whichever stage saw them - the camera's own alerts included.
    // Movement and the two warnings are never filtered: they are not object
    // classes, and "the camera stopped answering" is not something anybody opted
    // out of.
    const asClass = OBJECT_CLASS_OF[detection.kind];
    if (asClass && !settings.classes.includes(asClass)) return null;

    const gapMs = settings.minGapSeconds * 1000;
    const at = detection.at ?? new Date();
    const recent = await prisma.cameraEvent.findFirst({
        where: { cameraId: camera.id, kind: detection.kind, at: { gt: new Date(at.getTime() - gapMs) } },
        select: { id: true }
    });
    if (recent) return null;

    const row = await prisma.cameraEvent.create({
        data: {
            cameraId: camera.id,
            at,
            kind: detection.kind,
            label: detection.label ?? null,
            score: detection.score ?? null,
            stillKey: detection.stillKey ?? null
        }
    });
    void announce(camera.installedAppId, camera.name, row.id, detection).catch((error) =>
        console.error("polaris: could not report what a camera saw:", error)
    );

    // A camera set to keep footage when something happens keeps it now. Not
    // awaited: the clip is half a minute long, and whoever reported this - a
    // camera's own alert, a worker - is not waiting around for it. The event is
    // pointed at the clip once there is one.
    if (camera.recording === "motion") {
        void recordClip(camera.installedAppId, camera.id, "motion", MOTION_SECONDS)
            .then(async (clip) => {
                if (clip) await prisma.cameraEvent.update({ where: { id: row.id }, data: { clipId: clip.id } });
            })
            .catch((error) => console.error("polaris: could not keep footage of an event:", error));
    }

    return {
        id: row.id,
        cameraId: camera.id,
        cameraName: camera.name,
        at: row.at.toISOString(),
        kind: row.kind,
        label: row.label,
        score: row.score,
        stillKey: row.stillKey,
        clipId: row.clipId,
        acked: false
    };
}

/**
 * Tell somebody, when it is worth telling them.
 *
 * The bar is deliberately high, because an alert that fires on everything is one
 * nobody reads and then does not read on the night it mattered. Movement never
 * qualifies - that is what the list is for. A stranger does, tampering does, and
 * a face only when that person was marked as worth reporting: a household is
 * taught to the recognizer so it STOPS raising alerts, not so every arrival home
 * becomes one.
 *
 * Sent to whoever the house belongs to. Never throws - it is the last thing that
 * happens to an event, and an event that was recorded must not be reported as a
 * failure because a notification could not be written.
 */
async function announce(
    installedAppId: string,
    cameraName: string,
    eventId: string,
    detection: Detection
): Promise<void> {
    if (detection.kind === "motion") return;

    if (detection.kind === "face" && detection.label) {
        const person = await prisma.homePerson.findFirst({
            where: { installedAppId, name: detection.label },
            select: { notify: true }
        });
        if (!person?.notify) return;
    }

    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId },
        select: { ownerId: true }
    });
    if (!install) return;

    const what =
        detection.kind === "face" && detection.label
            ? `${detection.label} is at the ${cameraName}`
            : detection.kind === "tamper"
              ? `The ${cameraName} camera may have been tampered with`
              : detection.kind === "person"
                ? `Somebody is at the ${cameraName}`
                : `A ${detection.kind} at the ${cameraName}`;

    await createNotification({
        userId: install.ownerId,
        type: "home.event",
        title: what,
        href: "/house/events",
        level: detection.kind === "tamper" ? "warning" : "info",
        metadata: { eventId }
    });
}

export interface EventQuery {
    /** One camera, or the whole house. */
    readonly cameraId?: string | null;
    readonly kind?: string | null;
    /** Newest first, from this point back. Keyset rather than an offset: this
     *  table is the one that grows without limit. */
    readonly before?: Date | null;
    readonly limit?: number;
}

/** What happened, newest first. Always bounded. */
export async function listEvents(installedAppId: string, query: EventQuery = {}): Promise<EventView[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    // Scoped through the cameras of this house rather than trusting the id in the
    // request: an event id from anywhere else must not resolve.
    const cameras = await prisma.camera.findMany({
        where: { installedAppId, ...(query.cameraId ? { id: query.cameraId } : {}) },
        select: { id: true, name: true }
    });
    if (cameras.length === 0) return [];
    const names = new Map(cameras.map((camera) => [camera.id, camera.name]));

    const rows = await prisma.cameraEvent.findMany({
        where: {
            cameraId: { in: [...names.keys()] },
            ...(query.kind ? { kind: query.kind } : {}),
            ...(query.before ? { at: { lt: query.before } } : {})
        },
        orderBy: { at: "desc" },
        take: limit,
        select: {
            id: true,
            cameraId: true,
            at: true,
            kind: true,
            label: true,
            score: true,
            stillKey: true,
            clipId: true,
            ackedAt: true
        }
    });
    return rows.map((row) => ({
        id: row.id,
        cameraId: row.cameraId,
        cameraName: names.get(row.cameraId) ?? "",
        at: row.at.toISOString(),
        kind: row.kind,
        label: row.label,
        score: row.score,
        stillKey: row.stillKey,
        clipId: row.clipId,
        acked: row.ackedAt !== null
    }));
}

/** Mark an event as seen, so it stops being one of the things waiting. */
export async function acknowledgeEvent(installedAppId: string, id: string, userId: string): Promise<void> {
    const event = await prisma.cameraEvent.findFirst({
        where: { id, camera: { installedAppId } },
        select: { id: true }
    });
    if (!event) throw new Error("Event not found");
    await prisma.cameraEvent.update({ where: { id }, data: { ackedAt: new Date(), ackedById: userId } });
}

/** How many are still waiting, for the badge. Counted rather than listed: the
 *  number is all the badge needs and the rows are large. */
export async function unacknowledgedCount(installedAppId: string): Promise<number> {
    return prisma.cameraEvent.count({
        where: { camera: { installedAppId }, ackedAt: null }
    });
}
