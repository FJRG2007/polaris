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
import { loadEnv } from "@polaris/config";
import { listHosts } from "@/lib/host-service";
import { homeInstall } from "@/lib/home/access";
import { hostPortForApp } from "@/lib/deploy-service";
import { appBaseUrl, getPublicIp } from "@/lib/domain-service";
import { parseDetection } from "@/lib/home/cameras";
import { installApp } from "@/lib/apps/install-service";
import { createHash, timingSafeEqual } from "node:crypto";
import { installEnvSecret } from "@/lib/apps/install-secret";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { relayEndpoint, relayServerFor, streamName } from "@/lib/home/relay";
import { detectorReaches, type Detector, type ObjectClass } from "@/lib/home/detection";

const VISION_APP = "vision-worker";
const FACE_APP = "compreface";

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
    /** Whether to go past movement, and how far. */
    readonly detector: Detector;
    readonly classes: readonly ObjectClass[];
    /** Hours it is on, in the house's local time. Null is all day. */
    readonly hours: { from: number; to: number } | null;
    /** Where to ask who somebody is, when the camera reaches that rung. */
    readonly faces: { readonly baseUrl: string; readonly apiKey: string; readonly threshold: number } | null;
}

/** The secret the house keeps for itself, on the install row. Today it is only
 *  the recognition key - a key CompreFace mints in its own interface, so it is
 *  pasted rather than generated, and it is not going in a settings table in the
 *  clear. */
interface HomeSecrets {
    faceApiKey?: string;
}

async function readSecrets(installedAppId: string): Promise<HomeSecrets> {
    const row = await prisma.installedApp.findFirst({
        where: { id: installedAppId },
        select: { encryptedSecret: true, secretNonce: true, secretKeyId: true }
    });
    if (!row?.encryptedSecret || !row.secretNonce || !row.secretKeyId) return {};
    try {
        return JSON.parse(
            decryptSecret(
                {
                    ciphertext: Buffer.from(row.encryptedSecret),
                    nonce: Buffer.from(row.secretNonce),
                    keyId: row.secretKeyId
                },
                loadEnv().POLARIS_MASTER_KEY
            )
        ) as HomeSecrets;
    } catch {
        return {};
    }
}

/** Keep the recognition key. Empty clears it, which is how somebody turns face
 *  recognition off without uninstalling anything. */
export async function setFaceApiKey(installedAppId: string, apiKey: string): Promise<void> {
    const secrets = { ...(await readSecrets(installedAppId)), faceApiKey: apiKey.trim() || undefined };
    const blob = encryptSecret(JSON.stringify(secrets), loadEnv().POLARIS_MASTER_KEY);
    await prisma.installedApp.update({
        where: { id: installedAppId },
        data: { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId }
    });
}

/** Whether the house has been given a recognition key at all, for the screen
 *  that asks for one. The key itself never goes back to a browser. */
export async function hasFaceApiKey(installedAppId: string): Promise<boolean> {
    return Boolean((await readSecrets(installedAppId)).faceApiKey);
}

/** Where the recognizer answers, and the key for it. Null when either half is
 *  missing, which is what makes the face rung unavailable rather than broken. */
async function faceRecognition(installedAppId: string): Promise<{ baseUrl: string; apiKey: string } | null> {
    const { faceApiKey } = await readSecrets(installedAppId);
    if (!faceApiKey) return null;
    const install = await prisma.installedApp.findFirst({
        where: { catalogId: FACE_APP, status: { not: "removed" }, applicationId: { not: null } },
        select: { applicationId: true }
    });
    if (!install?.applicationId) return null;
    const application = await prisma.application.findFirst({
        where: { id: install.applicationId },
        select: { target: { select: { kind: true, host: { select: { address: true } } } } }
    });
    if (!application) return null;
    const host =
        application.target.kind === "local" ? await getPublicIp() : (application.target.host?.address?.trim() ?? null);
    if (!host) return null;
    return { baseUrl: `http://${host}:${hostPortForApp(install.applicationId)}`, apiKey: faceApiKey };
}

/** Where the recognizer is, for the house that has one. The people screen and
 *  the assignment builder both need it, and neither should have to know which
 *  install the house is. */
export async function faceEndpoint(): Promise<{ baseUrl: string; apiKey: string } | null> {
    const install = await homeInstall();
    return install ? faceRecognition(install.id) : null;
}

/** The vision worker running on one server, or null when there is not one. */
async function findWorker(serverId: string): Promise<{ applicationId: string; ownerId: string } | null> {
    const targetId =
        serverId === "local"
            ? (await prisma.deployTarget.findFirst({ where: { kind: "local" }, select: { id: true } }))?.id
            : (await prisma.deployTarget.findFirst({ where: { hostId: serverId }, select: { id: true } }))?.id;
    const row = await prisma.installedApp.findFirst({
        where: {
            catalogId: VISION_APP,
            status: { not: "removed" },
            applicationId: { not: null },
            ...(targetId ? { targetId } : {})
        },
        select: { applicationId: true, ownerId: true }
    });
    return row?.applicationId ? { applicationId: row.applicationId, ownerId: row.ownerId } : null;
}

/**
 * Put a worker on a server, if the cameras pointed at it need one.
 *
 * Installing is a deploy, so this belongs behind an action somebody pressed
 * rather than on a render path. It is idempotent: a server that already has one
 * keeps it.
 */
export async function ensureVisionWorker(ownerId: string, actorId: string, serverId: string): Promise<void> {
    if (await findWorker(serverId)) return;
    if (serverId !== "local") {
        const hosts = await listHosts(ownerId);
        if (!hosts.some((host) => host.id === serverId)) throw new Error("That server is not connected");
    }
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
        const key = await installEnvSecret(worker.applicationId as string, worker.ownerId, "WORKER_KEY");
        if (key && timingSafeEqual(digest(presented), digest(key))) return { ownerId: worker.ownerId };
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

    const faces = await faceRecognition(installedAppId);
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
            streamUrl: `${endpoint.baseUrl}/api/stream.mp4?src=${encodeURIComponent(streamName(camera.id, "sub"))}`,
            authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64")}`,
            sensitivity: detection.sensitivity,
            minGapSeconds: detection.minGapSeconds,
            detector,
            classes: detection.classes,
            hours: detection.hours,
            faces:
                faces && detectorReaches(detector, "faces")
                    ? { ...faces, threshold: detection.faceThreshold }
                    : null
        });
    }
    return assignments;
}
