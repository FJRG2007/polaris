/**
 * Who reached a service, from the edge's recent log.
 *
 * Sleep mode asks when the last visit to a service was, and the autoscaler asks
 * how many arrived in the last minute. Both are the same question of the same
 * file - which requests that were somebody using the service reached one of its
 * addresses, and when - so the log is read and parsed here, once per pass, and
 * each caller asks it about its own addresses.
 *
 * Only this machine's edge: a remote server's services are served by that
 * server's own edge, whose log is not here.
 */

import { parseHttpLogs } from "@polaris/deploy";
import { tunnelHostForApp } from "./quick-tunnel-service";
import { countsAsVisit, hostnameCovers } from "@polaris/core";
import { EDGE_LOG_RECENT_WINDOW_BYTES, readEdgeLogWindow } from "@/lib/edge-access-log";

export interface EdgeVisits {
    /** Every request that counts as a visit: when, in epoch ms, and the host it
     *  asked for, lowercase and without a port. */
    readonly visits: readonly { readonly at: number; readonly host: string }[];
    /** The oldest request the window holds at all, visit or not, in epoch ms;
     *  null when it holds none - no log, or nothing written to it yet. */
    readonly windowStart: number | null;
    /** Whether the log holds more than was read, so a window that starts late is
     *  a busy log cut at the size read rather than a new one. */
    readonly truncated: boolean;
}

/** One read of the edge's recent log. */
export async function readEdgeVisits(): Promise<EdgeVisits> {
    const { text, truncated } = await readEdgeLogWindow(EDGE_LOG_RECENT_WINDOW_BYTES);
    const entries = parseHttpLogs(text);
    const visits: { at: number; host: string }[] = [];
    let windowStart: number | null = null;
    for (const entry of entries) {
        const at = entry.time ? Date.parse(entry.time) : Number.NaN;
        if (!Number.isFinite(at)) continue;
        if (windowStart === null || at < windowStart) windowStart = at;
        if (!entry.host || !countsAsVisit(entry)) continue;
        visits.push({ at, host: entry.host.toLowerCase().split(":")[0] ?? "" });
    }
    return { visits, windowStart, truncated };
}

/** Every address a service answers on: its enabled domains and its quick tunnel. */
export function serviceHostnames(app: {
    id: string;
    domains: readonly { hostname: string }[];
}): string[] {
    return [
        ...app.domains.map((domain) => domain.hostname.toLowerCase()),
        tunnelHostForApp(app.id).toLowerCase()
    ];
}

/** When each visit to one of `names` arrived, in log order. */
export function visitTimes(log: EdgeVisits, names: readonly string[]): number[] {
    return log.visits
        .filter((visit) => names.some((name) => hostnameCovers(name, visit.host)))
        .map((visit) => visit.at);
}
