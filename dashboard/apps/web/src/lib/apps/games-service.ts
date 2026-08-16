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
import { RELEASE_KEY } from "@/lib/apps/games-create";
import type { CrashLoop } from "@/lib/apps/crash-loop";
import { readServerUptime } from "@/lib/apps/games-uptime";
import { getLocalEnvironment } from "@/lib/network-service";
import { hasCrossplay } from "@/lib/apps/minecraft/blueprints";
import { appHasCapability, findApp } from "@/lib/apps/catalog";
import { drainQueue } from "@/lib/apps/minecraft/queue-service";
import { gameServerAddress } from "@/lib/apps/minecraft/address";
import { sweepArkTimeouts } from "@/lib/apps/ark/timeout-service";
import type { PortBlocks, PortPolicy } from "@/lib/apps/port-block";
import { wantsLatest } from "@/lib/apps/minecraft/blueprint-version";
import { gameOfServer, type GameId } from "@/lib/apps/games-catalog";
import { sweepTimeouts } from "@/lib/apps/minecraft/timeout-service";
import { applyAllowList, getArkPlayers } from "@/lib/apps/ark/service";
import { applyPendingArkRules } from "@/lib/apps/ark/settings-service";
import { syncMinecraftRoutes } from "@/lib/apps/minecraft/router-service";
import { getPortBlocks, getPortPolicy } from "@/lib/apps/port-block-store";
import { enforcePlayerAddresses } from "@/lib/apps/minecraft/player-access";
import { sweepInventorySnapshots } from "@/lib/apps/minecraft/inventory-service";
import { readInstallConfig, type InstallConfig } from "@/lib/apps/install-config";
import { getServerMetrics, peekServerMetrics } from "@/lib/server-metrics-service";
import { applyFirewallBans, editionOf, getServerPlayers } from "@/lib/apps/minecraft/service";
import {
    gamePorts,
    probeListening,
    probeReach,
    reachConfirmedAt
} from "@/lib/apps/minecraft/reach";
import {
    gameReachAdvice,
    gameStoppedAdvice,
    type GamePort,
    type GameReachAdvice
} from "@/lib/apps/minecraft/reach-advice";

/** How many players the server was built for. */
const SLOTS_VAR = "MAX_PLAYERS";

/** The release it was asked for, which is the release it runs only when it names
 *  one - the install's own record is the better answer (see `releaseOf`). */
const RELEASE_VAR = "VERSION";

/** What it runs the release on: Paper, Fabric, Vanilla. */
const SOFTWARE_VAR = "TYPE";

/** The plugin list, which is where a Java server's crossplay lives: Bedrock
 *  clients get in because Geyser is installed, not because a setting says so. */
const CROSSPLAY_VAR = "MODRINTH_PROJECTS";

/** `PAPER` as somebody writes it. The setting is an option list of shouted words,
 *  and a table is not the place to shout. */
function titleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

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
    /** Which game it plays, for the screens that offer different things per game.
     *  Null for an install whose manifest calls itself a game server and which no
     *  game claims, which is a catalog that has drifted rather than a state a row
     *  should render as something. */
    readonly game: GameId | null;
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
    /**
     * The release it runs, for the games where which one matters.
     *
     * Minecraft only in practice, and there it is what decides whether somebody can
     * join at all: a client is one release and so is the server. The resolved
     * release rather than the setting, which is very often the literal LATEST and
     * says nothing about what is on disk. Null for a game that updates itself, and
     * for a server built before Polaris wrote this down.
     */
    readonly release: string | null;
    /** What the server runs the release on - Paper, Fabric, Vanilla - which is the
     *  other half of what decides whether a mod or a plugin fits it. Null for a
     *  game or an edition with only one. */
    readonly software: string | null;
    /** java | bedrock, for the one game with two. Null for the games with one. */
    readonly edition: string | null;
    /** Whether Bedrock clients can join this Java server too. */
    readonly crossplay: boolean;
    /** The last minute it was seen answering, so a stopped server can say when it
     *  was last up rather than only that it is not. */
    readonly lastOnlineAt: string | null;
    /** When the run it is still in began, for one that is up. */
    readonly onlineSince: string | null;
    /** Why there is no address, when there is none. */
    readonly message: string | null;
}

