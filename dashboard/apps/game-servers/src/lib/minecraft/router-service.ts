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
import { gameServerCatalogIds } from "../game-catalog";

const { readInstallConfig } = host.appsInstallConfig;
const { readHostTable, routerRunningOn, startRouterOn, writeHostTable } = host.minecraftRouter;

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

/** When each retired name was retired, beside the table rather than in it: the
 *  router reads only the table. */
const RETIRED_FILE = "mc-routes-retired.json";

/** How long a retired name stays in the table. The router reads a change after
 *  five seconds of quiet, so this is far past the last moment it could miss one. */
const RETIRED_FOR_MS = 60 * 60_000;

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
 * The machine a server's routes live on: the Host id of a connected server, or
 * `LOCAL_SHARD` for the one Polaris runs on.
 *
 * Each machine that runs Java servers has a router and a table of its own, holding
 * only that machine's servers - a route dials a published port on the router's own
 * machine, so no router can serve another's. A change rewrites one machine's table,
 * never the fleet's, and a single-machine install has exactly one shard: this one.
 */
export const LOCAL_SHARD = "local";

/** Which shard a deploy target's servers belong to. Pure. */
export function shardOf(target: { kind: string; hostId: string | null } | null | undefined): string {
    return target && target.kind !== "local" && target.hostId ? target.hostId : LOCAL_SHARD;
}

/** How a connected server's router reaches the servers beside it: the host gateway,
 *  which its compose file maps to this name. */
const REMOTE_DIAL_HOST = "host.docker.internal";

/** A route, with the shard it belongs to and whether its server is routed for good
 *  (rather than a candidate the sweep is still checking). */
export interface ShardRoute extends MinecraftRoute {
    readonly shard: string;
    readonly routed: boolean;
}

/**
 * Routes grouped by machine, one table each. Pure.
 *
 * Two servers claiming one name on a machine would make which world a player reaches
 * depend on install order. The first wins and the second is left unrouted, which shows
 * up as a server that still needs its port - a visible state, unlike a silent swap.
 */
export function routesByShard(routes: readonly ShardRoute[]): Map<string, ShardRoute[]> {
    const shards = new Map<string, ShardRoute[]>();
    const seen = new Map<string, Set<string>>();
    for (const route of routes) {
        const names = seen.get(route.shard) ?? new Set<string>();
        seen.set(route.shard, names);
        if (names.has(route.hostname)) continue;
        names.add(route.hostname);
        const list = shards.get(route.shard) ?? [];
        list.push(route);
        shards.set(route.shard, list);
    }
    return shards;
}

/** The deploy targets on one machine. Few per machine, one indexed query. */
async function shardTargets(shard: string): Promise<string[]> {
    const targets = await prisma.deployTarget.findMany({
        where: shard === LOCAL_SHARD ? { OR: [{ kind: "local" }, { hostId: null }] } : { hostId: shard },
        select: { id: true }
    });
    return targets.map((target) => target.id);
}

/**
 * Every route the current installs call for, on one machine or on all of them: every
 * Java server that has been given a name, has a published port to send traffic to,
 * and is either routed or waiting to be (`ROUTE_CANDIDATE_KEY`).
 *
 * A server whose player list is bound to addresses is never either: connections
 * arrive from the router, so the address half of that list cannot be enforced
 * through it (see `addressesSurviveRouting`).
 *
 * Read a page at a time, with one application lookup per page, so the table costs a
 * number of round trips that grows with pages rather than with servers. Narrowed to
 * one machine, it reads only that machine's installs.
 */
export async function shardRoutes(shard?: string): Promise<ShardRoute[]> {
    const targetIds = shard === undefined ? undefined : await shardTargets(shard);
    if (targetIds && targetIds.length === 0) return [];
    const routes: ShardRoute[] = [];
    let cursor: string | undefined;
    for (;;) {
        const installs = await prisma.installedApp.findMany({
            where: {
                status: { not: "removed" },
                ...(targetIds ? { targetId: { in: targetIds } } : {})
            },
            select: { id: true, catalogId: true, config: true, applicationId: true },
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
        });
        const wanted: { hostname: string; applicationId: string; routed: boolean }[] = [];
        for (const install of installs) {
            // Only a client that names the address it dialled can be routed by it. ARK
            // and Bedrock are UDP and carry no such field, so they keep their port.
            if (!routesByHostname(install.catalogId) || !install.applicationId) continue;
            const config = readInstallConfig(install.config);
            if (config.routed !== true && config[ROUTE_CANDIDATE_KEY] !== true) continue;
            const hostname =
                typeof config.hostname === "string" ? config.hostname.trim().toLowerCase() : "";
            if (hostname)
                wanted.push({ hostname, applicationId: install.applicationId, routed: config.routed === true });
        }
        const placed = await publishedPorts(wanted.map((entry) => entry.applicationId));
        for (const entry of wanted) {
            const found = placed.get(entry.applicationId);
            if (!found) continue;
            const where = shardOf(found.target);
            if (shard !== undefined && where !== shard) continue;
            const dial = where === LOCAL_SHARD ? dialHost() : REMOTE_DIAL_HOST;
            routes.push({
                hostname: entry.hostname,
                backend: `${dial}:${found.port}`,
                shard: where,
                routed: entry.routed
            });
        }
        if (installs.length < PAGE_SIZE) break;
        cursor = installs[installs.length - 1]?.id;
    }
    return routes;
}

