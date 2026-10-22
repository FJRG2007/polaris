/**
 * Moving cameras that were saved reading a still stream onto their video one.
 *
 * Until the add-camera check learned to skip them, a camera that publishes a
 * JPEG profile had it picked as its small stream whenever it was the narrowest
 * one - a Tapo C210's 640x360, one-frame-a-second /stream8. Those cameras keep
 * that path until somebody re-saves them, and their wall thumbnails stay gray
 * or empty meanwhile. So each one is asked once which of its profiles that
 * path belongs to, and moved when it is the still one.
 *
 * Only a path the camera itself names as its JPEG stream is replaced: a path
 * somebody typed, or one this camera does not publish, is left as it is.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { cameraTarget } from "./cameras";
import { cameraVendor } from "./vendors";
import { streamPathOf } from "./stream-path";
import { publishCamera, type RelayEndpoint } from "./relay";
import { getProfiles, getStreamUri, pickProfiles, type OnvifEndpoint } from "./onvif";

/** Cameras already asked since this process started, by id. One ONVIF round
 *  per camera per start is the whole cost: a camera that answers one request at
 *  a time must not be asked this every minute. */
const asked = new Set<string>();

interface StillCandidate {
    readonly id: string;
    readonly installedAppId: string;
    readonly enabled: boolean;
    readonly power: string;
    readonly vendor: string;
    readonly subPath: string | null;
}

/** The video path to use instead of `subPath`, or null to leave it. */
async function replacementFor(endpoint: OnvifEndpoint, subPath: string): Promise<string | null> {
    const profiles = await getProfiles(endpoint);
    const stills = profiles.filter((profile) => profile.encoding === "JPEG");
    if (stills.length === 0) return null;
    const stillPaths = await Promise.all(
        stills.map((profile) => getStreamUri(endpoint, profile.token).then(streamPathOf))
    );
    if (!stillPaths.includes(subPath)) return null;
    const { sub } = pickProfiles(profiles);
    if (!sub) return "";
    return streamPathOf(await getStreamUri(endpoint, sub.token));
}

/**
 * Check the cameras on one relay, once each, and move any that read a still
 * stream. Returns how many were moved. Never throws.
 *
 * No camera is started once `until` (epoch ms) has passed: the rest are left
 * unasked for the next pass, so a house of slow or offline cameras cannot hold
 * the sweep that calls this past its lease.
 */
export async function repairStillStreams(
    relay: RelayEndpoint,
    cameras: readonly StillCandidate[],
    warm: (camera: StillCandidate) => boolean,
    until = Number.POSITIVE_INFINITY
): Promise<number> {
    let moved = 0;
    for (const camera of cameras) {
        if (Date.now() >= until) break;
        if (asked.has(camera.id) || !camera.enabled || camera.privacy || !camera.subPath)
            continue;
        // A make with nothing to ask, or one reached over its maker's own
        // protocol, which picks the stream by quality and never reads the path.
        const vendor = cameraVendor(camera.vendor);
        if (vendor.noOnvif || vendor.nativeScheme) continue;
        asked.add(camera.id);
        try {
            const target = await cameraTarget(camera.installedAppId, camera.id);
            if (!target?.onvifPort) continue;
            const replacement = await replacementFor(
                {
                    address: target.address,
                    port: target.onvifPort,
                    username: target.username,
                    password: target.password
                },
                camera.subPath
            );
            if (replacement === null) continue;
            await prisma.camera.update({
                where: { id: camera.id },
                data: { subPath: replacement || null }
            });
            const updated = await cameraTarget(camera.installedAppId, camera.id);
            if (updated) await publishCamera(relay, updated, camera.vendor, { warm: warm(camera) });
            moved += 1;
        } catch (error) {
            // Not asked again until the next start, on purpose: the camera that
            // fails this is often the one that can least afford the retries.
            console.warn("[places] could not check a camera's small stream", error);
        }
    }
    return moved;
}
