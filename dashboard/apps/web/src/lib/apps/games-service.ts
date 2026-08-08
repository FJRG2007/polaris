/**
 * Every game server this owner runs, whatever edition, as one list.
 *
 * A game server is an installed marketplace app whose manifest declares the
 * game-server capability, so this is a view over the same installs the app pages
 * manage rather than a second place servers can exist. Each row carries what the
 * list actually shows - who is playing and where to connect - which is a live
 * read per server, gathered in parallel and never allowed to fail the list: a
 * server that is still booting is a row that says so, not a page that errors.
 */

import { prisma } from "@polaris/db";
import { freemem, totalmem } from "node:os";
import { listHosts } from "@/lib/host-service";
import { getHostLanIp } from "@/lib/host-address";
import { hostPortForApp } from "@/lib/deploy-service";
import { getLocalEnvironment } from "@/lib/network-service";
import { sweepTimeouts } from "@/lib/apps/minecraft/timeout-service";
import { readInstallConfig } from "@/lib/apps/install-config";
import { appHasCapability, findApp } from "@/lib/apps/catalog";
import { getServerMetrics } from "@/lib/server-metrics-service";
import { gameServerAddress } from "@/lib/apps/minecraft/address";
import type { PortBlocks, PortPolicy } from "@/lib/apps/port-block";
import { getPortBlocks, getPortPolicy } from "@/lib/apps/port-block-store";
import { enforcePlayerAddresses } from "@/lib/apps/minecraft/player-access";
import { gamePorts, probeReach, reachConfirmed } from "@/lib/apps/minecraft/reach";
import { gameReachAdvice, type GamePort, type GameReachAdvice } from "@/lib/apps/minecraft/reach-advice";
import { applyFirewallBans, editionOf, getServerPlayers, type MinecraftEdition } from "@/lib/apps/minecraft/service";

/** Whether a catalog id names a game server rather than any other installed app.
 *  The manifest's capability is the authority - a game server is not a list of
 *  known ids, it is anything that declares itself one. */
export function isGameServerApp(catalogId: string): boolean {
    const manifest = findApp(catalogId);
    return manifest ? appHasCapability(manifest, "game-server") : false;
}

/** A machine a server can be created on, with what it has left to give. */
export interface GameMachine {
    readonly id: string;
    readonly name: string;
    /** What the machine has, when Polaris can measure it. */
    readonly memoryTotalBytes: number | null;
    readonly memoryFreeBytes: number | null;
    /** Memory this owner's game servers on it are already promised. */
    readonly committedMb: number;
}

/**
 * What the list can say about a server from Polaris' own records: where it runs,
 * where a player connects, and whether it is meant to be up.
 *
 * Nothing here asks a container anything, so the whole list is a handful of
 * queries rather than a probe per server - which is why the page can paint the
 * machine and the address at once and let the live read catch up.
 */
export interface GameServerFacts {
    readonly id: string;
    readonly name: string;
    readonly catalogId: string;
    readonly catalogName: string;
    readonly edition: MinecraftEdition;
    /** The service backing it, for the screens that reach past the game - its
     *  files, its logs. Null for an install whose deploy never completed. */
    readonly applicationId: string | null;
    /** The machine it runs on. */
    readonly serverName: string | null;
    /** Whether it is meant to be up. Whether it is actually answering is the
     *  live read, which costs a round trip to the server itself. */
    readonly running: boolean;
    readonly address: string | null;
    /** How many players it was built for. Read from the setting rather than from
     *  the running server, so the list can say "0 / 20" about one that is down -
     *  a dash there reads as "unknown", and the number is not unknown. */
    readonly slots: number | null;
    /** Why there is no address, when there is none. */
    readonly message: string | null;
}

/** What only the server itself can answer: who is on it right now. */
export interface GameServerLive {
    readonly id: string;
    readonly answering: boolean;
    /** Whether the container is actually up, when that can be seen from here.
     *  A server Polaris means to be running and that is not is neither stopped
     *  nor starting, and the row has to be able to say so. */
    readonly containerRunning: boolean | null;
    readonly online: number;
    readonly max: number;
    readonly players: readonly string[];
    /** Why it is not answering, when it is not. */
    readonly message: string | null;
}

/** The ids of a set of rows that have one, for an `in` filter. */
function presentIds(values: readonly (string | null)[]): string[] {
    return values.filter((value): value is string => value !== null);
}

/** The owner's game servers and everything Polaris already knows about them,
 *  newest first. */