/**
 * One person on a server right now.
 *
 * The id is what a rule can be written against and it is not the name: ARK has
 * no username to moderate - a character can be renamed at will - so its rows are
 * keyed by the Steam id, while a Minecraft name is the identity and there is
 * nothing else to carry. A screen that only lists people uses the name; one that
 * offers a verb needs the id.
 */
export interface PresencePlayer {
    readonly name: string;
    readonly id: string | null;
}

/** Who is on one server, in the one shape every screen that shows it reads. */
export interface ServerPresence {
    readonly id: string;
    readonly answering: boolean;
    /** Whether the container is actually up, when that can be seen from here.
     *  A server Polaris means to be running and that is not is neither stopped
     *  nor starting, and the row has to be able to say so. */
    readonly containerRunning: boolean | null;
    readonly online: number;
    readonly max: number;
    readonly players: readonly PresencePlayer[];
    /** Why it is not answering, when it is not. */
    readonly message: string | null;
    /**
     * Set when it is failing to start rather than taking its time, or was stopped
     * for doing so.
     *
     * Carried by the frame rather than left to the poll, because the frame is laid
     * over the poll's reading every few seconds - a field this did not carry would
     * appear once and then be wiped by the next heartbeat, which is a worse bug
     * than not showing it at all.
     */
    readonly crashLoop: CrashLoop | null;
}

/** The same reading with the names alone, for the list that only prints them. */
export interface GameServerLive extends Omit<ServerPresence, "players"> {
    readonly players: readonly string[];
}

/**
 * One server's facts, for a panel rather than a list.
 *
 * Built from the same read as the list on purpose: where a server lives and what a
 * player types are worked out in exactly one place, and a server's own page saying
 * something different from its row would be the kind of disagreement nobody can
 * resolve without reading both.
 */
export async function gameServerFacts(
    ownerId: string,
    installedAppId: string
): Promise<GameServerFacts | null> {
    const servers = await listGameServerFacts(ownerId, [installedAppId]);
    return servers.find((server) => server.id === installedAppId) ?? null;
}

/** The ids of a set of rows that have one, for an `in` filter. */
function presentIds(values: readonly (string | null)[]): string[] {
    return values.filter((value): value is string => value !== null);
}

/** The game servers this person runs, plus any they were given access to, and
 *  everything Polaris already knows about them, newest first. */
