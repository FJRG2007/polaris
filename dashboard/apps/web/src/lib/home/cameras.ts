/**
 * The cameras in the house: reading them, adding one, changing one, removing one.
 *
 * Two shapes come out of here and the difference is the point. `CameraView` is
 * what a screen gets - everything except the password. `CameraTarget` is what the
 * relay and the detectors get, and it carries the decrypted credential, so it is
 * built only where a connection is about to be made and never returned to a
 * caller that renders.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { HomeError } from "@/lib/home/home-error";

import { loadEnv } from "@polaris/config";
import { cameraVendor, onBattery, rtspUrl } from "@/lib/home/vendors";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { detectionSettingsSchema, type CameraInput } from "@/lib/home/schemas";
import { DEFAULT_DETECTION, LOCAL_MACHINE, type DetectionSettings } from "@/lib/home/detection";

/** A camera as a screen sees it. No credential, ever. */
export interface CameraView {
    readonly id: string;
    readonly name: string;
    readonly placeId: string;
    readonly zone: string;
    readonly vendor: string;
    readonly model: string | null;
    readonly address: string;
    readonly rtspPort: number;
    readonly onvifPort: number | null;
    readonly mainPath: string;
    readonly subPath: string;
    readonly username: string;
    /** Whether a password is stored, so the form can say "unchanged" instead of
     *  arriving blank and looking like there is none. */
    readonly hasPassword: boolean;
    readonly reachVia: string;
    readonly detector: string;
    readonly detectorTargetId: string | null;
    readonly detection: DetectionSettings;
    readonly recording: string;
    /** Where its footage is written: a connection id, "local", or "" for
     *  whatever the instance is set to. */
    readonly storageTarget: string;
    readonly retentionDays: number;
    readonly enabled: boolean;
    /** Whether the camera can be pointed somewhere, which is only true when it
     *  answered ONVIF. */
    readonly ptz: boolean;
    /** The last time it answered, as ISO. Null on one nothing has reached yet -
     *  a camera added this morning and never opened has never had the chance. */
    readonly lastSeenAt: string | null;
    /** When it stopped answering, as ISO, and null while it is answering. What
     *  turns a tile that is not drawing into one that says how long it has been
     *  like that. */
    readonly offlineSince: string | null;
}

/** A camera as something that is about to connect to it sees it. */
export interface CameraTarget {
    readonly id: string;
    readonly name: string;
    readonly address: string;
    readonly rtspPort: number;
    readonly onvifPort: number | null;
    readonly username: string | null;
    readonly password: string | null;
    readonly reachVia: string;
    /** Full URL of the stream that gets watched and recorded. */
    readonly mainUrl: string;
    /** The small one detection reads. Falls back to the main stream when the
     *  camera publishes only one - detection still has to work there, it just
     *  costs more, and the settings screen says so. */
    readonly subUrl: string;
}

type CameraRow = Awaited<ReturnType<typeof prisma.camera.findFirst>>;

/** The stored detection tuning, or the defaults for a row written before a knob
 *  existed. A malformed blob is not an error a screen should die on: it means
 *  this camera falls back to the defaults, which is what it was doing anyway. */
export function parseDetection(raw: string): DetectionSettings {
    try {
        const parsed = detectionSettingsSchema.safeParse(JSON.parse(raw));
        return parsed.success ? { ...DEFAULT_DETECTION, ...parsed.data } : DEFAULT_DETECTION;
    } catch {
        return DEFAULT_DETECTION;
    }
}

function toView(row: NonNullable<CameraRow>): CameraView {
    return {
        id: row.id,
        name: row.name,
        placeId: row.placeId ?? "",
        zone: row.zone ?? "",
        vendor: row.vendor,
        model: row.model,
        address: row.address,
        rtspPort: row.rtspPort,
        onvifPort: row.onvifPort,
        mainPath: row.mainPath ?? "",
        subPath: row.subPath ?? "",
        username: row.username ?? "",
        hasPassword: row.encryptedSecret !== null,
        reachVia: row.reachVia,
        detector: row.detector,
        detectorTargetId: row.detectorTargetId,
        detection: parseDetection(row.detectionConfig),
        recording: row.recording,
        storageTarget: row.storageTarget ?? "",
        retentionDays: row.retentionDays,
        enabled: row.enabled,
        ptz: row.onvifPort !== null,
        lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
        offlineSince: row.offlineSince?.toISOString() ?? null
    };
}

