/**
 * Make sure a public link (share or drop point) will actually be reachable before
 * one is handed out. On a box that is directly reachable, or that has a configured
 * public domain, nothing is needed. On a NATed box with no public domain, the
 * DuckDNS/auto name does not resolve to the server from outside, so raise a
 * Cloudflare Quick Tunnel to Polaris; sharingBaseUrl() then prefers that tunnel URL.
 * Best-effort and idempotent - a tunnel failure just leaves the existing base URL.
 */

import { getDomainConfig } from "./domain-service";
import { zoneReachable } from "./domain-zones";
import { getNetworkStatus } from "./network-service";
import {
    ensurePolarisTunnel,
    polarisTunnelPresence,
    stopPolarisTunnel
} from "./polaris-tunnel-service";

/** Whether public links on this box need the Polaris tunnel at all. */
async function needsShareTunnel(): Promise<boolean> {
    const config = await getDomainConfig();
    // An explicitly configured public sharing domain is the operator's choice; trust it.
    if (config.sharingDomain) return false;
    // A zone that has been seen answering on the wire is a working public domain, so a
    // tunnel would only add a slower path in front of it. Correct DNS alone is not
    // enough here: it does not say the ports reach this box, and this is exactly the
    // decision where being wrong costs the operator working links.
    if (await zoneReachable()) return false;
    const status = await getNetworkStatus();
    // The box's own IP is internet-reachable, so DuckDNS/auto names work as-is.
    return !status.autoSubdomainsPublic;
}

export async function ensureShareReachability(): Promise<void> {
    if (await needsShareTunnel()) await ensurePolarisTunnel().catch(() => undefined);
}

/**
 * Put the tunnel right between shares, from the address watcher.
 *
 * It is only ever raised when a link is handed out, and nothing else looked at it
 * afterwards: a box that later got a working domain kept the connector for good,
 * and one raised against the web container's old name kept forwarding into a name
 * that no longer existed (one server had one doing both for months). So a tunnel
 * that is no longer needed goes, and one that is needed but stale is raised again.
 */
export async function settleShareTunnel(): Promise<"removed" | "repaired" | "unchanged"> {
    const presence = await polarisTunnelPresence();
    if (presence === "none") return "unchanged";
    if (!(await needsShareTunnel())) {
        await stopPolarisTunnel();
        return "removed";
    }
    if (presence === "stale") {
        await ensurePolarisTunnel();
        return "repaired";
    }
    return "unchanged";
}
