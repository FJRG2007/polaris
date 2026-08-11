/**
 * The routing table that lets every Minecraft: Java server answer on one port.
 *
 * A Java client puts the address it was given into the handshake packet, before it
 * logs in and before anything is encrypted. A router reading that field can send the
 * connection to the right server, which means every server can be reached on 25565
 * under its own name - `survival.mc.example.com` with no port for the player to
 * remember, and no SRV record for Polaris to write.
 *
 * That last part is the point. A SRV record per server is the one thing a wildcard
 * cannot replace (a wildcard may only be the leftmost label, so `_minecraft._tcp.*`
 * is not one), so it is the last thing that grew with the number of servers. Routed,
 * a server costs no DNS at all.
 *
 * Polaris writes the table; `mc-router` watches the file and reloads it. The same
 * seam the edge already uses for deployed-app routes - a file in a shared volume -
 * rather than an API call, because there is then no port, no token and no
 * reachability to get wrong, and the table survives a restart of either side.
 *
 * Backends are dialled on the host by their published port, exactly as the edge
 * dials a deployed app, so nothing about how a game server is deployed has to
 * change for it to be routable.
 */

import { join } from "node:path";
import { prisma } from "@polaris/db";
import { mkdir, writeFile } from "node:fs/promises";
import { routesByHostname } from "@/lib/apps/games-catalog";
import { readInstallConfig } from "@/lib/apps/install-config";

/** Where the table is written for the router to read. */
function routesDir(): string {
    return process.env.POLARIS_MC_ROUTES_DIR ?? "/mc-routes";
}

const ROUTES_FILE = "mc-routes.json";

/** How the router reaches the host the servers publish their ports on. The name, not
 *  an address: a lease that moves must not silently unroute every server. Kept in
 *  step with `POLARIS_APP_DIAL_HOST`, which the edge dials deployed apps by. */
function dialHost(): string {
    return process.env.POLARIS_APP_DIAL_HOST || "host.docker.internal";
}

export interface MinecraftRoute {
    /** The name a player types, which is what arrives in the handshake. */
    readonly hostname: string;
    /** Where the router sends it. */
    readonly backend: string;
}

/**
 * Every routed server, as the router's own config shape.
 *
 * Deliberately no `default-server` key: a connection for a name nothing claims is
 * dropped rather than sent somewhere. That is what keeps a port scanner - which
 * connects by address and names no hostname - from landing on somebody's world, and
 * it is why the table is an allowlist rather than a fallback.
 */
export function routesConfig(routes: readonly MinecraftRoute[]): string {
    const mappings: Record<string, string> = {};
    for (const route of routes) mappings[route.hostname] = route.backend;
    return `${JSON.stringify({ mappings }, null, 2)}\n`;
}

/**
 * The routes the current installs call for: every Java server that has been given a
 * name, has a published port to send traffic to, and has been switched to a routed
 * address.
 *
 * Opt-in per server rather than on for everything, because routing changes what the
 * server itself sees: connections arrive from the router, so the address half of the
 * player list cannot be enforced through it (see `player-access`). A server that was
 * working yesterday must not quietly lose that today.
 */
export async function minecraftRoutes(): Promise<MinecraftRoute[]> {
    const installs = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { catalogId: true, config: true, applicationId: true }
    });
    const routes: MinecraftRoute[] = [];
    for (const install of installs) {
        // Only a client that names the address it dialled can be routed by it. ARK and
        // Bedrock are UDP and carry no such field, so they keep their port.
        if (!routesByHostname(install.catalogId)) continue;
        const config = readInstallConfig(install.config);
        if (config.routed !== true) continue;
        const hostname = typeof config.hostname === "string" ? config.hostname.trim().toLowerCase() : "";
        if (!hostname) continue;
        const port = install.applicationId ? await publishedPort(install.applicationId) : null;
        if (!port) continue;
        routes.push({ hostname, backend: `${dialHost()}:${port}` });
    }
    // Two servers claiming one name would make which world a player reaches depend on
    // install order. The first wins and the second is left unrouted, which shows up as
    // a server that still needs its port - a visible state, unlike a silent swap.
    const seen = new Set<string>();
    return routes.filter((route) => {
        if (seen.has(route.hostname)) return false;
        seen.add(route.hostname);
        return true;
    });
}

/** The host port the install pinned, which is what the router has to dial. */
async function publishedPort(applicationId: string): Promise<number | null> {
    const app = await prisma.application.findUnique({ where: { id: applicationId }, select: { sourceConfig: true } });
    if (!app) return null;
    try {
        const config = JSON.parse(app.sourceConfig) as { hostPort?: unknown };
        return typeof config.hostPort === "number" ? config.hostPort : null;
    } catch {
        return null;
    }
}

/**
 * Write the table out. Called whenever something that appears in it changes - a
 * server's name, its routing, its removal - and safe to call when nothing did: the
 * router watches the file, and rewriting the same content reloads the same routes.
 *
 * Best effort by design. The routes directory only exists where the router is
 * running, so on an instance without it this fails and that is the correct outcome:
 * nothing is routed, every server keeps the address it already had.
 */
export async function syncMinecraftRoutes(): Promise<void> {
    const routes = await minecraftRoutes();
    const dir = routesDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ROUTES_FILE), routesConfig(routes), "utf8");
}