export async function listGameServerFacts(ownerId: string): Promise<GameServerFacts[]> {
    const installs = (
        await prisma.installedApp.findMany({
            where: { ownerId, status: { not: "removed" } },
            orderBy: { createdAt: "desc" }
        })
    ).filter((install) => isGameServerApp(install.catalogId));
    if (installs.length === 0) return [];

    const [targets, apps] = await Promise.all([
        prisma.deployTarget.findMany({
            where: { id: { in: presentIds(installs.map((install) => install.targetId)) } },
            select: { id: true, name: true }
        }),
        prisma.application.findMany({
            where: {
                id: { in: presentIds(installs.map((install) => install.applicationId)) },
                environment: { project: { ownerId } }
            },
            select: {
                id: true,
                sourceConfig: true,
                desiredState: true,
                currentDeploymentId: true,
                target: { select: { kind: true, hostId: true } }
            }
        })
    ]);
    const targetName = new Map(targets.map((target) => [target.id, target.name]));
    const appOf = new Map(apps.map((app) => [app.id, app]));
    const local = apps.some((app) => app.target.kind === "local" || !app.target.hostId);

    // An address needs the release the server actually publishes on, and the
    // machine's own address for every server without a name of its own. Both are
    // read once for the whole list rather than per row.
    const [isolated, hosts, lanIp, slots] = await Promise.all([
        prisma.deployment
            .findMany({
                where: { id: { in: presentIds(apps.map((app) => app.currentDeploymentId)) }, isolated: true },
                select: { id: true }
            })
            .then((rows) => new Set(rows.map((row) => row.id))),
        prisma.host
            .findMany({
                where: { id: { in: presentIds(apps.map((app) => app.target.hostId)) }, ownerId },
                select: { id: true, address: true }
            })
            .then((rows) => new Map(rows.map((row) => [row.id, row.address]))),
        local ? getHostLanIp().catch(() => null) : null,
        prisma.envVar
            .findMany({
                where: { scopeType: "application", scopeId: { in: apps.map((app) => app.id) }, key: "MAX_PLAYERS" },
                select: { scopeId: true, value: true }
            })
            .then((rows) => new Map(rows.map((row) => [row.scopeId, Number.parseInt(row.value ?? "", 10)])))
    ]);

    return installs.map((install) => {
        const app = install.applicationId ? (appOf.get(install.applicationId) ?? null) : null;
        const config = readInstallConfig(install.config);
        const hostname = typeof config.hostname === "string" ? config.hostname : null;
        const running = app?.desiredState === "running";
        return {
            id: install.id,
            name: install.name,
            catalogId: install.catalogId,
            catalogName: findApp(install.catalogId)?.name ?? install.catalogId,
            edition: editionOf(install.catalogId),
            applicationId: install.applicationId,
            serverName: install.targetId ? (targetName.get(install.targetId) ?? null) : null,
            running,
            slots: app && Number.isFinite(slots.get(app.id)) ? (slots.get(app.id) as number) : null,
            address: app
                ? gameServerAddress({
                      hostname,
                      portless: config.portless === true,
                      ip: hostname
                          ? null
                          : app.target.kind === "local" || !app.target.hostId
                            ? lanIp
                            : (hosts.get(app.target.hostId) ?? null),
                      port: pinnedHostPort(app.sourceConfig) ?? hostPortForApp(publishedSubject(app, isolated))
                  })
                : null,
            message: app ? (running ? null : "The server is stopped") : "This server is still being set up"
        };
    });
}

/** The port the install pinned for this application, when it pinned one. An
 *  unreadable config pins nothing; the derived port still applies. */
function pinnedHostPort(sourceConfig: string): number | null {
    try {
        const parsed = JSON.parse(sourceConfig) as { hostPort?: unknown };
        return typeof parsed.hostPort === "number" ? parsed.hostPort : null;
    } catch {
        return null;
    }
}

/** What the published port is derived from: the release for a server deployed in
 *  isolation, the application itself for one deployed over its predecessor. */
function publishedSubject(
    app: { id: string; currentDeploymentId: string | null },
    isolated: ReadonlySet<string>
): string {
    return app.currentDeploymentId && isolated.has(app.currentDeploymentId) ? app.currentDeploymentId : app.id;
}

/**
 * Who is on each of the owner's servers.
 *
 * One round trip into every running container, so it is deliberately apart from
 * the facts: it is what the list waits on, and nothing else should. A server that
 * is stopped is not asked at all, and one that refuses is a row that says so
 * rather than a list that fails.
 */
