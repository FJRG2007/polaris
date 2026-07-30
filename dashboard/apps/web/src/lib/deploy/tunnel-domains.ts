/**
 * Active per-app tunnel hostnames (Cloudflare quick, ngrok, and Cloudflare named)
 * surfaced as Domain-shaped entries so they can be merged into an app's `domains`
 * list. Tunnel URLs live in their own Setting cache, separate from the `Domain`
 * table, so without this the primary-domain picker, the deployments header, and the
 * canvas node label never see a live tunnel and fall back to "No domain yet". This
 * is a cheap cache read (one query for all apps) - no docker inspection - so it is
 * safe on the project page's hot path; the Settings tab still does the live check.
 */

import { prisma } from "@polaris/db";
import { parseStoredTunnel } from "./quick-tunnel-store";

/**
 * A tunnel hostname shaped like an `AppDomain` row. The kind separates the two
 * sorts of tunnel because they are not interchangeable as an address: a named
 * tunnel keeps its hostname, while a quick/ngrok tunnel gets a new random one
 * every time it starts - so "tunnel-temp" must never be presented as the
 * service's address (see `domainRank`).
 */
export interface TunnelDomain {
    id: string;
    hostname: string;
    kind: "tunnel" | "tunnel-temp";
    enabled: boolean;
}

/** Setting keys holding an app's cached tunnel state (see the tunnel services). */
function keysFor(appId: string): string[] {
    return [
        `deploy.qtunnel.${appId}`,
        `deploy.ngrok.${appId}`,
        `deploy.ntunnel.${appId}.hostname`,
        `deploy.ntunnel.${appId}.disabled`
    ];
}

/** Strip scheme and path so a stored URL becomes a bare hostname for display/routing. */
function hostnameOf(value: string): string {
    return value
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .toLowerCase();
}

/**
 * Read every app's active tunnel hostnames in one query, keyed by app id. Quick and
 * ngrok tunnels clear their Setting on teardown, so a cached URL means the tunnel
 * was up; a named tunnel keeps a stable hostname and is skipped only when explicitly
 * disabled. Apps with no tunnel hostname to show are absent from the map - including
 * one whose quick tunnel is live but has not printed its URL yet.
 */
export async function listActiveTunnelDomains(appIds: string[]): Promise<Map<string, TunnelDomain[]>> {
    const result = new Map<string, TunnelDomain[]>();
    if (appIds.length === 0) return result;

    const keys = appIds.flatMap(keysFor);
    const rows = await prisma.setting.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
    const values = new Map(rows.map((row) => [row.key, row.value]));

    for (const appId of appIds) {
        const domains: TunnelDomain[] = [];
        // The quick-tunnel record is JSON `{url, startedAt}` and exists as soon as the
        // sidecar is up, so its URL is null until cloudflared prints one - there is no
        // hostname to show yet.
        const quick = values.get(`deploy.qtunnel.${appId}`);
        const quickUrl = quick ? parseStoredTunnel(quick).url : null;
        if (quickUrl) {
            domains.push({ id: `qtunnel:${appId}`, hostname: hostnameOf(quickUrl), kind: "tunnel-temp", enabled: true });
        }
        const ngrok = values.get(`deploy.ngrok.${appId}`);
        if (ngrok) domains.push({ id: `ngrok:${appId}`, hostname: hostnameOf(ngrok), kind: "tunnel-temp", enabled: true });
        const named = values.get(`deploy.ntunnel.${appId}.hostname`);
        if (named && values.get(`deploy.ntunnel.${appId}.disabled`) !== "1") {
            domains.push({ id: `ntunnel:${appId}`, hostname: hostnameOf(named), kind: "tunnel", enabled: true });
        }
        if (domains.length > 0) result.set(appId, domains);
    }
    return result;
}
