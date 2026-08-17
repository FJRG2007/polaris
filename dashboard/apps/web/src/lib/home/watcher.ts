/**
 * Listening to the cameras that do their own looking.
 *
 * This is the cheapest rung of the ladder and the one most houses should stay
 * on: the camera has already decided that something moved - it is doing that
 * whether or not Polaris exists - so Polaris subscribes and reads the decision
 * instead of looking at pixels. A camera on this rung costs one long-poll
 * connection and no CPU at all, which is what makes twenty of them affordable.
 *
 * Everything more expensive than this runs somewhere the owner chose, in the
 * vision worker (dashboard/services/vision), and reports back over HTTP. Nothing
 * in this process ever decodes video.
 *
 * One loop per camera, started when the server comes up and again whenever the
 * camera list changes. A camera that cannot be reached is retried on a slow
 * backoff rather than dropped: a camera that was unplugged for an afternoon
 * should come back on its own.
 */

import { prisma } from "@polaris/db";
import { withinHours } from "@/lib/home/detection";
import { parseDetection, cameraTarget } from "@/lib/home/cameras";
import { recordDetection, type Detection } from "@/lib/home/events";
import { createPullPoint, pullMessages, OnvifError, type OnvifEndpoint } from "@/lib/home/onvif";

/** How long to wait after a camera refuses or disappears, before trying again.
 *  Long: a camera that is off is off, and hammering it helps nobody. */
const RETRY_MS = 60_000;

/** How often the camera list is re-read, so a camera added from a screen starts
 *  being watched without a restart. */
const RESCAN_MS = 30_000;

/** What each ONVIF topic means in the vocabulary events are written in.
 *
 *  Matched loosely on purpose: vendors spell these differently and add their own
 *  ("MyRuleDetector/PeopleDetect"), and the useful question is only which of the
 *  four things it is. Anything unrecognized is movement, which is what it always
 *  is underneath. */
export function kindForTopic(topic: string): Detection["kind"] {
    const text = topic.toLowerCase();
    if (text.includes("people") || text.includes("person") || text.includes("human")) return "person";
    if (text.includes("vehicle") || text.includes("car")) return "vehicle";
    if (text.includes("animal") || text.includes("pet")) return "animal";
    if (text.includes("face")) return "face";
    if (text.includes("tamper")) return "tamper";
    return "motion";
}

interface Watch {
    /** Cancelled when the camera is removed or its settings change. */
    stop: () => void;
    /** What the loop was started for, so a change is noticed. */
    signature: string;
}

const watches = new Map<string, Watch>();
let started = false;

/** Everything about a camera that, if changed, means the loop has to restart. */
function signatureOf(camera: {
    address: string;
    onvifPort: number | null;
    username: string | null;
    detector: string;
    enabled: boolean;
    updatedAt: Date;
}): string {
    return [camera.address, camera.onvifPort, camera.username, camera.detector, camera.enabled, camera.updatedAt.toISOString()].join(
        "|"
    );
}

/**
 * Watch one camera's mailbox until told to stop.
 *
 * The subscription expires unless it is pulled from, and cameras forget them
 * freely, so a lost subscription is not an error - it is asked for again. What
 * counts as an error is the camera refusing, and that backs off.
 */
async function watchCamera(cameraId: string, endpoint: OnvifEndpoint, cancelled: () => boolean): Promise<void> {
    let subscription: string | null = null;
    while (!cancelled()) {
        try {
            if (!subscription) {
                subscription = await createPullPoint(endpoint);
                if (!subscription) {
                    await sleep(RETRY_MS);
                    continue;
                }
            }
            const messages = await pullMessages(endpoint, subscription);
            if (cancelled()) return;
            // The camera reports both the start and the end of what it saw. Only
            // the start is an event; the end is the same thing finishing.
            for (const message of messages.filter((item) => item.active)) {
                await report(cameraId, kindForTopic(message.topic));
            }
        } catch (error) {
            subscription = null;
            // A camera that has forgotten the subscription says so as a fault, and
            // the next pass simply asks for a new one. Anything else waits.
            if (!(error instanceof OnvifError)) await sleep(RETRY_MS);
            else await sleep(2000);
        }
    }
}

/** Write a detection, if the camera's own window says it should be looking. */
async function report(cameraId: string, kind: Detection["kind"]): Promise<void> {
    const camera = await prisma.camera.findFirst({
        where: { id: cameraId },
        select: { detectionConfig: true }
    });
    if (!camera) return;
    // The hours are the owner's, so they are read in the server's local time,
    // which is the clock the house runs on.
    if (!withinHours(parseDetection(camera.detectionConfig), new Date().getHours())) return;
    await recordDetection({ cameraId, kind });
}

/** Wait, without holding the process open. A cancelled watch is noticed by the
 *  check at the top of the loop rather than by cutting the wait short: the
 *  longest anybody waits for a stopped loop to notice is one backoff, and it is
 *  doing nothing in the meantime. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms).unref?.();
    });
}

/** Start, stop and restart the loops so they match what is in the database. */
async function reconcile(): Promise<void> {
    const cameras = await prisma.camera.findMany({
        where: { enabled: true, detector: { notIn: ["none"] }, onvifPort: { not: null } },
        select: {
            id: true,
            address: true,
            onvifPort: true,
            username: true,
            detector: true,
            enabled: true,
            updatedAt: true,
            installedAppId: true
        }
    });
    const wanted = new Map(cameras.map((camera) => [camera.id, camera]));

    for (const [id, watch] of watches) {
        const camera = wanted.get(id);
        if (!camera || watch.signature !== signatureOf(camera)) {
            watch.stop();
            watches.delete(id);
        }
    }

    for (const [id, camera] of wanted) {
        if (watches.has(id)) continue;
        // The credential lives encrypted on the row, and the target is the one
        // thing that decrypts it.
        const target = await cameraTarget(camera.installedAppId, id).catch(() => null);
        if (!target?.onvifPort) continue;
        let stopped = false;
        const watch: Watch = { stop: () => (stopped = true), signature: signatureOf(camera) };
        watches.set(id, watch);
        void watchCamera(
            id,
            {
                address: target.address,
                port: target.onvifPort,
                username: target.username,
                password: target.password
            },
            () => stopped
        ).catch((error) => console.error("polaris: camera watch stopped:", error));
    }
}

/**
 * Begin watching, once per process.
 *
 * Started from instrumentation with everything else that runs on a timer. It
 * does nothing at all on an instance with no cameras, which is every instance
 * that has not installed Home.
 */
export function startCameraWatcher(): void {
    if (started) return;
    started = true;
    const tick = () =>
        void reconcile().catch((error) => console.error("polaris: camera watcher could not reconcile:", error));
    // Not immediately: boot is busy, and a camera that has been unwatched for a
    // week can wait another half minute.
    setTimeout(tick, 20_000).unref();
    setInterval(tick, RESCAN_MS).unref();
}