export async function listGameServerLive(ownerId: string): Promise<GameServerLive[]> {
    const servers = await listGameServerFacts(ownerId);
    return Promise.all(
        servers.map(async (server) => {
            if (!server.running || !server.applicationId) {
                return {
                    id: server.id,
                    answering: false,
                    containerRunning: null,
                    online: 0,
                    max: 0,
                    players: [],
                    message: server.message
                };
            }
            const live = await getServerPlayers(ownerId, server.id).catch((caught: unknown) => ({
                answering: false,
                containerRunning: null,
                players: { online: 0, max: 0, players: [] },
                message: caught instanceof Error ? caught.message : "The server is not answering"
            }));
            return {
                id: server.id,
                answering: live.answering,
                containerRunning: live.containerRunning,
                online: live.players.online,
                max: live.players.max,
                players: live.players.players,
                message: live.message
            };
        })
    );
}

/**
 * The machines a server can go on, and what each has left.
 *
 * Two numbers, because they answer different questions. What the machine has
 * free right now is measured (over SSH for a connected server, from the host this
 * process runs on for the local one) and moves. What its game servers are already
 * promised is Polaris' own bookkeeping and does not: it is the sum of the heaps
 * handed out, which is what actually decides whether the next server fits.
 */
export async function listGameMachines(ownerId: string): Promise<GameMachine[]> {
    const hosts = await listHosts(ownerId);
    const committed = await committedMemoryByTarget(ownerId);
    const local: GameMachine = {
        id: "local",
        name: "Local (this server)",
        // The web runs in a container that shares the host's memory accounting, so
        // these are the machine's figures unless it was given a limit of its own.
        memoryTotalBytes: totalmem(),
        memoryFreeBytes: freemem(),
        committedMb: committed.get("local") ?? 0
    };
    const remote = await Promise.all(
        hosts.map(async (host) => {
            const metrics = await getServerMetrics(host.id, ownerId).catch(() => null);
            return {
                id: host.id,
                name: host.name,
                memoryTotalBytes: metrics?.memoryTotalBytes ?? null,
                memoryFreeBytes:
                    metrics?.memoryTotalBytes !== null &&
                    metrics?.memoryTotalBytes !== undefined &&
                    metrics.memoryUsedBytes !== null
                        ? metrics.memoryTotalBytes - metrics.memoryUsedBytes
                        : null,
                committedMb: committed.get(host.id) ?? 0
            };
        })
    );
    return [local, ...remote];
}

/** Megabytes of heap this owner's game servers have been given, per machine. */
async function committedMemoryByTarget(ownerId: string): Promise<Map<string, number>> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, applicationId: { not: null } },
        select: { catalogId: true, applicationId: true, targetId: true }
    });
    const games = installs.filter((install) => isGameServerApp(install.catalogId));
    if (games.length === 0) return new Map();

    const targets = await prisma.deployTarget.findMany({
        where: { id: { in: games.map((game) => game.targetId).filter((id): id is string => id !== null) } },
        select: { id: true, kind: true, hostId: true }
    });
    const machineOf = new Map(targets.map((target) => [target.id, target.kind === "host" && target.hostId ? target.hostId : "local"]));

    const vars = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            scopeId: { in: games.map((game) => game.applicationId as string) },
            key: "MEMORY"
        },
        select: { scopeId: true, value: true }
    });
    const memoryOf = new Map(vars.map((row) => [row.scopeId, parseMemoryMb(row.value ?? "")]));

    const byMachine = new Map<string, number>();
    for (const game of games) {
        const machine = game.targetId ? (machineOf.get(game.targetId) ?? "local") : "local";
        const megabytes = memoryOf.get(game.applicationId as string) ?? 0;
        byMachine.set(machine, (byMachine.get(machine) ?? 0) + megabytes);
    }
    return byMachine;
}

/** "2G", "2560M" or a bare number of megabytes, as megabytes. */
export function parseMemoryMb(value: string): number {
    const match = /^(\d+(?:\.\d+)?)\s*([gGmM])?$/.exec(value.trim());
    if (!match) return 0;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return 0;
    return match[2]?.toLowerCase() === "g" ? Math.round(amount * 1024) : Math.round(amount);
}

/**
 * Hand every running server the addresses the firewall blocks.
 *
 * A blocklist that only applies where somebody pressed a button is not a
 * blocklist, so this is the pass that makes it true everywhere: it walks the
 * owner's game servers and bans on each what it has not banned yet. Best effort
 * per server - one that is still starting is skipped, not fatal - and it reports
 * what it did so the caller can log it.
 */
