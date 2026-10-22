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
import { cameraTarget, controlCredentials } from "./cameras";
import type { CameraPrivacy, PrivacyFailure, PrivacyTarget } from "./privacy-kinds";
import { lensMask, TapoError, type TapoTransport } from "./integrations/tapo-camera";

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

/** The ids of every camera a target names, in this install. A camera or place
 *  that is not this install's names nothing. */
export async function camerasFor(installedAppId: string, target: PrivacyTarget): Promise<string[]> {
    const where =
        target.kind === "camera"
            ? { installedAppId, id: target.id }
            : target.kind === "place"
              ? { installedAppId, placeId: target.id }
              : { installedAppId, placeId: target.placeId, zone: target.zone };
    const rows = await prisma.camera.findMany({ where, select: { id: true }, orderBy: { name: "asc" } });
    return rows.map((row) => row.id);
}

/** Ask the camera itself, trying each sign-in the house holds once. A wrong
 *  password moves to the next; anything else is the answer. */
async function askCamera(
    installedAppId: string,
    row: Row,
    wanted: boolean | null,
    send?: TapoTransport
): Promise<{ private: boolean } | { failure: PrivacyFailure; waitSeconds?: number }> {
    const credentials = await controlCredentials(installedAppId, row.id);
    if (credentials.length === 0) return { failure: "password" };
    let last: PrivacyFailure = "password";
    for (const credential of credentials) {
        try {
            const answer = await lensMask(
                { address: row.address, ...credential, pin: row.controlPin },
                wanted,
                send
            );
            if (answer.pin && answer.pin !== row.controlPin)
                await prisma.camera.update({ where: { id: row.id }, data: { controlPin: answer.pin } });
            return { private: answer.private };
        } catch (caught) {
            if (!(caught instanceof TapoError)) throw caught;
            if (caught.failure === "locked") return { failure: "locked", waitSeconds: caught.waitSeconds };
            if (caught.failure !== "password" && caught.failure !== "account")
                return { failure: caught.failure };
            // "account" outranks "password": it is the more useful sentence.
            if (last !== "account") last = caught.failure;
        }
    }
    return { failure: last };
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
                warm: relay.keepsWarm(row)
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
 *  what its lockout counts. */
export async function groupPrivacy(
    cameraIds: readonly string[],
    run: (cameraId: string) => Promise<CameraPrivacy>
): Promise<CameraPrivacy[]> {
    const results: CameraPrivacy[] = [];
    for (const cameraId of cameraIds) {
        try {
            results.push(await run(cameraId));
        } catch (caught) {
            if (!(caught instanceof HomeError)) console.warn("[places] privacy failed", cameraId, (caught as Error).name);
            results.push({ cameraId, name: "", private: false, native: false, failure: "failed" });
        }
    }
    return results;
}