export async function listGameServerFacts(
    ownerId: string,
    alsoIds: readonly string[] = []
): Promise<GameServerFacts[]> {
    const mine = { ownerId, status: { not: "removed" } };
    const installs = (
        await prisma.installedApp.findMany({
            where:
                alsoIds.length > 0
                    ? { OR: [mine, { id: { in: [...alsoIds] }, status: { not: "removed" } }] }
                    : mine,
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
    const [isolated, hosts, lanIp, settings] = await Promise.all([
        prisma.deployment
            .findMany({
                where: {
                    id: { in: presentIds(apps.map((app) => app.currentDeploymentId)) },
                    isolated: true
                },
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
                where: {
                    scopeType: "application",
                    scopeId: { in: apps.map((app) => app.id) },
                    // The three settings the list itself renders. One query for all
                    // of them: a second one per field would be a query per column.
                    key: { in: [SLOTS_VAR, RELEASE_VAR, SOFTWARE_VAR, CROSSPLAY_VAR] }
                },
                select: { scopeId: true, key: true, value: true }
            })
            .then((rows) => {
                const byApp = new Map<string, Map<string, string>>();
                for (const row of rows) {
                    const held = byApp.get(row.scopeId) ?? new Map<string, string>();
                    held.set(row.key, row.value ?? "");
                    byApp.set(row.scopeId, held);
                }
                return byApp;
            })
    ]);

    return installs.map((install) => {
        const app = install.applicationId ? (appOf.get(install.applicationId) ?? null) : null;
        const config = readInstallConfig(install.config);
        const hostname = typeof config.hostname === "string" ? config.hostname : null;
        const running = app?.desiredState === "running";
        const env = app
            ? (settings.get(app.id) ?? new Map<string, string>())
            : new Map<string, string>();
        const uptime = readServerUptime(install.config);
        const slots = Number.parseInt(env.get(SLOTS_VAR) ?? "", 10);
        const game = gameOfServer(install.catalogId);
        return {
            id: install.id,
            name: install.name,
            catalogId: install.catalogId,
            catalogName: findApp(install.catalogId)?.name ?? install.catalogId,
            game: game?.id ?? null,
            applicationId: install.applicationId,
            serverName: install.targetId ? (targetName.get(install.targetId) ?? null) : null,
            running,
            slots: Number.isFinite(slots) ? slots : null,
            release: releaseOf(config, env.get(RELEASE_VAR)),
            software: (env.get(SOFTWARE_VAR) ?? "").trim()
                ? titleCase((env.get(SOFTWARE_VAR) as string).trim())
                : null,
            edition: game?.id === "minecraft" ? editionOf(install.catalogId) : null,
            crossplay: hasCrossplay(env.get(CROSSPLAY_VAR)),
            lastOnlineAt: uptime.lastOnlineAt,
            onlineSince: uptime.onlineSince,
            address: app
                ? gameServerAddress({
                      hostname,
                      portless: config.portless === true,
                      ip: hostname
                          ? null
                          : app.target.kind === "local" || !app.target.hostId
                            ? lanIp
                            : (hosts.get(app.target.hostId) ?? null),
                      port:
                          pinnedHostPort(app.sourceConfig) ??
                          hostPortForApp(publishedSubject(app, isolated))
                  })
                : null,
            message: app
                ? running
                    ? null
                    : "The server is stopped"
                : "This server is still being set up"
        };
    });
}

/**
 * The release the server actually runs.
 *
 * The resolved release the install recorded when it was built, and the setting only
 * when there is no record - a server created before Polaris wrote that down. The
 * setting is very often the literal `LATEST`, which names no release and is not
 * worth printing as one.
 */
function releaseOf(config: InstallConfig, setting: string | undefined): string | null {
    const recorded =
        typeof config[RELEASE_KEY] === "string" ? (config[RELEASE_KEY] as string).trim() : "";
    const declared = (setting ?? "").trim();
    const release = recorded || declared;
    return release.length > 0 && !wantsLatest(release) ? release : null;
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
    return app.currentDeploymentId && isolated.has(app.currentDeploymentId)
        ? app.currentDeploymentId
        : app.id;
}

/**
 * Who is on each of the owner's servers.
 *
 * One round trip into every running container, so it is deliberately apart from
 * the facts: it is what the list waits on, and nothing else should. A server that
 * is stopped is not asked at all, and one that refuses is a row that says so
 * rather than a list that fails.
 *
 * Every screen that shows who is playing reads this one function - the list, both
 * game panels, and the watcher behind the live stream - so none of them can be
 * showing a different answer to the same question at the same moment.
 */
export async function listGameServerPresence(
    ownerId: string,
    alsoIds: readonly string[] = [],
    /** Only these servers, for a screen that is about one of them. Reading a
     *  server costs a command inside its container, so a page watching one must
     *  not be the reason the other five are asked every few seconds. */
    only?: readonly string[]
): Promise<ServerPresence[]> {
    const servers = await listGameServerFacts(ownerId, alsoIds);
    const wanted = only ? servers.filter((server) => only.includes(server.id)) : servers;
    return Promise.all(wanted.map((server) => readPresence(ownerId, server)));
}

async function readPresence(ownerId: string, server: GameServerFacts): Promise<ServerPresence> {
    if (!server.running || !server.applicationId) {
        return {
            id: server.id,
            answering: false,
            // A server Polaris was told to stop is not a server nobody could
            // reach: the stop is the answer. Only one that has never been
            // deployed leaves this unknown, because there is no container to
            // have an opinion about.
            containerRunning: server.applicationId ? false : null,
            online: 0,
            max: 0,
            players: [],
            message: server.message,
            crashLoop: null
        };
    }
    // Each game is asked in its own language - Minecraft over rcon-cli, ARK
    // through arkmanager - and both answer the same shape, because the row that
    // renders it is one row.
    if (server.game === "ark") {
        const ark = await getArkPlayers(ownerId, server.id).catch((caught: unknown) => ({
            answering: false,
            containerRunning: null,
            players: [],
            message: caught instanceof Error ? caught.message : "The server is not answering",
            crashLoop: null
        }));
        return {
            id: server.id,
            answering: ark.answering,
            containerRunning: ark.containerRunning,
            online: ark.players.length,
            // ARK does not report its own cap over RCON, so the setting is the
            // only number there is - and the list already reads it.
            max: server.slots ?? 0,
            players: ark.players.map((player) => ({ name: player.name, id: player.steamId })),
            message: ark.message,
            crashLoop: ark.crashLoop
        };
    }
    const live = await getServerPlayers(ownerId, server.id).catch((caught: unknown) => ({
        answering: false,
        containerRunning: null,
        players: { online: 0, max: 0, players: [] },
        message: caught instanceof Error ? caught.message : "The server is not answering",
        crashLoop: null
    }));
    return {
        id: server.id,
        answering: live.answering,
        containerRunning: live.containerRunning,
        online: live.players.online,
        max: live.players.max,
        // A Minecraft name is the identity, so there is no second id to carry.
        players: live.players.players.map((name) => ({ name, id: null })),
        message: live.message,
        crashLoop: live.crashLoop
    };
}

/** The same reading for the callers that only print names. */
export async function listGameServerLive(
    ownerId: string,
    alsoIds: readonly string[] = []
): Promise<GameServerLive[]> {
    return (await listGameServerPresence(ownerId, alsoIds)).map(withNamesOnly);
}

export function withNamesOnly(presence: ServerPresence): GameServerLive {
    return { ...presence, players: presence.players.map((player) => player.name) };
}

/**
 * The machines a server can go on, and what each has left.
 *
 * Two numbers, because they answer different questions. What the machine has
 * free right now is measured (over SSH for a connected server, from the host this
 * process runs on for the local one) and moves. What its game servers are already
 * promised is Polaris' own bookkeeping and does not: it is the sum of the heaps
 * handed out, which is what actually decides whether the next server fits.
 *
 * @param probe Whether to go and ask each connected machine. Measuring costs an
 *              SSH session per machine, and an unreachable one costs the whole
 *              probe timeout - which is why the create dialog asks for the list
 *              without it first. Unprobed, a machine reports whatever was last
 *              measured recently enough to be worth showing, and nothing when
 *              there is none: the list of machines is the same either way, so the
 *              choice can be made while the figures are still arriving.
 */
export async function listGameMachines(ownerId: string, probe = true): Promise<GameMachine[]> {
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
            const metrics = probe
                ? await getServerMetrics(host.id, ownerId).catch(() => null)
                : (peekServerMetrics(host.id)?.metrics ?? null);
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
        select: { catalogId: true, applicationId: true, targetId: true, config: true }
    });
    const games = installs.filter((install) => isGameServerApp(install.catalogId));
    if (games.length === 0) return new Map();

    const targets = await prisma.deployTarget.findMany({
        where: {
            id: { in: games.map((game) => game.targetId).filter((id): id is string => id !== null) }
        },
        select: { id: true, kind: true, hostId: true }
    });
    const machineOf = new Map(
        targets.map((target) => [
            target.id,
            target.kind === "host" && target.hostId ? target.hostId : "local"
        ])
    );

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
        // A heap when the game has one to hand out, and what the install expects it
        // to use when it does not: ARK is given no memory limit, it simply grows to
        // around six gigabytes - and a machine already running two of them must not
        // read as empty on the form deciding where the third goes.
        const declared = readInstallConfig(game.config).memoryMb;
        const megabytes =
            memoryOf.get(game.applicationId as string) ||
            (typeof declared === "number" ? declared : 0);
        byMachine.set(machine, (byMachine.get(machine) ?? 0) + megabytes);
    }
    return byMachine;
}

