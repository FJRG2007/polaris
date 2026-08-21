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
import { HomeError } from "@/lib/home/home-error";

import { raiseAlerts } from "@/lib/home/alerts";
import { parseDetection } from "@/lib/home/cameras";
import type { ObjectClass } from "@/lib/home/detection";
import { deleteStill, storeStill } from "@/lib/home/stills";
import { createNotification } from "@/lib/notification-service";
import { MOTION_SECONDS, recordClip } from "@/lib/home/recording";

/** What a detector reports. The kinds are the ladder's own vocabulary. */
export interface Detection {
    readonly cameraId: string;
    readonly kind:
        | "motion"
        | "person"
        | "vehicle"
        | "animal"
        | "package"
        | "face"
        | "offline"
        | "tamper";
    /** A name, when the stage that fired can put one to it. */
    readonly label?: string | null;
    /** 0-100, as the detector reported it. */
    readonly score?: number | null;
    /** Where the still was written, in the house's storage. */
    readonly stillKey?: string | null;
    /** Where in the picture it was, as fractions of the frame. */
    readonly box?: { x1: number; y1: number; x2: number; y2: number } | null;
    /** The areas of the camera it was standing in, by name. */
    readonly zones?: readonly string[];
    /**
     * The detector's handle on the thing it is following.
     *
     * Its presence changes how this is recorded, and that is the point. A
     * detector that follows something across frames has already decided that
     * this is one arrival rather than forty, and decided it with far more to go
     * on than a clock - so the camera's quiet window is not applied to it.
     * Applying both would mean a second person walking up behind the first is
     * dropped for having arrived too soon after them, which is exactly the
     * event nobody wants dropped.
     */
    readonly trackId?: string | null;
    readonly at?: Date;
}

/** Which detections are one of the object classes a camera can be told to care
 *  about. A recognized face is a person, so it is filtered as one - somebody who
 *  turned people off did not mean "except the ones you know". */
