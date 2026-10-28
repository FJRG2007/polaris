/**
 * The edge, as an installable app may use it: one dynamic file of its own,
 * `polaris-app-<id>.yml`, that routes hostnames the app owns to the dashboard.
 *
 * The app renders the file (a pure function it tests); this module only writes
 * it, always through `writeDynamicFile`, and empties it when the app is
 * uninstalled, so a route never outlives the code that answers it. Emptied
 * rather than deleted, to `NO_ROUTES_FILE`, through the same atomic rename
 * every other edge file goes through.
 */

import { prisma } from "@polaris/db";
import { NO_ROUTES_FILE } from "@polaris/core";
import { writeDynamicFile } from "@/lib/traefik-dynamic";
import { dashboardHosts, dashboardOrigin } from "@/lib/domain-edge";

const APP_ID = /^[a-z][a-z0-9-]{0,40}$/;

/** What an app's edge file holds when it routes nothing. */
export const EMPTY_EDGE = NO_ROUTES_FILE;

/** The file an app's routes live in. */
export function appEdgeFile(appId: string): string {
    if (!APP_ID.test(appId)) throw new Error(`Not an app id: ${appId}`);
    return `polaris-app-${appId}.yml`;
}

/** Writes an app's routes. Throws when the edge directory cannot be written. */
export async function writeAppEdge(appId: string, content: string): Promise<void> {
    await writeDynamicFile(appEdgeFile(appId), content);
}

/** Removes every route an app published. Best-effort: logs and carries on. */
export async function clearAppEdge(appId: string): Promise<void> {
    if (!APP_ID.test(appId)) return;
    await writeDynamicFile(appEdgeFile(appId), EMPTY_EDGE).catch((error: unknown) =>
        console.error(
            `polaris: ${appId}'s edge routes could not be removed:`,
            error instanceof Error ? error.message : error
        )
    );
}

/** The origin an app's routes send requests to: the dashboard, as its own
 *  public hostnames do. */
export async function appEdgeOrigin(): Promise<string> {
    return dashboardOrigin();
}

/** Whether another router already answers for this hostname: the dashboard's
 *  own public names, a deployed service's domain, or a WireGuard tunnel. */
export async function edgeHostnameTaken(hostname: string): Promise<boolean> {
    const host = hostname.trim().toLowerCase();
    const [dashboard, domain, tunnel] = await Promise.all([
        dashboardHosts(),
        prisma.domain.findUnique({ where: { hostname: host }, select: { id: true } }),
        prisma.wireguardTunnel.findUnique({ where: { hostname: host }, select: { id: true } })
    ]);
    return dashboard.includes(host) || domain !== null || tunnel !== null;
}
