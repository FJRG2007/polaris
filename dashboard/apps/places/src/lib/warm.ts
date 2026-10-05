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
import {
    publishedStreams,
    relayEndpoint,
    relayServerFor,
    warmPlan,
    warmStream,
    warmStreams
} from "./relay";

export async function sweepWarmCameras(): Promise<{ warmed: number; released: number }> {
    const cameras = await prisma.camera.findMany({
        select: { id: true, enabled: true, power: true, vendor: true, reachVia: true }
    });
    const byServer = new Map<string, typeof cameras>();
    for (const camera of cameras) {
        const server = relayServerFor(camera.reachVia);
        byServer.set(server, [...(byServer.get(server) ?? []), camera]);
    }

    let warmed = 0;
    let released = 0;
    for (const [server, onServer] of byServer) {
        // A server with no relay has never had a camera opened: there is nothing
        // to warm, and installing one from a timer is a deploy nobody asked for.
        const endpoint = await relayEndpoint(server).catch(() => null);
        if (!endpoint) continue;
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
    }
    return { warmed, released };
}
