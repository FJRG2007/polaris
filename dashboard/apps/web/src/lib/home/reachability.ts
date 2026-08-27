/**
 * Whether the cameras are still there.
 *
 * A camera that stops answering is the one thing in Places that nothing else
 * reports. Everything here is driven by what a camera sees, so a camera that has
 * gone quiet looks exactly like a quiet night: the wall draws a tile that never
 * refreshes, the log simply stops, and nobody finds out until they go looking -
 * which, for the camera pointed at the door, is the moment they most needed it.
 *
 * That silence has a short list of causes and they are not equally interesting.
 * The power went, the network went, the recorder was unplugged, somebody cut a
 * cable. Polaris cannot tell those apart from the outside, and pretending
 * otherwise would be inventing a diagnosis - but it CAN tell apart the shape of
 * them, and the shape is the whole signal. Everything at a place going quiet at
 * once is the building: the power, the switch, the uplink. One camera going
 * quiet while the ones beside it keep answering is that camera, and that is the
 * one worth waking somebody for.
 *
 * So an outage is reported with a count rather than a cause: "4 of 4 at Home" or
 * "the only one of 4". Nobody is told what happened, which is not knowable from
 * here; they are told the one fact that decides whether to go and look.
 *
 * Server-only. Run from the scheduler, and safe to re-run.
 */

import { prisma } from "@polaris/db";

import { isMuted } from "@polaris/core";
import { raiseAlerts, type Said } from "@/lib/home/alerts";
import { notify } from "@/lib/notifications/dispatch";
import { ruleFor } from "@/lib/notifications/preferences";
import { OFFLINE_GRACE_MS } from "@/lib/home/availability";
import {
    publishedStreams,
    relayEndpoint,
    relayServerFor,
    snapshot,
    streamName,
    type RelayEndpoint
} from "@/lib/home/relay";

/** How long to wait on a camera before calling it quiet. Longer than an ordinary
 *  still, because a camera that has been asleep takes a moment to wake and there
 *  is nobody waiting on this. */
const PROBE_TIMEOUT_MS = 10_000;

/** Which of a camera's two streams is asked for a frame. The small one: nothing
 *  looks at this picture. It is also the one the gate below checks the relay is
 *  holding, so what is asked for and what is required to exist are the same. */
const PROBE_QUALITY = "sub" as const;

/** One camera, as this pass needs it. */
interface Watched {
    readonly id: string;
    readonly name: string;
    readonly placeId: string | null;
    readonly installedAppId: string;
    readonly reachVia: string;
    readonly offlineSince: Date | null;
}

/** What one pass did, for the scheduler's log and for the tests. */
export interface ReachabilitySweep {
    /** Cameras asked. */
    readonly probed: number;
    /** Outages reported in this pass, which is not the number that are down. */
    readonly reported: number;
    /** Cameras that answered again after being down. */
    readonly recovered: number;
}

/**
 * Ask one camera for a frame.
 *
 * Through the relay, like everything else: the camera has one connection to give
 * and the relay already holds it, so this costs a cached frame while somebody is
 * watching and one short dial while nobody is. The smallest stream and no width,
 * because nothing looks at this picture - the only question is whether one
 * arrived.
 */
async function answers(endpoint: RelayEndpoint, cameraId: string): Promise<boolean> {
    const frame = await snapshot(endpoint, cameraId, PROBE_QUALITY, {
        // Whatever the wall was just shown is proof enough that the camera is
        // answering, and it saves a decode on a house somebody is watching.
        cacheMs: 5000
    }).catch(() => null);
    return frame !== null && frame.length > 0;
}

/** One relay, and what it is currently serving. */
interface Relay {
    readonly endpoint: RelayEndpoint;
    /**
     * The stream names it holds, or null when it could not be asked.
     *
     * Null is deliberately NOT an empty set. A relay that is down answers
     * nothing, and reading that as "no camera was ever published here" would
     * silence the pass at the exact moment every camera behind it went
     * unwatchable - so an unanswering relay falls through to probing, and its
     * cameras are reported the way they would be if each had gone on its own.
     */
    readonly serving: ReadonlySet<string> | null;
}

/**
 * The relay for each server that holds one of these cameras, resolved once,
 * along with the streams it is currently serving.
 *
 * A house with no relay yet has never had a camera opened, so there is nothing
 * to ask and nothing has stopped: those cameras are left out of the pass rather
 * than reported as down. Installing one from here would be a deploy nobody
 * asked for, on a timer.
 */
async function relaysFor(cameras: readonly Watched[]): Promise<Map<string, Relay>> {
    const servers = [...new Set(cameras.map((camera) => relayServerFor(camera.reachVia)))];
    const found = new Map<string, Relay>();
    await Promise.all(
        servers.map(async (server) => {
            const endpoint = await relayEndpoint(server).catch(() => null);
            if (!endpoint) return;
            const streams = await publishedStreams(endpoint).catch(() => null);
            found.set(server, { endpoint, serving: streams ? new Set(streams) : null });
        })
    );
    return found;
}

