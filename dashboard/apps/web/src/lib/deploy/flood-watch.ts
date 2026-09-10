/**
 * The automatic half of the browser challenge: marking a service as flooded, and
 * letting it go again.
 *
 * Runs on the firewall's own tick, against the same edge log the jails and the anomaly
 * detector read. Only services set to "auto" are considered - a service somebody set
 * to "on" is challenged regardless, and one set to "off" never is.
 *
 * A mark lasts a while after the flood stops, on purpose. An attack that pauses for a
 * minute is still an attack, and a challenge that goes up and down with every lull is
 * a site that keeps interrupting its visitors for no reason they can see.
 */

import { prisma } from "@polaris/db";
import { parseHttpLogs } from "@polaris/deploy";
import { tunnelHostForApp } from "./quick-tunnel-service";
import { floodedServices, saveFloodedServices } from "./edge-state";
import { EDGE_LOG_RECENT_WINDOW_BYTES, readEdgeLogTail } from "@/lib/edge-access-log";
import { detectFloodedHosts, hostnameCovers, parseAppEdgeConfig } from "@polaris/core";

/** How far back the flood check looks for a service's usual minute. */
const WINDOW_MINUTES = 10;

/** How long a service stays challenged after the last minute it was seen flooded. */
const HOLD_MS = 15 * 60 * 1000;

/**
 * One pass. Answers how many services are marked now and whether the set changed, so
 * the tick can say something when it did - the edge is re-rendered only then.
 */
export async function runFloodWatch(
    now = Date.now()
): Promise<{ flooded: number; changed: boolean }> {
    // Every stored mark, lapsed ones included: a mark that lapsed since the last
    // pass is still what the edge was last rendered with, so letting it go is a
    // change like any other, and it is dropped from storage by the save below.
    const stored = await floodedServices(0);
    const before = new Map([...stored].filter(([, until]) => until > now));
    // A cheap pre-filter on the stored text, then the real answer from the parsed
    // config: the column is JSON written by `JSON.stringify`, so the pair appears
    // exactly like this in any row that has it.
    const candidates = (
        await prisma.application.findMany({
            where: { edgeConfig: { contains: '"challenge":"auto"' } },
            select: {
                id: true,
                edgeConfig: true,
                domains: { where: { enabled: true }, select: { hostname: true } }
            }
        })
    ).filter((app) => parseAppEdgeConfig(app.edgeConfig).challenge === "auto");

    const after = new Map<string, number>();
    if (candidates.length > 0) {
        const raw = await readEdgeLogTail(EDGE_LOG_RECENT_WINDOW_BYTES);
        const hosts = raw ? detectFloodedHosts(parseHttpLogs(raw), now, WINDOW_MINUTES) : [];
        for (const app of candidates) {
            const names = [
                ...app.domains.map((domain) => domain.hostname.toLowerCase()),
                tunnelHostForApp(app.id).toLowerCase()
            ];
            const hit = hosts.some((host) => names.some((name) => hostnameCovers(name, host)));
            const held = before.get(app.id);
            // A service set back to "on" or "off" drops out of the map entirely: the
            // mark only ever meant anything to "auto".
            if (hit) after.set(app.id, now + HOLD_MS);
            else if (held !== undefined) after.set(app.id, held);
        }
    }

    const changed =
        stored.size !== before.size ||
        before.size !== after.size ||
        [...after.keys()].some((id) => !before.has(id));
    if (changed || [...after].some(([id, until]) => before.get(id) !== until)) {
        await saveFloodedServices(after);
    }
    if (changed) {
        // Only when who is challenged changed: extending a mark changes nothing the
        // edge renders.
        const { syncAppRoutes } = await import("@/lib/deploy-service");
        await syncAppRoutes();
    }
    return { flooded: after.size, changed };
}