/** The routes one machine's table holds, or every machine's, in the router's shape. */
export async function minecraftRoutes(shard?: string): Promise<MinecraftRoute[]> {
    const shards = routesByShard(await shardRoutes(shard));
    return [...shards.values()].flat().map(({ hostname, backend }) => ({ hostname, backend }));
}

/** The host port each install pinned, and the machine it runs on, which is what the
 *  router has to dial and whose router does. One query for a page of servers. */
async function publishedPorts(
    applicationIds: readonly string[]
): Promise<Map<string, { port: number; target: { kind: string; hostId: string | null } | null }>> {
    const ports = new Map<string, { port: number; target: { kind: string; hostId: string | null } | null }>();
    if (applicationIds.length === 0) return ports;
    const apps = await prisma.application.findMany({
        where: { id: { in: [...applicationIds] } },
        select: { id: true, sourceConfig: true, target: { select: { kind: true, hostId: true } } }
    });
    for (const app of apps) {
        try {
            const config = JSON.parse(app.sourceConfig) as { hostPort?: unknown };
            if (typeof config.hostPort === "number")
                ports.set(app.id, { port: config.hostPort, target: app.target ?? null });
        } catch {
            // A source config that cannot be read has no port to route to.
        }
    }
    return ports;
}

/** The machine an install runs on, for a change that only touches its own table. */
export async function installShard(installedAppId: string): Promise<string> {
    const install = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { targetId: true }
    });
    if (!install?.targetId) return LOCAL_SHARD;
    const target = await prisma.deployTarget.findUnique({
        where: { id: install.targetId },
        select: { kind: true, hostId: true }
    });
    return shardOf(target);
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
 * however many writes after it was removed - for `RETIRED_FOR_MS` from when it was
 * (`since`, by name), long enough for any running router to have read it. After
 * that it is dropped: the router that read it keeps it pointed nowhere, and one
 * started since never had it.
 */
export function retiredRoutes(
    previous: string | null,
    current: readonly MinecraftRoute[],
    since: Readonly<Record<string, number>> = {},
    now: number = Date.now()
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
        .filter((hostname) => now - (since[hostname] ?? now) < RETIRED_FOR_MS)
        .map((hostname) => ({ hostname, backend: `${dialHost()}:${RETIRED_PORT}` }));
}

/** When each retired name was retired, for the ones still in the table: kept from
 *  `since`, or now for a name retired by this write. */
export function retiredSince(
    retired: readonly MinecraftRoute[],
    since: Readonly<Record<string, number>>,
    now: number = Date.now()
): Record<string, number> {
    const next: Record<string, number> = {};
    for (const route of retired) next[route.hostname] = since[route.hostname] ?? now;
    return next;
}

/** The retirement times as last written, or none when there are none to read. */
function readRetiredSince(text: string | null): Record<string, number> {
    if (!text) return {};
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const since: Record<string, number> = {};
        for (const [hostname, at] of Object.entries(parsed)) {
            if (typeof at === "number" && Number.isFinite(at)) since[hostname] = at;
        }
        return since;
    } catch {
        return {};
    }
}

/**
 * The table a machine should hold next, or null when what it holds is already that.
 * Pure. A machine that has no table and nothing to route is left alone (null): a
 * connected server nobody routed anything to never gets a file or a router.
 */
export function nextTable(
    previous: string | null,
    routes: readonly MinecraftRoute[],
    always: boolean,
    since: Readonly<Record<string, number>> = {},
    now: number = Date.now()
): string | null {
    if (previous === null && routes.length === 0 && !always) return null;
    const next = routesConfig([...routes, ...retiredRoutes(previous, routes, since, now)]);
    return next === previous ? null : next;
}

async function readTable(shard: string): Promise<string | null> {
    if (shard !== LOCAL_SHARD) return readHostTable(shard);
    return readFile(join(routesDir(), ROUTES_FILE), "utf8").catch(() => null);
}

async function writeTable(shard: string, table: string): Promise<void> {
    if (shard !== LOCAL_SHARD) return writeHostTable(shard, table);
    const dir = routesDir();
    await mkdir(dir, { recursive: true });
    // Written in place, unlike the edge's dynamic files (`writeDynamicFile`). The
    // router watches this one file by name, and a rename over it replaces the inode
    // the watch is on, so no reload after the first would ever happen. A reader
    // catching it half-written is harmless: mc-router waits five seconds of quiet
    // before reading, and a table it cannot parse is logged while the routes it
    // already has are kept.
    await writeFile(join(dir, ROUTES_FILE), table, "utf8");
}

