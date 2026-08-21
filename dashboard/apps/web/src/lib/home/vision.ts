/**
 * The work that cannot be done for free, and the machine that was chosen for it.
 *
 * Anything above the camera's own alerts means looking at pixels, and looking at
 * pixels is the one thing this process must never do: it is the dashboard, and a
 * dashboard that decodes video is a dashboard that stops answering. So it runs in
 * a worker, on the machine the owner picked per camera, and reports back over
 * HTTP - the same shape as the messaging bridge.
 *
 * What the worker is told is deliberately small: which streams to watch, how
 * sensitive to be, how long to wait between detections, and where to ask who
 * somebody is. It never learns a camera's address or password - it reads the
 * stream from the relay, which already holds the one connection.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { appBaseUrl } from "@/lib/domain-service";
import { recognizerFor } from "@/lib/home/recognizer";
import { parseDetection } from "@/lib/home/cameras";
import { zonesByCamera } from "@/lib/home/camera-zones";
import type { Zone } from "@polaris/core";
import { installApp } from "@/lib/apps/install-service";
import { createHash, timingSafeEqual } from "node:crypto";
import { installEnvSecret } from "@/lib/apps/install-secret";
import { assertServer, findService } from "@/lib/home/side-service";
import { relayEndpoint, relayServerFor, streamName } from "@/lib/home/relay";
import { detectorReaches, type Detector, type ObjectClass } from "@/lib/home/detection";

const VISION_APP = "vision-worker";

/** What one camera's worker is told to do. */
export interface VisionAssignment {
    readonly cameraId: string;
    readonly cameraName: string;
    /** The small stream, on the relay. Never the camera itself. */
    readonly streamUrl: string;
    /** What the worker sends to get at it. */
    readonly authorization: string;
    /** How much has to change before it counts, 1-100. */
    readonly sensitivity: number;
    /** The shortest gap between two detections on this camera, in seconds. This
     *  is what bounds the cost of the whole thing. */
    readonly minGapSeconds: number;
    /** How long movement has to last before it counts, which is what keeps a
     *  moth and a gust out of the log. */
    readonly settleSeconds: number;
    /** Whether to go past movement, and how far. */
    readonly detector: Detector;
    readonly classes: readonly ObjectClass[];
    /** Hours it is on, in the house's local time. Null is all day. */
    readonly hours: { from: number; to: number } | null;
    /** The areas drawn on this camera. The worker masks the ignored ones out of
     *  movement itself, and tests everything it detects against the watched
     *  ones - so an area is applied where the pixels are rather than after the
     *  event has already been written. */
    readonly zones: readonly Zone[];
    /** Where to ask who somebody is, when the camera reaches that rung. */
    readonly faces: {
        readonly baseUrl: string;
        readonly apiKey: string;
        readonly threshold: number;
    } | null;
}

/** The vision worker running on one server, or null when there is not one. */
async function findWorker(serverId: string) {
    return findService(VISION_APP, serverId);
}

/**
 * Put a worker on a server, if the cameras pointed at it need one.
 *
 * Installing is a deploy, so this belongs behind an action somebody pressed
 * rather than on a render path. It is idempotent: a server that already has one
 * keeps it.
 */
export async function ensureVisionWorker(
    ownerId: string,
    actorId: string,
    serverId: string
): Promise<void> {
    if (await findWorker(serverId)) return;
    await assertServer(ownerId, serverId);
    await installApp(ownerId, actorId, {
        catalogId: VISION_APP,
        name: "Vision worker",
        serverId,
        storage: [],
        // The worker asks Polaris what to watch, so the one thing it has to be
        // told is where Polaris is. Its key is minted by the install.
        env: [{ key: "POLARIS_URL", value: await appBaseUrl() }]
    });
}

/**
 * Whether a request is from one of this instance's vision workers.
 *
 * Compared against every worker's own key rather than one shared secret: a house
 * can have a worker per machine, and a key that leaks from one should not be a
 * key to the others. Digested before comparing so the comparison is over two
 * buffers of equal length whatever was presented.
 */
export async function authorizeWorker(request: Request): Promise<{ ownerId: string } | null> {
    const header = request.headers.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!presented) return null;
    const workers = await prisma.installedApp.findMany({
        where: { catalogId: VISION_APP, status: { not: "removed" }, applicationId: { not: null } },
        select: { applicationId: true, ownerId: true }
    });
    const digest = (value: string) => createHash("sha256").update(value).digest();
    for (const worker of workers) {
        const key = await installEnvSecret(
            worker.applicationId as string,
            worker.ownerId,
            "WORKER_KEY"
        );
        if (key && timingSafeEqual(digest(presented), digest(key)))
            return { ownerId: worker.ownerId };
    }
    return null;
}

/**
 * What every camera that needs a worker should be watched for.
 *
 * Not filtered by which worker is asking. A house has one or two of these and
 * the assignment is small; splitting the list by machine would mean the worker's
 * identity has to be resolved to a server, and the failure mode of getting that
 * wrong is a camera nobody watches. Two workers watching one camera write the
 * same detections, and the quiet window folds the duplicate away.
 */
export async function assignmentsFor(installedAppId: string): Promise<VisionAssignment[]> {
    const cameras = await prisma.camera.findMany({
        where: { installedAppId, enabled: true, detector: { in: ["motion", "objects", "faces"] } },
        select: {
            id: true,
            name: true,
            detector: true,
            detectionConfig: true,
            reachVia: true
        }
    });
    if (cameras.length === 0) return [];

    const faces = await recognizerFor(installedAppId);
    // One query for the whole house rather than one per camera: the answer is
    // small and a house with twenty cameras should not cost twenty round trips
    // to say what was drawn on them.
    const zones = await zonesByCamera(installedAppId);
    const assignments: VisionAssignment[] = [];
    for (const camera of cameras) {
        const endpoint = await relayEndpoint(relayServerFor(camera.reachVia));
        // A camera whose relay is not up yet is not an assignment: the worker
        // would only fail to connect, on a loop.
        if (!endpoint) continue;
        const detection = parseDetection(camera.detectionConfig);
        const detector = camera.detector as Detector;
        assignments.push({
            cameraId: camera.id,
            cameraName: camera.name,
            // The worker runs beside the relay, so it is given the relay's real
            // address rather than the one Polaris dials it on - a tunnel that
            // only exists inside the Polaris process reaches nothing from there.
            streamUrl: `${endpoint.directUrl}/api/stream.mp4?src=${encodeURIComponent(streamName(camera.id, "sub"))}`,
            authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64")}`,
            sensitivity: detection.sensitivity,
            minGapSeconds: detection.minGapSeconds,
            settleSeconds: detection.settleSeconds,
            detector,
            classes: detection.classes,
            hours: detection.hours,
            zones: zones.get(camera.id) ?? [],
            faces:
                faces && detectorReaches(detector, "faces")
                    ? // The recognizer is usually a container beside it, and is
                      // addressed the same way and for the same reason.
                      {
                          baseUrl: faces.networkUrl ?? faces.directUrl,
                          apiKey: faces.apiKey,
                          threshold: detection.faceThreshold
                      }
                    : null
        });
    }
    return assignments;
}