const OBJECT_CLASS_OF: Readonly<Partial<Record<Detection["kind"], ObjectClass>>> = {
    person: "person",
    face: "person",
    vehicle: "vehicle",
    animal: "animal",
    package: "package"
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
    /** Where in the picture it was, or null when whatever reported it had no
     *  opinion about position. */
    readonly box: { x1: number; y1: number; x2: number; y2: number } | null;
    readonly zones: readonly string[];
    /** When it stopped being there, for a detector that followed it. */
    readonly endedAt: string | null;
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
        select: {
            id: true,
            name: true,
            placeId: true,
            detectionConfig: true,
            recording: true,
            installedAppId: true
        }
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

    const at = detection.at ?? new Date();

    // A second report about something already being followed is the same event
    // getting better, not another one. The detector sends one when it finds a
    // frame the thing is more recognizable in, which is usually not the frame it
    // was first seen in - so the picture is replaced, the old one is dropped from
    // storage, and nobody is told twice.
    if (detection.trackId) {
        const open = await prisma.cameraEvent.findFirst({
            where: { cameraId: camera.id, trackId: detection.trackId },
            select: { id: true, stillKey: true, zones: true }
        });
        if (open) {
            await prisma.cameraEvent.update({
                where: { id: open.id },
                data: {
                    kind: detection.kind,
                    label: detection.label ?? null,
                    score: detection.score ?? null,
                    ...(detection.stillKey ? { stillKey: detection.stillKey } : {}),
                    ...(detection.box
                        ? {
                              box: JSON.stringify([
                                  detection.box.x1,
                                  detection.box.y1,
                                  detection.box.x2,
                                  detection.box.y2
                              ])
                          }
                        : {}),
                    ...(detection.zones ? { zones: JSON.stringify(detection.zones) } : {})
                }
            });
            if (detection.stillKey && open.stillKey && open.stillKey !== detection.stillKey) {
                await deleteStill(open.stillKey).catch(() => undefined);
            }
            // Somebody who walked up the drive and is now at the door entered
            // the second area minutes after this event was opened, and an area
            // with a waiting time cannot be in the first report at all. The
            // rules that named those areas have never been offered this event,
            // so they are offered it now - and only they, so nobody is told
            // twice about one arrival.
            const already = parseEventZones(open.zones);
            const gained = (detection.zones ?? []).filter((name) => !already.includes(name));
            if (gained.length > 0) {
                void raiseAlerts(
                    camera.installedAppId,
                    detection,
                    open.id,
                    { id: camera.id, name: camera.name, placeId: camera.placeId },
                    gained
                );
            }
            return null;
        }
    }

    if (!detection.trackId) {
        const gapMs = settings.minGapSeconds * 1000;
        const recent = await prisma.cameraEvent.findFirst({
            where: {
                cameraId: camera.id,
                kind: detection.kind,
                at: { gt: new Date(at.getTime() - gapMs) }
            },
            select: { id: true }
        });
        if (recent) return null;
    }

    const row = await prisma.cameraEvent.create({
        data: {
            cameraId: camera.id,
            at,
            kind: detection.kind,
            label: detection.label ?? null,
            score: detection.score ?? null,
            stillKey: detection.stillKey ?? null,
            box: detection.box
                ? JSON.stringify([
                      detection.box.x1,
                      detection.box.y1,
                      detection.box.x2,
                      detection.box.y2
                  ])
                : null,
            zones: JSON.stringify(detection.zones ?? []),
            trackId: detection.trackId ?? null
        }
    });
    // Every event gets a picture. A camera reporting its own movement sends
    // nothing but the fact of it, and a log of lines saying "movement" with no
    // pictures is a log nobody can judge without opening the footage - which for
    // a camera that keeps none is not there either. The relay already holds the
    // connection, so this is one small frame and no second connection.
    if (!detection.stillKey) void attachStill(camera.installedAppId, camera.id, row.id);

    void announce(camera.installedAppId, camera.name, row.id, detection).catch((error) =>
        console.error("polaris: could not report what a camera saw:", error)
    );
    // And anybody who asked to be told about exactly this, in the conversation
    // they will actually see it in. Never awaited and never able to fail the
    // event: the log entry stands whether or not a message could be written.
    void raiseAlerts(camera.installedAppId, detection, row.id, {
        id: camera.id,
        name: camera.name,
        placeId: camera.placeId
    });

    // A camera set to keep footage when something happens keeps it now. Not
    // awaited: the clip is half a minute long, and whoever reported this - a
    // camera's own alert, a worker - is not waiting around for it. The event is
    // pointed at the clip once there is one.
    if (camera.recording === "motion") {
        void recordClip(camera.installedAppId, camera.id, "motion", MOTION_SECONDS)
            .then(async (clip) => {
                if (clip)
                    await prisma.cameraEvent.update({
                        where: { id: row.id },
                        data: { clipId: clip.id }
                    });
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
        box: parseEventBox(row.box),
        zones: parseEventZones(row.zones),
        endedAt: row.endedAt?.toISOString() ?? null,
        clipId: row.clipId,
        acked: false
    };
}

/** A stored box, or null for anything that is not four numbers. Read
 *  defensively: this is drawn over a picture, and a malformed row must be an
 *  event with no box rather than a screen that will not render. */
export function parseEventBox(
    raw: string | null
): { x1: number; y1: number; x2: number; y2: number } | null {
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length !== 4) return null;
        const [x1, y1, x2, y2] = parsed.map(Number);
        if (![x1, y1, x2, y2].every((value) => Number.isFinite(value))) return null;
        return { x1: x1!, y1: y1!, x2: x2!, y2: y2! };
    } catch {
        return null;
    }
}

/** The area names a stored event carried. */
export function parseEventZones(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed.filter((entry): entry is string => typeof entry === "string")
            : [];
    } catch {
        return [];
    }
}