/**
 * How to say an outage, given how much of the place it covers.
 *
 * The count is the diagnosis, so it is in the sentence rather than in a detail
 * somebody has to open. Written here and read twice - the message in the
 * conversation and the line in the bell say the same thing.
 */
export function outageHeadline(
    cameraName: string,
    placeName: string,
    down: number,
    total: number
): string {
    const where = placeName ? ` at ${placeName}` : "";
    if (total > 1 && down >= total) return `Every camera${where} stopped answering`;
    if (total > 1 && down === 1) return `${cameraName} stopped answering - the only one of ${total}${where}`;
    if (total > 1) return `${cameraName} stopped answering - ${down} of ${total}${where} have`;
    return `${cameraName} stopped answering`;
}

/** How long it was gone, in the words somebody would use. Read off the row
 *  rather than counted in passes, so a restart does not reset it. */
export function outageLength(since: Date, until: Date): string {
    const minutes = Math.max(1, Math.round((until.getTime() - since.getTime()) / 60_000));
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Whether this outage has already been written down.
 *
 * Derived from the events rather than kept in a column of its own: the row that
 * records the outage is the record that it was reported, and one fewer piece of
 * state is one fewer way for the two to disagree after a restart.
 */
async function alreadyReported(cameraId: string, since: Date): Promise<boolean> {
    const existing = await prisma.cameraEvent.findFirst({
        where: { cameraId, kind: "offline", at: { gte: since } },
        select: { id: true }
    });
    return existing !== null;
}

/**
 * Write the outage down and tell whoever asked to be told.
 *
 * The event is written first and never conditionally: the log is the record, and
 * it has to stand whether or not a message could be delivered. `endedAt` is left
 * open, which is what makes the row mean "still down" until the camera answers.
 *
 * The row is per camera and the message is not. Four cameras behind one switch
 * losing power is four rows in the log, which is what happened, and one sentence
 * to read, because the sentence they would each carry is the same one - the
 * count in it is already the whole of what a place-wide outage has to say. Four
 * copies of it is the alert fatigue the grace window exists to prevent.
 */
async function reportOutage(
    camera: Watched,
    since: Date,
    placeName: string,
    down: number,
    total: number,
    said: Said
): Promise<void> {
    const headline = outageHeadline(camera.name, placeName, down, total);
    const event = await prisma.cameraEvent.create({
        data: {
            cameraId: camera.id,
            at: since,
            kind: "offline",
            // What the log line says, so the events list reads as a sentence
            // rather than as the word "offline" beside a camera name.
            label: headline
        }
    });

    // A rule somebody wrote for exactly this. An outage carries no areas and no
    // picture, so a rule that names areas can never match one - which the rule
    // matcher already handles and which is the right answer: that rule asked a
    // question a camera which is not answering cannot answer.
    //
    // Awaited rather than left running: the batch is what stops a rule matching
    // every camera at a place from posting the same line once per camera, and it
    // can only do that if the calls take their turn.
    await raiseAlerts(
        camera.installedAppId,
        { cameraId: camera.id, kind: "offline", label: headline },
        event.id,
        { id: camera.id, name: camera.name, placeId: camera.placeId },
        undefined,
        said
    );

    await tell(camera.installedAppId, headline, "A camera is not answering", event.id, said);
}

/**
 * And the same when it comes back.
 *
 * Worth saying on its own: somebody who was told at three in the morning that
 * the house went dark should not have to open Polaris at eight to find out
 * whether it is still dark. The open event is closed rather than a second one
 * written, so the log has one line per outage with a length on it.
 */
async function reportRecovery(camera: Watched, since: Date, now: Date, said: Said): Promise<void> {
    const open = await prisma.cameraEvent.findFirst({
        where: { cameraId: camera.id, kind: "offline", endedAt: null, at: { gte: since } },
        select: { id: true },
        orderBy: { at: "desc" }
    });
    // Nothing was ever reported, so this was a blip inside the grace window and
    // there is nothing to close and nobody to tell.
    if (!open) return;

    await prisma.cameraEvent.update({ where: { id: open.id }, data: { endedAt: now } });
    await tell(
        camera.installedAppId,
        `${camera.name} is answering again`,
        `It was quiet for ${outageLength(since, now)}`,
        open.id,
        said
    );
}

/** The bell, for whoever the house belongs to. Asked here rather than left to
 *  the dispatcher to drop, for the same reason a sighting is - a muted event
 *  that still writes a delivery line is a history nobody can read. */
async function tell(
    installedAppId: string,
    title: string,
    body: string,
    eventId: string,
    said: Said
): Promise<void> {
    // One line per sentence per pass. The dispatcher does not deduplicate, so a
    // place that went dark all at once would otherwise leave one bell entry per
    // camera, every one of them reading "Every camera at Home stopped answering".
    const line = `${installedAppId}:${title}`;
    if (said.has(line)) return;
    said.add(line);
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId },
        select: { ownerId: true }
    });
    if (!install) return;
    if (isMuted(await ruleFor(install.ownerId, "places.offline"))) return;
    await notify({
        userId: install.ownerId,
        event: "places.offline",
        title,
        body,
        href: `/places/events?event=${eventId}`,
        metadata: { eventId }
    });
}

