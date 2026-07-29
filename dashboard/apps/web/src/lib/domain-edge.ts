/**
 * The dashboard's own route at the edge.
 *
 * Deployed apps get their hostnames written into Traefik's watched directory as they
 * are created, but the dashboard's router comes from the compose labels, whose host
 * rule is fixed at `up` time from `POLARIS_PUBLIC_DOMAIN`. Nothing sets that variable,
 * so a domain configured in the admin panel was saved, verified, and then 404'd at the
 * edge - the record pointed here and the edge did not know the name.
 *
 * So the configured public hostnames are published the same way an app's are: a small
 * file the edge hot-reloads, written whenever the domains change and again on startup.
 * A Let's Encrypt certificate and the redirect off :80 come with it, which is what the
 * dashboard's own labels do for the local names.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { polarisZoneHost } from "./domain-zones";
import { getSetting } from "./setting-store";

/** Traefik's file-provider directory, the volume both containers mount. */
function dynamicDir(): string {
    return process.env.POLARIS_TRAEFIK_DYNAMIC_DIR ?? "/dynamic";
}

/** The origin the edge dials for the dashboard, by service DNS on the compose network. */
function dashboardOrigin(): string {
    return process.env.POLARIS_WEB_ORIGIN ?? "http://web:3000";
}

const FILE = "polaris-dashboard.yml";
const ROUTER = "polaris-dashboard";
/** Its own redirect middleware: the file provider merges every file into one config,
 *  so reusing the name the app routes define would be a duplicate definition. */
const REDIRECT = `${ROUTER}-redirect-https`;
/** Below the terminal WebSocket router's 100, which carries no host of its own and
 *  has to keep winning its path prefix on these hostnames too. Traefik otherwise
 *  ranks by rule length, and a few hostnames is enough to overtake it. */
const PRIORITY = 50;

/** Suffixes that never get a public certificate, so an ACME order on one is an order
 *  that retries until it is rate-limited. */
const PRIVATE_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home.arpa"];

/**
 * A stored domain as the bare hostname to route, or null when it is not a public name.
 * Stored values are whatever was typed - `https://example.com/`, a trailing dot, an
 * uppercase letter - and the ones that are a LAN name or an IP are already served by
 * the compose labels and their internal certificate.
 */
export function publicHostname(value: string | null | undefined): string | null {
    if (!value) return null;
    const host = value
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/[/?#].*$/, "")
        .replace(/:\d+$/, "")
        .replace(/\.$/, "");
    if (!host || !host.includes(".")) return null;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
    if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
    return host;
}

/**
 * Render the edge config for a set of dashboard hostnames. Pure, so what the edge is
 * asked to serve can be asserted without a filesystem.
 */
export function renderDashboardConfig(hosts: readonly string[]): string {
    if (hosts.length === 0) return "http: {}\n";
    const rule = hosts.map((host) => `Host(\`${host}\`)`).join(" || ");
    return [
        "http:",
        "  routers:",
        `    ${ROUTER}:`,
        `      rule: "${rule}"`,
        "      entryPoints: [websecure]",
        `      priority: ${PRIORITY}`,
        `      service: ${ROUTER}`,
        "      tls:",
        "        certResolver: letsencrypt",
        `    ${ROUTER}-http:`,
        `      rule: "${rule}"`,
        "      entryPoints: [web]",
        `      priority: ${PRIORITY}`,
        `      service: ${ROUTER}`,
        `      middlewares: [${REDIRECT}]`,
        "  services:",
        `    ${ROUTER}:`,
        "      loadBalancer:",
        "        servers:",
        `          - url: "${dashboardOrigin()}"`,
        "  middlewares:",
        `    ${REDIRECT}:`,
        "      redirectScheme:",
        "        scheme: https",
        ""
    ].join("\n");
}

/**
 * Every public hostname the dashboard answers on: the configured app domain, the
 * sharing domain (share links and drop points are served by the dashboard itself, so
 * a route it lacks is a link that 404s), and the Polaris zone from the guided setup.
 *
 * The zone is included on its own account rather than waiting for the setup to move
 * the app domain onto it: that move only happens once the zone has been seen answering
 * here, which it cannot do until the edge serves it.
 */
export async function dashboardHosts(): Promise<string[]> {
    const [app, sharing, zone] = await Promise.all([
        getSetting("domain.app"),
        getSetting("domain.sharing"),
        polarisZoneHost()
    ]);
    const hosts = [app, sharing, zone].map(publicHostname).filter((host): host is string => host !== null);
    return [...new Set(hosts)];
}

/**
 * Publish the dashboard's public hostnames to the edge. Idempotent, and best-effort in
 * the same way the local CA is: the dashboard is reachable on its local names either
 * way, so a dynamic directory that is missing (a dev run outside compose) must not turn
 * saving a domain into an error.
 */
export async function syncDashboardRoute(): Promise<void> {
    try {
        await writeFile(join(dynamicDir(), FILE), renderDashboardConfig(await dashboardHosts()), "utf8");
    } catch (error) {
        console.error("polaris: publishing the dashboard route failed:", error instanceof Error ? error.message : error);
    }
}