/**
 * Note that the thing an event was opened for has gone.
 *
 * Only ever an update: the event already exists, and this is the second half of
 * its life. A handle that matches nothing is not a failure - it is a detector
 * reporting the end of something whose beginning was folded away or whose
 * camera has since been removed.
 */
export async function closeDetection(cameraId: string, trackId: string, at: Date): Promise<void> {
    await prisma.cameraEvent.updateMany({
        where: { cameraId, trackId, endedAt: null },
        data: { endedAt: at }
    });
}

/**
 * Take a picture of what just happened and put it on the event.
 *
 * Best effort and never awaited: the event is already recorded, and a camera
 * that was too slow to produce a frame is not a reason to have no log entry. A
 * failure leaves the row exactly as it was - with no picture, which is what it
 * had anyway.
 */
async function attachStill(
    installedAppId: string,
    cameraId: string,
    eventId: string
): Promise<void> {
    try {
        const { cameraStill } = await import("@/lib/home/live");
        const image = await cameraStill(installedAppId, cameraId);
        const camera = await prisma.camera.findFirst({
            where: { id: cameraId },
            select: { id: true, storageTarget: true }
        });
        if (!camera) return;
        const stillKey = await storeStill(camera, image);
        await prisma.cameraEvent.update({ where: { id: eventId }, data: { stillKey } });
    } catch {
        // A camera that would not send a frame just now. The line stands.
    }
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

    // Matched on the subject rather than the name: the label a recognizer sends
    // is the subject it filed the photographs under, and somebody renamed here
    // still answers to the one they were taught with. The name is read back at
    // the same time, so the message says what they are called now.
    let known: { name: string; notify: boolean } | null = null;
    if (detection.kind === "face" && detection.label) {
        known = await prisma.homePerson.findFirst({
            where: { installedAppId, subjectId: detection.label },
            select: { name: true, notify: true }
        });
        if (!known?.notify) return;
    }

    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId },
        select: { ownerId: true }
    });
    if (!install) return;

    const what =
        detection.kind === "face" && detection.label
            ? `${known?.name ?? detection.label} is at the ${cameraName}`
            : detection.kind === "tamper"
              ? `The ${cameraName} camera may have been tampered with`
              : detection.kind === "person"
                ? `Somebody is at the ${cameraName}`
                : `A ${detection.kind} at the ${cameraName}`;

    await createNotification({
        userId: install.ownerId,
        type: "home.event",
        title: what,
        href: "/places/events",
        level: detection.kind === "tamper" ? "warning" : "info",
        metadata: { eventId }
    });
}

export interface EventQuery {
    /** One place, or every camera the house has. */
    readonly placeId?: string | null;
    /** One camera, or every camera in scope. */
    readonly cameraId?: string | null;
    readonly kind?: string | null;
    /** One person, by the name the recognizer put to them. The question this
     *  answers - "when was Ana here" - is the one a log is opened for. */
    readonly label?: string | null;
    /** A window to look inside. The other question a log is opened for is
     *  "what happened on Tuesday night", and paging back to it through a month
     *  of movement is not an answer. */
    readonly from?: Date | null;
    readonly to?: Date | null;
    /** Only what was standing in this area, by the name it had when the event
     *  was written. */
    readonly zone?: string | null;
    /** Only what was written against one recording, which is what a player
     *  draws over the footage while it is being watched. */
    readonly clipId?: string | null;
    /** Newest first, from this point back. Keyset rather than an offset: this
     *  table is the one that grows without limit. */
    readonly before?: Date | null;
    readonly limit?: number;
}