/**
 * One pass over every camera that is switched on.
 *
 * The whole install at once rather than a place at a time, because the count
 * that makes an outage readable is a count across the place and the pass has to
 * have asked all of them before it can say "4 of 4".
 *
 * Never throws: this runs on a timer with nobody watching, and one camera whose
 * relay is having a bad minute must not stop the other eleven being checked.
 */
export async function sweepCameraReachability(): Promise<ReachabilitySweep> {
    const cameras: Watched[] = await prisma.camera.findMany({
        where: { enabled: true },
        select: {
            id: true,
            name: true,
            placeId: true,
            installedAppId: true,
            reachVia: true,
            offlineSince: true
        }
    });
    if (cameras.length === 0) return { probed: 0, reported: 0, recovered: 0 };

    const relays = await relaysFor(cameras);
    const now = new Date();

    // Asked in parallel: a house of twelve cameras where three are down would
    // otherwise spend half a minute in this pass waiting on timeouts one after
    // another, and the pass runs every minute.
    const results = await Promise.all(
        cameras.map(async (camera) => {
            const relay = relays.get(relayServerFor(camera.reachVia));
            // No relay for this camera's network yet, so nothing here has ever
            // reached it and its silence says nothing.
            if (!relay) return { camera, reachable: null as boolean | null };
            // Nor has anything reached a camera the relay was never given. A
            // camera saved with the wrong password fails to start and no stream
            // is ever made for it, so the relay answers "no such source" for the
            // same reason it would for a camera that had gone dark - and telling
            // somebody a camera they have never seen a picture from has "stopped
            // answering" is both wrong and the thing they can least act on.
            if (relay.serving && !relay.serving.has(streamName(camera.id, PROBE_QUALITY)))
                return { camera, reachable: null as boolean | null };
            const reachable = await withTimeout(answers(relay.endpoint, camera.id));
            return { camera, reachable };
        })
    );

    const asked = results.filter(
        (result): result is { camera: Watched; reachable: boolean } => result.reachable !== null
    );
    // How much of each place is down, counted across everything this pass asked -
    // which is what turns "a camera stopped" into "the building went dark".
    const downAt = new Map<string, number>();
    const totalAt = new Map<string, number>();
    for (const { camera, reachable } of asked) {
        const key = camera.placeId ?? "";
        totalAt.set(key, (totalAt.get(key) ?? 0) + 1);
        if (!reachable) downAt.set(key, (downAt.get(key) ?? 0) + 1);
    }
    const placeNames = await namesOf([...totalAt.keys()].filter(Boolean));

    let reported = 0;
    let recovered = 0;
    // What this pass has already said, so a place that went dark all at once is
    // one sentence rather than one per camera.
    const said: Said = new Set();
    for (const { camera, reachable } of asked) {
        try {
            if (reachable) {
                // Closed before the column that says it is open is cleared. The
                // other order loses the outage for good if this throws: the next
                // pass reads `offlineSince` as null, never tries again, and the
                // row keeps `endedAt: null` forever - an outage that reads as
                // still in progress on a camera that came back hours ago.
                if (camera.offlineSince) {
                    await reportRecovery(camera, camera.offlineSince, now, said);
                    recovered += 1;
                }
                await prisma.camera.update({
                    where: { id: camera.id },
                    data: { lastSeenAt: now, offlineSince: null }
                });
                continue;
            }

            // The first miss only starts the clock. Nobody is told until the
            // camera has been quiet for longer than everything ordinary takes.
            if (!camera.offlineSince) {
                await prisma.camera.update({
                    where: { id: camera.id },
                    data: { offlineSince: now }
                });
                continue;
            }
            if (now.getTime() - camera.offlineSince.getTime() < OFFLINE_GRACE_MS) continue;
            if (await alreadyReported(camera.id, camera.offlineSince)) continue;

            const key = camera.placeId ?? "";
            await reportOutage(
                camera,
                camera.offlineSince,
                placeNames.get(key) ?? "",
                downAt.get(key) ?? 1,
                totalAt.get(key) ?? 1,
                said
            );
            reported += 1;
        } catch (error) {
            console.error("polaris: could not record a camera's availability:", error);
        }
    }

    return { probed: asked.length, reported, recovered };
}

async function namesOf(placeIds: readonly string[]): Promise<Map<string, string>> {
    if (placeIds.length === 0) return new Map();
    const rows = await prisma.place.findMany({
        where: { id: { in: [...placeIds] } },
        select: { id: true, name: true }
    });
    return new Map(rows.map((row) => [row.id, row.name]));
}

/** A probe that cannot hang the pass. The relay has its own timeout on getting a
 *  response started; this is the backstop for the case where it answers and then
 *  never finishes. */
async function withTimeout(probe: Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            probe,
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