/**
 * "2G", "2560M" or a bare number of megabytes, as megabytes.
 *
 * `8GB` is read too, though nothing writes it any more: the settings form corrects
 * that spelling into `8G` before storing it, but rows written before it did are
 * still in the database. Refusing them here does not report a problem, it silently
 * bills that server at zero against the machine's memory - which is how a host ends
 * up promised more heap than it has.
 */
export function parseMemoryMb(value: string): number {
    const match =
        /^(\d+(?:\.\d+)?)\s*([gm])b?$/i.exec(value.trim()) ??
        /^(\d+(?:\.\d+)?)$/.exec(value.trim());
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
export async function syncFirewallBans(
    ownerId: string
): Promise<{ servers: number; banned: number; kicked: number; allowed: number }> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" } },
        select: { id: true, catalogId: true }
    });
    let servers = 0;
    let banned = 0;
    let kicked = 0;
    /** Players an ARK server was finally told it may let in. */
    let allowed = 0;
    for (const install of installs) {
        if (!isGameServerApp(install.catalogId)) continue;
        // An ARK server is driven by none of what follows - it has no ban command,
        // no whitelist file and no decision queue. What it does have is an allow
        // list that was written down while the server was still installing thirty
        // gigabytes, and this walk is what finally hands it over. Without it a
        // server created closed stays closed to the person who created it.
        if (gameOfServer(install.catalogId)?.id === "ark") {
            servers += 1;
            allowed += await applyAllowList(ownerId, install.id).catch(() => 0);
            // The settings it was created with are in the same position as the
            // allow list: written down before there was a server, and handed over
            // by whichever of the two walks reaches it first.
            await applyPendingArkRules(ownerId, install.id).catch(() => 0);
            // It does have timeouts, though - Polaris' own, built on the ban it
            // does have - and this walk is what comes back to lift them.
            await sweepArkTimeouts(ownerId, install.id).catch(() => 0);
            continue;
        }
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
        // Who is on is read once and used twice: a decision waiting for one of
        // them, and a copy of what each is carrying so the bag can still be read
        // after they log off.
        const online = await getServerPlayers(ownerId, install.id)
            .then((status) => (status.answering ? status.players.players : []))
            .catch(() => [] as string[]);
        if (online.length > 0) {
            await drainQueue(ownerId, install.id, online).catch(() => null);
            await sweepInventorySnapshots(ownerId, install.id, online).catch(() => 0);
        }
    }
    // The routing table, rebuilt from what exists right now. A server that was removed
    // or repointed leaves a route behind otherwise, and a route to a port nothing holds
    // is a name that fails for a player with nothing anywhere saying why.
    await syncMinecraftRoutes().catch(() => undefined);
    return { servers, banned, kicked, allowed };
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
    /** When that last happened, so a row can date what it is remembering rather
     *  than assert it. Null for a port nothing has ever arrived on. */
    readonly confirmedAt: string | null;
    /** Whether it is meant to be up. A stopped server answers nothing, so it is
     *  neither knocked on nor reported as unreachable - the port it published is
     *  not what is silent. */
    readonly running: boolean;
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
): Promise<{ installedAppId: string; name: string; game: GameId | null } | null> {
    const install = await prisma.installedApp.findFirst({
        where: { ownerId, applicationId, status: { not: "removed" } },
        select: { id: true, name: true, catalogId: true }
    });
    if (!install || !isGameServerApp(install.catalogId)) return null;
    return {
        installedAppId: install.id,
        name: install.name,
        game: gameOfServer(install.catalogId)?.id ?? null
    };
}