/**
 * Every camera in one place, grouped the way the wall reads: by zone, then by
 * name. One query - a place has tens of cameras, not thousands.
 *
 * Scoped to a place rather than to the whole install, because every screen in
 * this app is about one building. Passing no place answers for all of them,
 * which is what the sweeps and the workers want.
 */
export async function listCameras(
    installedAppId: string,
    placeId?: string | null
): Promise<CameraView[]> {
    const rows = await prisma.camera.findMany({
        where: { installedAppId, ...(placeId ? { placeId } : {}) },
        orderBy: [{ zone: "asc" }, { name: "asc" }]
    });
    return rows.map(toView);
}

/** One camera of this house, or null. Scoped by the install on purpose: an id
 *  from somewhere else must not resolve. */
export async function getCamera(installedAppId: string, id: string): Promise<CameraView | null> {
    const row = await prisma.camera.findFirst({ where: { id, installedAppId } });
    return row ? toView(row) : null;
}

/**
 * Where this camera's detection runs.
 *
 * A camera reached through a server is analyzed on that server, whatever the
 * form said. The alternative is hauling its stream across the link Polaris could
 * not reach the camera over in the first place, to look at it somewhere else -
 * which is slower, costs the tunnel, and fails outright when the worker is on a
 * machine that cannot see the relay at all.
 */
function detectionRunsOn(input: CameraInput): string | null {
    if (input.reachVia.startsWith("server:")) return input.reachVia.slice("server:".length);
    // "This machine" is offered to the picker as `local`, because a machine that
    // is not an enrolled server has no id to offer. In the row it is simply no
    // server at all - which is what every reader of this column already treats
    // null as. Storing the word instead put a value that is not a uuid into a
    // uuid column, and the database said so in its own language, to the person
    // adding a camera.
    return input.detectorTargetId === LOCAL_MACHINE ? null : input.detectorTargetId;
}

/** The paths a camera ends up with: what was typed, else what its make uses. */
function resolvePaths(input: CameraInput): { mainPath: string; subPath: string } {
    const vendor = cameraVendor(input.vendor);
    return {
        mainPath: input.mainPath || vendor.mainPath,
        subPath: input.subPath || vendor.subPath || ""
    };
}

/** Encrypt a camera password for storage, or null to leave the stored one be. */
function secretColumns(password: string | undefined) {
    if (password === undefined || password === "") return null;
    const blob = encryptSecret(password, loadEnv().POLARIS_MASTER_KEY);
    return { encryptedSecret: blob.ciphertext, secretNonce: blob.nonce, secretKeyId: blob.keyId };
}

export async function createCamera(
    installedAppId: string,
    input: CameraInput
): Promise<CameraView> {
    const vendor = cameraVendor(input.vendor);
    const paths = resolvePaths(input);
    const row = await prisma.camera.create({
        data: {
            installedAppId,
            placeId: input.placeId || null,
            name: input.name,
            zone: input.zone || null,
            vendor: input.vendor,
            address: input.address,
            rtspPort: input.rtspPort,
            // What the make listens on, unless the form was told otherwise. This
            // is the one that makes Tapo work without anybody knowing about 2020.
            onvifPort: input.onvifPort ?? vendor.onvifPort ?? null,
            mainPath: paths.mainPath || null,
            subPath: paths.subPath || null,
            username: input.username || null,
            reachVia: input.reachVia,
            detector: input.detector,
            detectorTargetId: detectionRunsOn(input),
            detectionConfig: JSON.stringify(input.detection),
            recording: input.recording,
            storageTarget: input.storageTarget || null,
            retentionDays: input.retentionDays,
            enabled: input.enabled,
            ...(secretColumns(input.password) ?? {})
        }
    });
    return toView(row);
}

