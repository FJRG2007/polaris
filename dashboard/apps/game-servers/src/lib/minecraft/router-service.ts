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

import { routesByHostname } from "@polaris/core";
import { join } from "node:path";
import { prisma } from "@polaris/db";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { host } from "@polaris/app-host";

const { readInstallConfig } = host.appsInstallConfig;

/** Where the table is written for the router to read. */
function routesDir(): string {
    return process.env.POLARIS_MC_ROUTES_DIR ?? "/mc-routes";
}

const ROUTES_FILE = "mc-routes.json";

/**
 * A server not routed yet but waiting to be: its route is in the table, its SRV
 * record is still in DNS, and the next sweep asks the router for it by name. It is
 * only switched over once the router answers for it (`adoptRoutedAddress`), so an
 * existing address is never taken away on the strength of a route nobody has seen
 * work.
 */
export const ROUTE_CANDIDATE_KEY = "routeCandidate";

/** Where the router answers on the dashboard's own network. Both ways of running it
 *  name the service `mc-router`, and inside its container it listens on the game's
 *  port whatever host port it was published on. */
export function routerAddress(): { host: string; port: number } {
    return { host: process.env.POLARIS_MC_ROUTER_HOST || "mc-router", port: 25565 };
}

/** The backend a retired name is pointed at. Nothing listens on port 0, so the
 *  dial fails and the player is dropped. */
const RETIRED_PORT = 0;

/** Installs read per query when the table is built. */
const PAGE_SIZE = 2000;

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
 * name, has a published port to send traffic to, and is either routed or waiting to
 * be (`ROUTE_CANDIDATE_KEY`).
 *
 * A server whose player list is bound to addresses is never either: connections
 * arrive from the router, so the address half of that list cannot be enforced
 * through it (see `addressesSurviveRouting`). A server that was working yesterday
 * must not quietly lose that today.
 *
 * Read a page at a time, with one application lookup per page, so the table costs
 * a number of round trips that grows with pages rather than with servers.
 */
export async function minecraftRoutes(): Promise<MinecraftRoute[]> {
    const routes: MinecraftRoute[] = [];
    let cursor: string | undefined;
    for (;;) {
        const installs = await prisma.installedApp.findMany({
            where: { status: { not: "removed" } },
            select: { id: true, catalogId: true, config: true, applicationId: true },
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        const wanted: { hostname: string; applicationId: string }[] = [];
        for (const install of installs) {
            // Only a client that names the address it dialled can be routed by it. ARK
            // and Bedrock are UDP and carry no such field, so they keep their port.
            if (!routesByHostname(install.catalogId) || !install.applicationId) continue;
            const config = readInstallConfig(install.config);
            if (config.routed !== true && config[ROUTE_CANDIDATE_KEY] !== true) continue;
            const hostname =
                typeof config.hostname === "string" ? config.hostname.trim().toLowerCase() : "";
            if (hostname) wanted.push({ hostname, applicationId: install.applicationId });
        }
        const ports = await publishedPorts(wanted.map((entry) => entry.applicationId));
        for (const entry of wanted) {
            const port = ports.get(entry.applicationId);
            if (port) routes.push({ hostname: entry.hostname, backend: `${dialHost()}:${port}` });
        }
        if (installs.length < PAGE_SIZE) break;
        cursor = installs[installs.length - 1]?.id;
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

/** The host port each install pinned, which is what the router has to dial. One
 *  query for a page of servers rather than one per server. */
async function publishedPorts(applicationIds: readonly string[]): Promise<Map<string, number>> {
    const ports = new Map<string, number>();
    if (applicationIds.length === 0) return ports;
    const apps = await prisma.application.findMany({
        where: { id: { in: [...applicationIds] } },
        select: { id: true, sourceConfig: true }
    });
    for (const app of apps) {
        try {
            const config = JSON.parse(app.sourceConfig) as { hostPort?: unknown };
            if (typeof config.hostPort === "number") ports.set(app.id, config.hostPort);
        } catch {
            // A source config that cannot be read has no port to route to.
        }
    }
    return ports;
}

/**
 * The names the router is holding that the table no longer has, pointed nowhere.
 *
 * mc-router re-reads a watched table by registering every mapping in it over what
 * it already holds and never clears first (its watcher calls `Load`, not the
 * `Reload` a SIGHUP runs). So a name simply left out of the file stays routed to
 * its old port until the router restarts - and ports are reused by the next server
 * created, so a removed or renamed server's old name would land players on somebody
 * else's world. Writing the name with a backend nothing listens on is what actually
 * takes it away.
 *
 * Carried forward from the file the router last read, so a name stays retired
 * however many writes after it was removed.
 */
export function retiredRoutes(
    previous: string | null,
    current: readonly MinecraftRoute[]
): MinecraftRoute[] {
    if (!previous) return [];
    let mappings: unknown;
    try {
        mappings = (JSON.parse(previous) as { mappings?: unknown }).mappings;
    } catch {
        return [];
    }
    if (!mappings || typeof mappings !== "object") return [];
    const live = new Set(current.map((route) => route.hostname));
    return Object.keys(mappings)
        .filter((hostname) => !live.has(hostname))
        .map((hostname) => ({ hostname, backend: `${dialHost()}:${RETIRED_PORT}` }));
}

/**
 * Write the table out. Called whenever something that appears in it changes - a
 * server's name, its routing, its removal - and safe to call when nothing did: an
 * unchanged table is not written at all, since every write makes the router read
 * and register the whole of it again.
 *
 * Best effort by design. The routes directory only exists where the router is
 * running, so on an instance without it this fails and that is the correct outcome:
 * nothing is routed, every server keeps the address it already had.
 */
export async function syncMinecraftRoutes(): Promise<void> {
    const routes = await minecraftRoutes();
    const dir = routesDir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, ROUTES_FILE);
    const previous = await readFile(file, "utf8").catch(() => null);
    const next = routesConfig([...routes, ...retiredRoutes(previous, routes)]);
    if (next === previous) return;
    // Written in place, unlike the edge's dynamic files (`writeDynamicFile`). The
    // router watches this one file by name, and a rename over it replaces the inode
    // the watch is on, so no reload after the first would ever happen. A reader
    // catching it half-written is harmless: mc-router waits five seconds of quiet
    // before reading, and a table it cannot parse is logged while the routes it
    // already has are kept.
    await writeFile(file, next, "utf8");
}
