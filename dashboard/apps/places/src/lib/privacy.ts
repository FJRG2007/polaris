/**
 * Camera privacy: switching it, reading it back, and doing it for a group.
 *
 * Two layers, see docs/camera-privacy.md. On a camera with a privacy mode of
 * its own (Tapo) the camera is told first and its own answer is what gets
 * stored - a camera that refused is not marked private. Every camera, whatever
 * its make, is then left alone by Polaris while private: its relay stream is
 * dropped here, and the recorder, watcher, detection and stills all skip a
 * private row.
 *
 * A group is switched camera by camera and every camera answers for itself, so
 * one that refused never undoes the ones that did.
 *
 * Server-only.
 */

import * as ptz from "./ptz";
import * as relay from "./relay";
import { prisma } from "@polaris/db";
import { HomeError } from "./home-error";
import { hasNativePrivacy } from "./vendors";
import { askTapo } from "./tapo-controls";
import { cameraTarget } from "./cameras";
import { endCameraTalk } from "./talk";
import type { CameraPrivacy, PrivacyFailure, PrivacyTarget } from "./privacy-kinds";
import { lensMaskOn, type TapoTransport } from "./integrations/tapo-camera";

const FIELDS = {
    id: true,
    name: true,
    vendor: true,
    address: true,
    reachVia: true,
    power: true,
    enabled: true,
    privacy: true,
    privacyPreset: true,
    controlPin: true
} as const;

type Row = { id: string; name: string; vendor: string; address: string } & {
    reachVia: string;
    power: string;
    enabled: boolean;
    privacy: boolean;
    privacyPreset: string | null;
    controlPin: string | null;
};

/** A camera as it is stored, before anything is asked of it. */
export interface StoredCamera {
    readonly id: string;
    readonly name: string;
    readonly vendor: string;
    readonly privacy: boolean;
}

/** The ids of every camera a target names, in this install. A camera or place
 *  that is not this install's names nothing. */
export async function camerasFor(installedAppId: string, target: PrivacyTarget): Promise<string[]> {
    return (await storedCamerasFor(installedAppId, target)).map((row) => row.id);
}

/** Every camera a target names, in this install, as it is stored. */
export async function storedCamerasFor(
    installedAppId: string,
    target: PrivacyTarget
): Promise<StoredCamera[]> {
    let where;
    if (target.kind === "camera") where = { installedAppId, id: target.id };
    else if (target.kind === "place") where = { installedAppId, placeId: target.id };
    else if (target.kind === "room") where = { installedAppId, roomId: target.id };
    else if (target.kind === "zone")
        where = { installedAppId, placeId: target.placeId, zone: target.zone };
    else {
        const set = await prisma.cameraSet.findFirst({
            where: { id: target.id, installedAppId },
            select: { placeId: true, cameraIds: true }
        });
        if (!set || set.cameraIds.length === 0) return [];
        where = { installedAppId, placeId: set.placeId, id: { in: set.cameraIds } };
    }
    return prisma.camera.findMany({
        where,
        select: { id: true, name: true, vendor: true, privacy: true },
        orderBy: { name: "asc" }
    });
}

/** Ask the camera itself for its lens mask, through the sign-in loop every
 *  Tapo control shares. */
async function askCamera(
    installedAppId: string,
    row: Row,
    wanted: boolean | null,
    send?: TapoTransport
): Promise<{ private: boolean } | { failure: PrivacyFailure; waitSeconds?: number }> {
    const asked = await askTapo(installedAppId, row, (link) => lensMaskOn(link, wanted), send);
    return "failure" in asked ? asked : { private: asked.value };
}

/** The relay stops holding a private camera and picks a public one up again.
 *  Best effort: a relay that is not running has nothing to drop, and the next
 *  viewer publishes the camera anyway. */