/** Every game server's published ports, for the screens that ask an operator to
 *  open them. */
export async function listGamePorts(): Promise<GamePortRow[]> {
    const installs = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { id: true, name: true, catalogId: true, applicationId: true, config: true }
    });
    const games = installs.filter((install) => isGameServerApp(install.catalogId));
    // Which of them are meant to be up, in one query rather than one per row: it
    // decides which ports are worth knocking on at all.
    const running = new Set(
        (
            await prisma.application.findMany({
                where: {
                    id: { in: presentIds(games.map((game) => game.applicationId)) },
                    desiredState: "running"
                },
                select: { id: true }
            })
        ).map((app) => app.id)
    );
    const rows = await Promise.all(
        games.map(async (install) => {
            const confirmedAt = reachConfirmedAt(install.config);
            return {
                installedAppId: install.id,
                name: install.name,
                ports: await gamePorts(install.applicationId),
                confirmed: confirmedAt !== null,
                confirmedAt,
                running: install.applicationId !== null && running.has(install.applicationId)
            };
        })
    );
    return rows.filter((row) => row.ports.length > 0);
}

/**
 * Knock on every unproven game port whose server is up, and record the ones that
 * answer.
 *
 * The same pass the two screens make while somebody is watching them, on a timer
 * so that nobody has to be. The panel promises Polaris marks the port done by
 * itself the moment it answers from outside, and until this existed that promise
 * held only for as long as a tab was open on it: a server created in the evening
 * and left to generate its world was still "not confirmed" in the morning, having
 * been reachable for eight hours.
 *
 * Only a running server is knocked on, and `probeReach` refuses to knock twice
 * inside its own rate limit - so this costs one connection per unproven server and
 * nothing at all once they are proven.
 */
