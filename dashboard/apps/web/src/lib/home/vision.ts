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
import { appBaseUrl } from "@/lib/domain-service";
import { parseDetection } from "@/lib/home/cameras";
import { installApp } from "@/lib/apps/install-service";
import { createHash, timingSafeEqual } from "node:crypto";
import { installEnvSecret } from "@/lib/apps/install-secret";
import { decryptSecret, encryptSecret } from "@polaris/storage";
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
    /** Where to ask who somebody is, when the camera reaches that rung. */
    readonly faces: { readonly baseUrl: string; readonly apiKey: string; readonly threshold: number } | null;
}

/**
 * What the house keeps for itself, on the install row.
 *
 * The recognizer is connected rather than installed. Polaris deploys single
 * containers, and CompreFace is five of them with a database - so it is run the
 * way its own project says to run it, and Home is told where it ended up. The
 * key it mints in its own interface is a credential to a service that holds
 * faces, so it lives encrypted here rather than in a settings table in the clear.
 */
interface HomeSecrets {
    faceApiUrl?: string;
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

/**
 * Point the house at a recognizer, or unpoint it.
 *
 * A blank address or a blank key clears the pairing, which is how face
 * recognition is switched off without touching anything else - the cameras on
 * that rung fall back to reporting a person and stop asking who.
 *
 * The address is only kept if it parses as an http(s) URL with a host. It is
 * dialled by this server and by every vision worker, so a malformed one is a
 * failure repeated on several machines with no obvious cause.
 */
export async function setFaceRecognition(installedAppId: string, baseUrl: string, apiKey: string): Promise<void> {
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, "");
    if (trimmedUrl) {
        let parsed: URL;
        try {
            parsed = new URL(trimmedUrl);
        } catch {
            throw new Error("Write the address as http://192.168.1.20:8000");
        }
        if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
            throw new Error("Write the address as http://192.168.1.20:8000");
        }
    }
    const current = await readSecrets(installedAppId);
    const secrets: HomeSecrets = {
        ...current,
        faceApiUrl: trimmedUrl || undefined,
        // An empty key on a save that only changed the address leaves the stored
        // one alone; clearing the address clears the pairing outright.
        faceApiKey: trimmedUrl ? apiKey.trim() || current.faceApiKey : undefined
    };
    const blob = encryptSecret(JSON.stringify(secrets), loadEnv().POLARIS_MASTER_KEY);
    await prisma.installedApp.update({
        where: { id: installedAppId },
        data: { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId }
    });
}

/** What the settings screen shows: the address, and that there is a key. The key
 *  itself never goes back to a browser. */
export async function faceRecognitionSettings(
    installedAppId: string
): Promise<{ baseUrl: string; hasKey: boolean }> {
    const secrets = await readSecrets(installedAppId);
    return { baseUrl: secrets.faceApiUrl ?? "", hasKey: Boolean(secrets.faceApiKey) };
}

/** Where the recognizer answers, and the key for it. Null when either half is
 *  missing, which is what makes the face rung unavailable rather than broken. */
async function faceRecognition(installedAppId: string): Promise<{ baseUrl: string; apiKey: string } | null> {
    const { faceApiUrl, faceApiKey } = await readSecrets(installedAppId);
    return faceApiUrl && faceApiKey ? { baseUrl: faceApiUrl, apiKey: faceApiKey } : null;
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
            faces:
                faces && detectorReaches(detector, "faces")
                    ? { ...faces, threshold: detection.faceThreshold }
                    : null
        });
    }
    return assignments;
}