async function followRelay(installedAppId: string, row: Row, isPrivate: boolean): Promise<void> {
    try {
        const endpoint = await relay.relayEndpoint(relay.relayServerFor(row.reachVia));
        if (!endpoint) return;
        if (isPrivate) {
            await relay.unpublishCamera(endpoint, row.id);
            return;
        }
        if (!row.enabled) return;
        const target = await cameraTarget(installedAppId, row.id);
        if (target)
            await relay.publishCamera(endpoint, target, row.vendor, {
                warm: relay.keepsWarm({ ...row, privacy: false })
            });
    } catch (caught) {
        console.warn("[places] privacy: relay did not follow", row.id, (caught as Error).name);
    }
}

async function store(row: Row, isPrivate: boolean): Promise<void> {
    if (row.privacy === isPrivate) return;
    await prisma.camera.update({
        where: { id: row.id },
        data: { privacy: isPrivate, privacyChangedAt: new Date() }
    });
    if (isPrivate) await endCameraTalk(row.id);
}

/**
 * Switch one camera, or read it when `wanted` is null. Answers what it is now.
 *
 * A native camera that refuses keeps its stored state - Polaris does not claim
 * a camera is private when it is still streaming to its own app.
 */
export async function cameraPrivacy(
    installedAppId: string,
    cameraId: string,
    wanted: boolean | null,
    send?: TapoTransport
): Promise<CameraPrivacy> {
    const row = await prisma.camera.findFirst({
        where: { id: cameraId, installedAppId },
        select: FIELDS
    });
    if (!row) throw new HomeError("Camera not found");
    const native = hasNativePrivacy(row.vendor);
    const base = { cameraId: row.id, name: row.name, native };

    if (native) {
        const answer = await askCamera(installedAppId, row, wanted, send);
        if ("failure" in answer) return { ...base, private: row.privacy, ...answer };
        await store(row, answer.private);
        if (answer.private !== row.privacy) await followRelay(installedAppId, row, answer.private);
        return { ...base, private: answer.private };
    }

    if (wanted === null || wanted === row.privacy) return { ...base, private: row.privacy };
    await store(row, wanted);
    await followRelay(installedAppId, row, wanted);
    // Pointed away, where its owner chose a preset. Polaris has already stopped
    // reading it, so a camera that does not turn is still private here.
    if (wanted && row.privacyPreset) {
        try {
            await ptz.goTo(installedAppId, row.id, row.privacyPreset);
        } catch {
            return { ...base, private: true, failure: "unreachable" };
        }
    }
    return { ...base, private: wanted };
}

/** Every camera of a group, each answering for itself. Run one at a time: a
 *  house of Tapo cameras is one TP-Link account, and a burst of sign-ins is
 *  what its lockout counts. One that could not be asked keeps what is stored
 *  for it, so a failed switch never reads as done. */
export async function groupPrivacy(
    cameras: readonly StoredCamera[],
    run: (cameraId: string) => Promise<CameraPrivacy>
): Promise<CameraPrivacy[]> {
    const results: CameraPrivacy[] = [];
    for (const camera of cameras) {
        try {
            results.push(await run(camera.id));
        } catch (caught) {
            if (!(caught instanceof HomeError))
                console.warn("[places] privacy failed", camera.id, (caught as Error).name);
            results.push({
                cameraId: camera.id,
                name: camera.name,
                private: camera.privacy,
                native: hasNativePrivacy(camera.vendor),
                failure: "failed"
            });
        }
    }
    return results;
}

/** Take the certificate each of these cameras answers with next on trust, as
 *  the first sign-in did: for a camera that was replaced or reset, whose new
 *  certificate is the one now refused. */
export async function trustCamerasAgain(
    installedAppId: string,
    cameraIds: readonly string[]
): Promise<void> {
    if (cameraIds.length === 0) return;
    await prisma.camera.updateMany({
        where: { installedAppId, id: { in: [...cameraIds] } },
        data: { controlPin: null }
    });
}

/** Switch every camera a target names, each answering for itself. */
export async function switchPrivacy(
    installedAppId: string,
    target: PrivacyTarget,
    wanted: boolean
): Promise<CameraPrivacy[]> {
    const cameras = await storedCamerasFor(installedAppId, target);
    return groupPrivacy(cameras, (id) => cameraPrivacy(installedAppId, id, wanted));
}
