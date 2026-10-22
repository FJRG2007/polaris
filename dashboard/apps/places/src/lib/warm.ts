/**
 * Keeping each relay's warm cameras what they should be.
 *
 * Publishing a camera warms it, and removing one lets it go - but neither of
 * those reaches a camera that was published before warming existed, one
 * switched off from its settings, or a relay that restarted from a file written
 * by an older build. So once a minute every relay is asked what it is holding
 * and told the difference, which is also what brings a house installed months
 * ago up to fast-opening cameras without anybody pressing anything.
 *
 * Only differences are sent. Telling a relay again to hold a stream it already
 * holds makes it drop the camera and dial it afresh, which is the opposite of
 * the point.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { repairStillStreams } from "./still-streams";
import {
    publishedStreams,
    relayEndpoint,
    relayServerFor,
    relayTraffic,
    restartDue,
    restartRelay,
    stalledStreams,
    type RelayEndpoint,
    type StreamTraffic,
    warmPlan,
    warmStream,
    warmStreams,
    keepsWarm
} from "./relay";

/** What each relay was receiving at the last pass, and its last restart: when,
 *  for which streams, and how many restarts in a row left those still stalled. */
const lastTraffic = new Map<string, StreamTraffic>();
const lastRestart = new Map<
    string,
    { readonly at: number; readonly streams: readonly string[]; readonly fruitless: number }
>();

/**
 * A relay whose camera connection stopped delivering without closing is
 * restarted, so the cameras recover without anybody touching the server. Seen
 * as a stream whose byte count did not move between two passes a minute apart.
 */
async function recoverStalled(server: string, endpoint: RelayEndpoint): Promise<boolean> {
    const traffic = await relayTraffic(endpoint);
    if (!traffic) return false;
    const stalled = stalledStreams(lastTraffic.get(server), traffic);
    lastTraffic.set(server, traffic);
    const now = Date.now();
    const previous = lastRestart.get(server);
    const again = previous ? stalled.some((name) => previous.streams.includes(name)) : false;
    const fruitless = again && previous ? previous.fruitless + 1 : 0;
    if (!restartDue(stalled, previous?.at, now, fruitless)) return false;
    lastRestart.set(server, { at: now, streams: stalled, fruitless });
    // Counted afresh after the restart: the byte counts start over.
    lastTraffic.delete(server);
    console.warn(`[places] relay stream stalled (${stalled.join(", ")}); restarting the relay`);
    return restartRelay(endpoint);
}

export async function sweepWarmCameras(): Promise<{
    warmed: number;
    released: number;
    restarted: number;
}> {
    const cameras = await prisma.camera.findMany({
        select: {
            id: true,
            installedAppId: true,
            enabled: true,
            power: true,
            vendor: true,
            reachVia: true,
            subPath: true
        }
    });
    const byServer = new Map<string, typeof cameras>();
    for (const camera of cameras) {
        const server = relayServerFor(camera.reachVia);
        byServer.set(server, [...(byServer.get(server) ?? []), camera]);
    }

    let warmed = 0;
    let released = 0;
    let restarted = 0;
    for (const [server, onServer] of byServer) {
        // A server with no relay has never had a camera opened: there is nothing
        // to warm, and installing one from a timer is a deploy nobody asked for.
        const endpoint = await relayEndpoint(server).catch(() => null);
        if (!endpoint) continue;
        if (await recoverStalled(server, endpoint)) {
            restarted += 1;
            // Nothing to reconcile with a relay that is coming back up.
            continue;
        }
        const [published, warm] = await Promise.all([
            publishedStreams(endpoint),
            warmStreams(endpoint)
        ]);
        // Down, or from a build that cannot be asked. Either way its cameras open
        // as they always have until it comes back or is updated.
        if (!published || !warm) continue;
        const plan = warmPlan(onServer, published, warm);
        for (const name of plan.add) if (await warmStream(endpoint, name, true)) warmed += 1;
        for (const name of plan.drop) if (await warmStream(endpoint, name, false)) released += 1;
        await repairStillStreams(endpoint, onServer, keepsWarm);
    }
    return { warmed, released, restarted };
}