export async function sweepGameReach(): Promise<{ pending: number; proven: number }> {
    const pending = (await listGamePorts()).filter((server) => !server.confirmed && server.running);
    const proven = await probeReach(pending);
    return { pending: pending.length, proven: proven.length };
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
    // Only a running server is knocked on. One that is stopped would refuse the
    // knock because there is nothing behind its port, and that refusal is
    // indistinguishable from a router that never forwarded it.
    const proven = probe
        ? new Set(await probeReach(servers.filter((server) => !server.confirmed && server.running)))
        : new Set<string>();
    const rows =
        proven.size === 0
            ? servers
            : servers.map((server) =>
                  proven.has(server.installedAppId)
                      ? { ...server, confirmed: true, confirmedAt: new Date().toISOString() }
                      : server
              );
    const unproven = rows.filter((server) => !server.confirmed);
    const pending = unproven.filter((server) => server.running);
    // Whether any of the unproven servers is even up. Without it the card told the
    // operator to forward a port whenever a server happened to be starting, which
    // is exactly when it has nothing to say about the router at all.
    const listening =
        pending.length === 0
            ? null
            : await probeListening(
                  pending.flatMap((server) => server.ports),
                  lanIp
              ).catch(() => null);
    return {
        servers: rows,
        // Nothing running and something unproven is the one case the advice below
        // cannot speak to: it would read the stopped server's silence as the
        // router's, and send an operator to open a port that is already open.
        advice:
            pending.length === 0 && unproven.length > 0
                ? gameStoppedAdvice(unproven.flatMap((server) => server.ports))
                : gameReachAdvice(
                      environment,
                      pending.flatMap((server) => server.ports),
                      pending.length === 0,
                      lanIp,
                      policy,
                      blocks,
                      listening
                  ),
        lanIp,
        policy,
        blocks
    };
}
