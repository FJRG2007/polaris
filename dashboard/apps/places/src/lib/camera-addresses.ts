/**
 * Cameras found again after the network gives them another address.
 *
 * A camera is stored by the IP it answered on when it was added. DHCP, a new
 * router or the server moving to another network all hand it a different one,
 * and a camera stored by IP then reads as gone while it sits on the shelf
 * answering. What does not change is its hardware (MAC) address, so that is
 * recorded the first time the camera answers, and when it stops answering the
 * network is asked where that hardware address is now. The stored address is
 * moved there and the relay pointed at it, with nobody touching anything.
 *
 * Only for a camera this server reaches itself: one held by another server's
 * relay is on a network whose neighbour table this server cannot read.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { cameraTarget } from "./cameras";
import { locateMac, macsAt } from "./integrations/mac-locate";
import { keepsWarm, publishCamera, type RelayEndpoint } from "./relay";

/** One camera, as this needs it. */
export interface FollowedCamera {
    readonly id: string;
    readonly installedAppId: string;
    readonly address: string;
    readonly hardwareAddress: string | null;
    readonly reachVia: string;
    readonly vendor: string;
    readonly power: string;
    readonly enabled: boolean;
    readonly privacy: boolean;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Whether a camera is one whose hardware address this server can see: reached
 *  directly, and by an IP rather than a name (a name follows the camera on its
 *  own). */
function followable(camera: Pick<FollowedCamera, "reachVia" | "address">): boolean {
    return camera.reachVia === "direct" && IPV4.test(camera.address.trim());
}

/**
 * Record the hardware address of each of these cameras that just answered and
 * has none yet. This is also how every camera added before the column existed
 * gets one: on the next pass it answers in.
 *
 * Returns how many were recorded. Never throws.
 */
export async function recordCameraHardware(cameras: readonly FollowedCamera[]): Promise<number> {
    const wanting = cameras.filter((camera) => !camera.hardwareAddress && followable(camera));
    if (wanting.length === 0) return 0;
    let recorded = 0;
    try {
        const macs = await macsAt([...new Set(wanting.map((camera) => camera.address.trim()))]);
        for (const camera of wanting) {
            const mac = macs.get(camera.address.trim());
            if (!mac) continue;
            await prisma.camera.update({ where: { id: camera.id }, data: { hardwareAddress: mac } });
            recorded += 1;
        }
    } catch (error) {
        console.warn("[places] could not record a camera's hardware address", (error as Error).name);
    }
    return recorded;
}

/**
 * Where a camera that stopped answering is now, by its hardware address. When it
 * answers somewhere else, the stored address is moved there and the relay is
 * given the camera again at the new one.
 *
 * Returns the new address, or null when it was not found anywhere new (switched
 * off, unplugged, on a network this server cannot see). Never throws.
 */
export async function relocateCamera(
    endpoint: RelayEndpoint,
    camera: FollowedCamera
): Promise<string | null> {
    if (!camera.hardwareAddress || !followable(camera)) return null;
    try {
        const current = camera.address.trim();
        const address = await locateMac(camera.hardwareAddress, { fresh: true, avoid: current });
        if (!address || address === current) return null;
        await prisma.camera.update({ where: { id: camera.id }, data: { address } });
        const target = await cameraTarget(camera.installedAppId, camera.id);
        if (target && camera.enabled && !camera.privacy)
            await publishCamera(endpoint, target, camera.vendor, { warm: keepsWarm(camera) });
        console.info("[places] camera found at a new address", camera.id);
        return address;
    } catch (error) {
        console.warn("[places] could not move a camera to its new address", (error as Error).name);
        return null;
    }
}
