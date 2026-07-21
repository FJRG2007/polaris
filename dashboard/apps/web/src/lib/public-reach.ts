/**
 * Make sure a public link (share or drop point) will actually be reachable before
 * one is handed out. On a box that is directly reachable, or that has a configured
 * public domain, nothing is needed. On a NATed box with no public domain, the
 * DuckDNS/auto name does not resolve to the server from outside, so raise a
 * Cloudflare Quick Tunnel to Polaris; sharingBaseUrl() then prefers that tunnel URL.
 * Best-effort and idempotent - a tunnel failure just leaves the existing base URL.
 */

import { getDomainConfig } from "./domain-service";
import { getNetworkStatus } from "./network-service";
import { ensurePolarisTunnel } from "./polaris-tunnel-service";

export async function ensureShareReachability(): Promise<void> {
    const config = await getDomainConfig();
    // An explicitly configured public sharing domain is the operator's choice; trust it.
    if (config.sharingDomain) return;
    const status = await getNetworkStatus();
    // The box's own IP is internet-reachable, so DuckDNS/auto names work as-is.
    if (status.autoSubdomainsPublic) return;
    await ensurePolarisTunnel().catch(() => undefined);
}