export async function syncFirewallBans(ownerId: string): Promise<{ servers: number; banned: number; kicked: number }> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" } },
        select: { id: true, catalogId: true }
    });
    let servers = 0;
    let banned = 0;
    let kicked = 0;
    for (const install of installs) {
        if (!isGameServerApp(install.catalogId)) continue;
        // Bedrock has no ban command at all, so there is nothing to hand it.
        if (editionOf(install.catalogId) === "bedrock") continue;
        const applied = await applyFirewallBans(ownerId, install.id).catch(() => null);
        if (applied === null) continue;
        servers += 1;
        banned += applied;
        // A timeout is a ban with an end, and this walk is the thing that comes
        // back to lift it. Without it a ten-minute cool-off is a permanent ban.
        await sweepTimeouts(ownerId, install.id).catch(() => 0);
        // The same walk carries the player list, which is the half of the firewall
        // the game itself cannot hold: a name is only let in from its own address.
        const access = await enforcePlayerAddresses(ownerId, install.id).catch(() => null);
        kicked += access?.kicked.length ?? 0;
    }
    return { servers, banned, kicked };
}

/** One game server's published ports, named so a forwarding rule can be written
 *  for it. Instance-wide: what has to be open is the operator's problem, not one
 *  owner's, and the domain setup that asks for it is an admin screen. */
export interface GamePortRow {
    readonly installedAppId: string;
    readonly name: string;
    readonly ports: readonly GamePort[];
    /** Whether a player has already arrived on it from outside the network. */
    readonly confirmed: boolean;
}

/**
 * The game server backing a deployed application, when it is one.
 *
 * The firewall picks its scope from the deploy tree, where a game server is an
 * ordinary service - so this is how that screen finds out it is looking at
 * something whose rules are not HTTP rules at all.
 */
export async function gameServerForApplication(
    ownerId: string,
    applicationId: string
): Promise<{ installedAppId: string; name: string } | null> {
    const install = await prisma.installedApp.findFirst({
        where: { ownerId, applicationId, status: { not: "removed" } },
        select: { id: true, name: true, catalogId: true }
    });
    if (!install || !isGameServerApp(install.catalogId)) return null;
    return { installedAppId: install.id, name: install.name };
}

/** Every game server's published ports, for the screens that ask an operator to
 *  open them. */
export async function listGamePorts(): Promise<GamePortRow[]> {
    const installs = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { id: true, name: true, catalogId: true, applicationId: true, config: true }
    });
    const games = installs.filter((install) => isGameServerApp(install.catalogId));
    const rows = await Promise.all(
        games.map(async (install) => ({
            installedAppId: install.id,
            name: install.name,
            ports: await gamePorts(install.applicationId),
            confirmed: reachConfirmed(install.config)
        }))
    );
    return rows.filter((row) => row.ports.length > 0);
}

/** Every game server's ports, what is still in the way of the ones not proven,
 *  and the settings the router instructions are written from. */
export interface GamePortsReading {
    readonly servers: readonly GamePortRow[];
    readonly advice: GameReachAdvice;
    /** This server's address on the network, for the rules to point at. */
    readonly lanIp: string | null;
    readonly policy: PortPolicy;
    readonly blocks: PortBlocks;
}

/**
 * The whole of what the Domains card shows, in one read.
 *
 * Shared with the endpoint that card polls, so the first paint and every refresh
 * afterwards are built the same way - a card that says one thing on load and
 * another a second later would be reporting the refresh, not the network.
 *
 * `probe` is off for a render and on for a poll: knocking on a closed port waits
 * out a timeout, and an admin page must not be held open by it.
 */
export async function readGamePorts(probe = false): Promise<GamePortsReading> {
    const [servers, { environment }, lanIp, policy, blocks] = await Promise.all([
        listGamePorts(),
        getLocalEnvironment().catch(() => ({ environment: "unknown" as const })),
        getHostLanIp().catch(() => null),
        getPortPolicy(),
        getPortBlocks()
    ]);
    const proven = probe
        ? new Set(await probeReach(servers.filter((server) => !server.confirmed)))
        : new Set<string>();
    const rows =
        proven.size === 0
            ? servers
            : servers.map((server) =>
                  proven.has(server.installedAppId) ? { ...server, confirmed: true } : server
              );
    const pending = rows.filter((server) => !server.confirmed);
    return {
        servers: rows,
        advice: gameReachAdvice(
            environment,
            pending.flatMap((server) => server.ports),
            pending.length === 0,
            lanIp,
            policy,
            blocks
        ),
        lanIp,
        policy,
        blocks
    };
}