export async function updateCamera(
    installedAppId: string,
    id: string,
    input: CameraInput
): Promise<CameraView> {
    const existing = await prisma.camera.findFirst({
        where: { id, installedAppId },
        select: { id: true }
    });
    if (!existing) throw new HomeError("Camera not found");
    const vendor = cameraVendor(input.vendor);
    const paths = resolvePaths(input);
    // A battery camera is not dialled by the availability pass, and that pass is
    // the only thing that clears an outage. One moved onto a battery make while
    // it was down would keep the clock it was carrying for good: every screen
    // reading "not answering since" a date that can never advance, and the event
    // in the log left open on an outage nothing will ever close.
    const battery = onBattery(input.vendor);
    if (battery) {
        await prisma.cameraEvent.updateMany({
            where: { cameraId: id, kind: "offline", endedAt: null },
            data: { endedAt: new Date() }
        });
    }
    const row = await prisma.camera.update({
        where: { id },
        data: {
            ...(battery ? { offlineSince: null } : {}),
            placeId: input.placeId || null,
            name: input.name,
            zone: input.zone || null,
            vendor: input.vendor,
            address: input.address,
            rtspPort: input.rtspPort,
            onvifPort: input.onvifPort ?? vendor.onvifPort ?? null,
            mainPath: paths.mainPath || null,
            subPath: paths.subPath || null,
            username: input.username || null,
            reachVia: input.reachVia,
            detector: input.detector,
            detectorTargetId: detectionRunsOn(input),
            detectionConfig: JSON.stringify(input.detection),
            recording: input.recording,
            storageTarget: input.storageTarget || null,
            retentionDays: input.retentionDays,
            enabled: input.enabled,
            // An empty password field on an edit means "leave it": the stored one
            // is never sent to the browser, so blank cannot mean "clear it"
            // without silently locking Polaris out of the camera.
            ...(secretColumns(input.password) ?? {})
        }
    });
    return toView(row);
}

/** Remove a camera and everything it recorded. The rows cascade; the files it
 *  wrote are dropped by the retention sweep, which is the one thing that knows
 *  how to reach the storage they went to. */
export async function deleteCamera(installedAppId: string, id: string): Promise<void> {
    const existing = await prisma.camera.findFirst({
        where: { id, installedAppId },
        select: { id: true }
    });
    if (!existing) throw new HomeError("Camera not found");
    await prisma.camera.delete({ where: { id } });
}

/** The stored password, or null when the camera needs none. Throws only when the
 *  master key has changed under a stored credential, which is a real failure and
 *  has to be said rather than swallowed into "camera offline". */
async function cameraPassword(row: NonNullable<CameraRow>): Promise<string | null> {
    if (!row.encryptedSecret || !row.secretNonce || !row.secretKeyId) return null;
    return decryptSecret(
        {
            // Prisma hands bytes back as a Uint8Array; the envelope is written in
            // Buffers.
            ciphertext: Buffer.from(row.encryptedSecret),
            nonce: Buffer.from(row.secretNonce),
            keyId: row.secretKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/**
 * A camera in the form something that connects to it needs, credential included.
 *
 * Never hand the result to a component. It is built for the relay's configuration
 * and for the ONVIF client, both of which run on the server and both of which
 * need the password to say anything to the camera at all.
 */
export async function cameraTarget(
    installedAppId: string,
    id: string
): Promise<CameraTarget | null> {
    const row = await prisma.camera.findFirst({ where: { id, installedAppId } });
    if (!row) return null;
    const password = await cameraPassword(row);
    const auth = { username: row.username, password };
    const endpoint = { address: row.address, rtspPort: row.rtspPort };
    const mainUrl = rtspUrl(endpoint, row.mainPath ?? "", auth);
    return {
        id: row.id,
        name: row.name,
        address: row.address,
        rtspPort: row.rtspPort,
        onvifPort: row.onvifPort,
        username: row.username,
        password,
        reachVia: row.reachVia,
        mainUrl,
        subUrl: row.subPath ? rtspUrl(endpoint, row.subPath, auth) : mainUrl
    };
}

/** Every enabled camera as a connection target, for the relay's configuration.
 *  One pass rather than a query per camera - the relay is written whole. */
export async function cameraTargets(installedAppId: string): Promise<CameraTarget[]> {
    const rows = await prisma.camera.findMany({ where: { installedAppId, enabled: true } });
    return Promise.all(
        rows.map(async (row) => {
            const password = await cameraPassword(row);
            const auth = { username: row.username, password };
            const endpoint = { address: row.address, rtspPort: row.rtspPort };
            const mainUrl = rtspUrl(endpoint, row.mainPath ?? "", auth);
            return {
                id: row.id,
                name: row.name,
                address: row.address,
                rtspPort: row.rtspPort,
                onvifPort: row.onvifPort,
                username: row.username,
                password,
                reachVia: row.reachVia,
                mainUrl,
                subUrl: row.subPath ? rtspUrl(endpoint, row.subPath, auth) : mainUrl
            };
        })
    );
}