/** What happened, newest first. Always bounded. */
export async function listEvents(
    installedAppId: string,
    query: EventQuery = {}
): Promise<EventView[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    // Scoped through the cameras of this house rather than trusting the id in the
    // request: an event id from anywhere else must not resolve.
    const cameras = await prisma.camera.findMany({
        where: {
            installedAppId,
            ...(query.placeId ? { placeId: query.placeId } : {}),
            ...(query.cameraId ? { id: query.cameraId } : {})
        },
        select: { id: true, name: true }
    });
    if (cameras.length === 0) return [];
    const names = new Map(cameras.map((camera) => [camera.id, camera.name]));

    // One `at` clause, because Prisma takes one per field and the window and the
    // page cursor are both about `at` - written separately, the later one wins
    // silently and the filter above it is simply ignored.
    const at: { lt?: Date; gte?: Date; lte?: Date } = {};
    if (query.before) at.lt = query.before;
    if (query.from) at.gte = query.from;
    if (query.to) at.lte = query.to;

    const rows = await prisma.cameraEvent.findMany({
        where: {
            cameraId: { in: [...names.keys()] },
            ...(query.kind ? { kind: query.kind } : {}),
            ...(query.label ? { label: query.label } : {}),
            ...(query.clipId ? { clipId: query.clipId } : {}),
            // The area names are a JSON array in one column, so this is a
            // substring match on the quoted name rather than an index lookup.
            // A table per event per area would be indexable and would be a
            // join, a cascade and a migration for a filter used by hand on a
            // page that is already bounded to a couple of hundred rows.
            ...(query.zone ? { zones: { contains: JSON.stringify(query.zone) } } : {}),
            ...(Object.keys(at).length > 0 ? { at } : {})
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
            box: true,
            zones: true,
            endedAt: true,
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
        box: parseEventBox(row.box),
        zones: parseEventZones(row.zones),
        endedAt: row.endedAt?.toISOString() ?? null,
        clipId: row.clipId,
        acked: row.ackedAt !== null
    }));
}

/** Mark an event as seen, so it stops being one of the things waiting. */
export async function acknowledgeEvent(
    installedAppId: string,
    id: string,
    userId: string
): Promise<void> {
    const event = await prisma.cameraEvent.findFirst({
        where: { id, camera: { installedAppId } },
        select: { id: true }
    });
    if (!event) throw new HomeError("Event not found");
    await prisma.cameraEvent.update({
        where: { id },
        data: { ackedAt: new Date(), ackedById: userId }
    });
}

/**
 * Remove one detection.
 *
 * A false positive is not something to acknowledge, it is something that should
 * not be in the log: a list where every third line is a moth is a list nobody
 * reads. The picture goes with it - keeping a photograph of somebody's doorstep
 * for a row that has been deleted is the wrong half to keep.
 */
export async function deleteEvent(installedAppId: string, id: string): Promise<void> {
    const event = await prisma.cameraEvent.findFirst({
        where: { id, camera: { installedAppId } },
        select: { id: true, stillKey: true }
    });
    if (!event) throw new HomeError("Event not found");
    if (event.stillKey) await deleteStill(event.stillKey);
    await prisma.cameraEvent.delete({ where: { id } });
}

/**
 * Remove everything a filter matched.
 *
 * The one that matters after a windy night: forty rows of the same hedge, and
 * removing them one at a time is why they get left there instead. Bounded, and
 * it only ever removes what the screen was showing.
 */
export async function deleteEvents(installedAppId: string, query: EventQuery): Promise<number> {
    const doomed = await listEvents(installedAppId, { ...query, limit: 200 });
    for (const event of doomed) {
        if (event.stillKey) await deleteStill(event.stillKey);
    }
    if (doomed.length === 0) return 0;
    await prisma.cameraEvent.deleteMany({ where: { id: { in: doomed.map((event) => event.id) } } });
    return doomed.length;
}

/** How many are still waiting, for the badge. Counted rather than listed: the
 *  number is all the badge needs and the rows are large. */
export async function unacknowledgedCount(installedAppId: string): Promise<number> {
    return prisma.cameraEvent.count({
        where: { camera: { installedAppId }, ackedAt: null }
    });
}