/** One machine's table, written only when it changed. This machine's is always
 *  written, empty included, because its router exits at startup without one - and so
 *  is a connected server's when `always` says its router is about to be started. */
async function syncShard(shard: string, routes: readonly MinecraftRoute[], always = false): Promise<void> {
    const previous = await readTable(shard);
    const since = await readSince(shard);
    const now = Date.now();
    const nextSince = retiredSince(retiredRoutes(previous, routes, since, now), since, now);
    if (JSON.stringify(nextSince) !== JSON.stringify(since))
        await writeSince(shard, nextSince).catch(() => undefined);
    const next = nextTable(previous, routes, always || shard === LOCAL_SHARD, since, now);
    if (next !== null) await writeTable(shard, next);
}

/** Where a machine's retirement times are kept: beside this machine's table, since
 *  only the dashboard reads them - a connected server's router never needs them. */
function sinceFile(shard: string): string {
    const name =
        shard === LOCAL_SHARD
            ? RETIRED_FILE
            : `mc-routes-retired-${shard.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
    return join(routesDir(), name);
}

async function readSince(shard: string): Promise<Record<string, number>> {
    return readRetiredSince(await readFile(sinceFile(shard), "utf8").catch(() => null));
}

/** Best effort: a time that could not be kept only means the name is retired for
 *  longer, never that a route goes missing. */
async function writeSince(shard: string, since: Record<string, number>): Promise<void> {
    await mkdir(routesDir(), { recursive: true });
    await writeFile(sinceFile(shard), `${JSON.stringify(since)}\n`, "utf8");
}

/** Connected servers that have ever run a Java server here, removed ones included,
 *  so a machine whose last routed server went away still has its names retired. Few
 *  targets, and one grouped query over the installs on them. */
async function knownRemoteShards(): Promise<string[]> {
    const targets = await prisma.deployTarget.findMany({
        where: { hostId: { not: null } },
        select: { id: true, kind: true, hostId: true }
    });
    if (targets.length === 0) return [];
    const used = await prisma.installedApp.groupBy({
        by: ["targetId"],
        where: {
            targetId: { in: targets.map((target) => target.id) },
            catalogId: { in: gameServerCatalogIds().filter(routesByHostname) }
        }
    });
    const usedIds = new Set(used.map((row) => row.targetId));
    return [
        ...new Set(
            targets
                .filter((target) => usedIds.has(target.id))
                .map((target) => shardOf(target))
                .filter((shard) => shard !== LOCAL_SHARD)
        )
    ];
}

/**
 * Write the tables out. Called whenever something that appears in them changes - a
 * server's name, its routing, its removal - and safe to call when nothing did: an
 * unchanged table is not written at all, since every write makes the router read and
 * register the whole of it again.
 *
 * Given the install that changed, only its machine's table is rebuilt and written, so
 * a change costs that machine's servers and nothing more. Without one (the sweep)
 * every machine's table is rebuilt from one pass over the installs, and a connected
 * server with servers routed for good gets its router repaired: deployed again if it
 * is not running, which `compose up -d` makes a no-op when it is.
 *
 * `always` writes the install's machine's table even when it would hold nothing,
 * which is what has to happen just before that machine's router is started.
 *
 * Best effort by design. The routes directory only exists where the router is
 * running, so on an instance without it this fails and that is the correct outcome:
 * nothing is routed, every server keeps the address it already had. Machines are
 * synced side by side, so one that cannot be reached neither stops nor delays the
 * others' tables.
 */
export async function syncMinecraftRoutes(
    installedAppId?: string,
    options: { always?: boolean } = {}
): Promise<void> {
    if (installedAppId) {
        const shard = await installShard(installedAppId);
        await syncShard(shard, await minecraftRoutes(shard), options.always === true);
        return;
    }
    const shards = routesByShard(await shardRoutes());
    for (const shard of [LOCAL_SHARD, ...(await knownRemoteShards().catch(() => []))]) {
        if (!shards.has(shard)) shards.set(shard, []);
    }
    await Promise.all(
        [...shards].map(async ([shard, routes]) => {
            const table = routes.map(({ hostname, backend }) => ({ hostname, backend }));
            const written = await syncShard(shard, table).then(
                () => true,
                () => false
            );
            if (!written || shard === LOCAL_SHARD || !routes.some((route) => route.routed)) return;
            await repairRouterOn(shard).catch(() => undefined);
        })
    );
}

/** Deploy a connected server's router again when it is not running. Only for a
 *  machine with servers routed for good: a candidate's SRV record still answers, and
 *  the sweep never claims a port on a machine nobody routed anything on. */
async function repairRouterOn(shard: string): Promise<void> {
    if (await routerRunningOn(shard)) return;
    await startRouterOn(shard, routerPort());
}

/** The port the hostname router answers on, which is the default Minecraft port
 *  unless the operator moved it. The same on every machine. */
export function routerPort(): number {
    const configured = Number(process.env.POLARIS_MC_ROUTER_PORT);
    return Number.isInteger(configured) && configured > 0 && configured < 65536
        ? configured
        : 25565;
}
