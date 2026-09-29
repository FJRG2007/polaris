/**
 * The honeypots of `xray.ts`, on a running server: placing them around the
 * players, watching for the one somebody digs to, and acting on it as the
 * server's settings say.
 *
 * A loop in this process per server with the feature on, every few seconds. Each
 * look is one command per dimension - who mined that ore since the last look -
 * and only when somebody did are the honeypots beside them tested. Placing new
 * ones and checking on the old happen once a minute and every ten.
 *
 * A honeypot only counts as mined if it was seen in place moments before: the
 * ones close to any player are looked at on every tick, so one blown up or built
 * over minutes ago is never pinned on the next person to find a diamond there.
 *
 * The same loop also watches for flying and teleporting when that is switched on
 * (`movement.ts`), since it is already asking the server where everybody is.
 *
 * The loop is memory; what it knows is on the install's settings, and the minute
 * sweep (`sweepXrayTraps`) starts it again after Polaris restarts or updates.
 * Every write goes through `updateXray`, which only lands on the settings it
 * read, so a player cleared from the screen while the loop runs stays cleared
 * and a honeypot placed while the settings are saved is never forgotten.
 */

import { gameMessage } from "../game-message";
import * as xray from "./xray";
import { prisma } from "@polaris/db";
import * as movement from "./movement";
import { parseNameFile } from "./parse";
import { host } from "@polaris/app-host";
import { movementScore } from "./suspicion";
import { javaComponent } from "./announcement";
import { timeoutPlayer } from "./timeout-service";
import { withServerContainer, type ServerContainer } from "./service";
import { readContainerFile, readContainerRange } from "../container-files";

const { readInstallConfig } = host.appsInstallConfig;
const { createNotification } = host.notificationService;

const TICK_MS = 4_000;
const PLACE_EVERY_MS = 60_000;
const AUDIT_EVERY_MS = 10 * 60_000;
/** Tries per player per placement pass: most points are next to a cave or a
 *  build and refused. */
const PLACE_TRIES = 16;
/** Tries for a whole placement pass, shared by every player, so a crowded
 *  server does not hold up the probing for minutes. What is left over is
 *  placed on the next pass. */
const PASS_TRIES = PLACE_TRIES * 4;
/** A honeypot this far from everybody is no use where it is; the oldest go first
 *  once there are more than the settings keep around the players. */
const NEAR_ENOUGH = 128;
/** Honeypots this close to a player are looked at every tick, so the one they
 *  reach next was seen in place just before. */
const PROBE_RANGE = xray.HIT_RANGE + 16;
/** How many ticks back a honeypot must have been seen for its loss to be a hit. */
const FRESH_TICKS = 2;
/** Writes that found the settings changed under them, worked out again from the new ones. */
const WRITE_TRIES = 5;

interface Loop {
    readonly ownerId: string;
    readonly timer: ReturnType<typeof setInterval>;
    busy: boolean;
    counters: boolean;
    tick: number;
    /** The tick each honeypot was last seen in place, by `trapKey`. */
    readonly seen: Map<string, number>;
    lastPlace: number;
    lastAudit: number;
    /** The movement watch: what it remembers per player, by lowercased name. */
    readonly tracks: Map<string, movement.Track>;
    /** Whether the watch has looked since it started, so somebody first seen
     *  after that has just joined. */
    moveLooked: boolean;
    moveCounters: boolean;
    /** Who was riding at the last look: a jump is not judged if they were then or now. */
    riding: Set<string>;
    /** The operators, lowercased, and whether the game logs their commands -
     *  read once a minute. */
    operators: Set<string>;
    logAdmin: boolean | null;
    lastRules: number;
    /** How long the server log was at the last look, to read only what is new. */
    logSize: number | null;
}

const loops = new Map<string, Loop>();

async function readState(
    installedAppId: string
): Promise<{ state: xray.XrayState; name: string } | null> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true, name: true, status: true, catalogId: true }
    });
    if (!row || row.status === "removed" || row.catalogId !== "minecraft") return null;
    return { state: xray.readXray(readInstallConfig(row.config)), name: row.name };
}

/**
 * Change the stored state from what is stored now, never from a stale copy: the
 * write only lands if the settings are still the ones it read, and is worked out
 * again from the new ones otherwise.
 */
export async function updateXray(
    installedAppId: string,
    change: (state: xray.XrayState) => xray.XrayState
): Promise<xray.XrayState | null> {
    for (let attempt = 0; attempt < WRITE_TRIES; attempt += 1) {
        const row = await prisma.installedApp.findUnique({
            where: { id: installedAppId },
            select: { config: true, status: true, catalogId: true }
        });
        if (!row || row.status === "removed" || row.catalogId !== "minecraft") return null;
        const config = readInstallConfig(row.config);
        const next = change(xray.readXray(config));
        const written = await prisma.installedApp.updateMany({
            where: { id: installedAppId, config: row.config },
            data: { config: JSON.stringify({ ...config, [xray.XRAY_KEY]: next }) }
        });
        if (written.count > 0) return next;
    }
    throw new Error(gameMessage("games", "lib.settingsRaced"));
}

function sameTrap(
    left: xray.Honeypot,
    right: { dimension: string; x: number; y: number; z: number }
) {
    return (
        left.dimension === right.dimension &&
        left.x === right.x &&
        left.y === right.y &&
        left.z === right.z
    );
}

function trapKey(trap: { dimension: string; x: number; y: number; z: number }): string {
    return `${trap.dimension}:${trap.x}:${trap.y}:${trap.z}`;
}

async function tick(installedAppId: string, loop: Loop): Promise<void> {
    const current = await readState(installedAppId);
    if (!current) return stopLoop(installedAppId);
    const { state } = current;
    const traps = state.settings.enabled;
    const watching = state.settings.movement;
    if (!traps && (state.honeypots.length > 0 || state.cleanup.length > 0)) {
        await clearTraps(installedAppId, loop);
    }
    if (!watching) {
        loop.tracks.clear();
        loop.moveLooked = false;
    }
    if (!traps && !watching) {
        if (state.honeypots.length === 0 && state.cleanup.length === 0) stopLoop(installedAppId);
        return;
    }
    const now = Date.now();
    const dims = xray.DIMENSIONS.filter(
        (dim) => dim !== "minecraft:the_nether" || state.settings.nether
    );
    loop.tick += 1;
    const claimed = new Set<string>();

    await withServerContainer(loop.ownerId, installedAppId, async (server) => {
        if (!server.running || server.edition !== "java") return;
        if (watching) await watchMovement(installedAppId, loop, server, state);
        if (!traps) return;
        if (!loop.counters) {
            for (const line of xray.objectiveCommands()) await server.say([line]);
            loop.counters = true;
        }
        for (const dim of dims) await watch(installedAppId, loop, server, state, dim, claimed);
        await probe(loop, server, state, dims, claimed);
        if (now - loop.lastPlace >= PLACE_EVERY_MS) {
            loop.lastPlace = now;
            await place(installedAppId, loop, server, state, dims);
            await retryWarnings(installedAppId, loop, server);
        }
        if (now - loop.lastAudit >= AUDIT_EVERY_MS) {
            loop.lastAudit = now;
            await audit(installedAppId, server, state);
        }
    });
}

/**
 * Who mined the ore since the last look, and whether a honeypot beside them is
 * gone. A honeypot is pinned on one player at most, and only if it was seen in
 * place within the last `FRESH_TICKS` looks.
 */
async function watch(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    state: xray.XrayState,
    dim: xray.Dimension,
    claimed: Set<string>
): Promise<void> {
    const miners = xray.readPositions(await server.say([xray.minedSinceCommand(dim)]));
    if (miners.length === 0) return;
    await server.say([xray.resetCounterCommand(dim)]);
    for (const miner of miners) {
        for (const trap of xray.trapsNear(state.honeypots, dim, miner)) {
            const key = trapKey(trap);
            if (claimed.has(key)) continue;
            const answer = xray.readTest(await server.say([xray.stillThereCommand(trap)]));
            // Unloaded or unreadable is not gone: nothing is concluded from a
            // place the game cannot see or an answer that is not its own.
            if (answer !== "failed") continue;
            claimed.add(key);
            const seenAt = loop.seen.get(key);
            loop.seen.delete(key);
            if (seenAt === undefined || seenAt < loop.tick - FRESH_TICKS) continue;
            await recordHit(installedAppId, loop, server, miner.name, trap);
        }
    }
}

/** Look at every honeypot a player is close to, so the one they reach next was
 *  seen in place just before. */
async function probe(
    loop: Loop,
    server: ServerContainer,
    state: xray.XrayState,
    dims: readonly xray.Dimension[],
    claimed: ReadonlySet<string>
): Promise<void> {
    if (state.honeypots.length === 0) return;
    const positions = xray.readPositions(await server.say([xray.WHERE_EVERYBODY_IS[0]!]));
    const near = new Map<string, xray.Honeypot>();
    for (const dim of dims) {
        for (const one of positions) {
            for (const trap of xray.trapsNear(state.honeypots, dim, one, PROBE_RANGE)) {
                if (!claimed.has(trapKey(trap))) near.set(trapKey(trap), trap);
            }
        }
    }
    for (const [key, trap] of near) {
        const answer = xray.readTest(await server.say([xray.stillThereCommand(trap)]));
        if (answer === "passed") loop.seen.set(key, loop.tick);
    }
}

async function recordHit(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    name: string,
    trap: xray.Honeypot
): Promise<void> {
    const now = Date.now();
    const key = name.toLowerCase();
    const next = await updateXray(installedAppId, (state) => {
        const held: xray.PlayerEvidence = state.evidence[key] ?? {
            name,
            hits: [],
            reportedHits: 0,
            warnedAt: null,
            bannedAt: null
        };
        return {
            ...state,
            honeypots: state.honeypots.filter((one) => !sameTrap(one, trap)),
            evidence: {
                ...state.evidence,
                [key]: {
                    ...held,
                    name,
                    hits: [
                        ...held.hits,
                        { dimension: trap.dimension, x: trap.x, y: trap.y, z: trap.z, at: now }
                    ]
                }
            }
        };
    });
    const evidence = next?.evidence[key];
    if (!next || !evidence) return;
    await act(installedAppId, loop, server, next, evidence);
}

/** Report, warn and ban as the settings say, each at most once per level. */
async function act(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    state: xray.XrayState,
    evidence: xray.PlayerEvidence
): Promise<void> {
    const now = Date.now();
    const todo = xray.actionsFor(evidence, state.settings, now);
    const hits = xray.countingHits(evidence, now).length;
    const key = evidence.name.toLowerCase();
    const serverName = (await readState(installedAppId))?.name ?? "Minecraft";

    const warned = todo.warn && (await warnPlayer(server, evidence.name, state.settings.warning));
    let banned = false;
    if (todo.ban) {
        await timeoutPlayer(
            loop.ownerId,
            installedAppId,
            evidence.name,
            state.settings.banHours * 60,
            // i18n-ignore: the ban reason is shown in the game, to the player
            `X-Ray: dug straight to ${hits} hidden ores`
        )
            .then(() => {
                banned = true;
            })
            .catch(() => undefined);
    }
    if (todo.report || warned || banned) {
        await updateXray(installedAppId, (fresh) => {
            const held = fresh.evidence[key];
            if (!held) return fresh;
            return {
                ...fresh,
                evidence: {
                    ...fresh.evidence,
                    [key]: {
                        ...held,
                        reportedHits: todo.report ? hits : held.reportedHits,
                        warnedAt: warned ? now : held.warnedAt,
                        bannedAt: banned ? now : held.bannedAt
                    }
                }
            };
        });
    }
    if (todo.report || banned) {
        const done = banned
            ? ` Banned for ${state.settings.banHours} h.`
            : warned
              ? " Warned in the game."
              : "";
        await createNotification({
            userId: loop.ownerId,
            type: "games.xray",
            title: `${evidence.name} dug to ${hits} hidden ores on ${serverName}`,
            body: `Each one was fully enclosed in rock, where it could not be seen without X-Ray.${done}`,
            href: `/apps/installed/${installedAppId}/security`,
            level: "warning",
            actionRequired: !banned
        }).catch(() => undefined);
    }
}

/**
 * Tell a player they were caught. True only if they were online and the game
 * took the message: a ban needs a warning first, so one that never arrived must
 * not count as given.
 */
async function warnPlayer(
    server: ServerContainer,
    name: string,
    warning: string
): Promise<boolean> {
    if (!xray.isPlayerName(name)) return false;
    try {
        const online = await server.say([xray.onlineCommand(name)]);
        if (xray.readTest(online) !== "passed") return false;
        const sent = await server.say([`tellraw ${name} ${javaComponent(warning, false)}`]);
        await server
            .say([`title ${name} title ${javaComponent("&c&lAnti X-Ray", false)}`])
            .catch(() => undefined);
        return xray.reachedPlayer(online, sent);
    } catch {
        return false;
    }
}

/** Warnings that did not reach their player - offline at the time - tried again. */
async function retryWarnings(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer
): Promise<void> {
    const current = await readState(installedAppId);
    if (!current) return;
    const now = Date.now();
    for (const evidence of Object.values(current.state.evidence)) {
        if (!xray.isPlayerName(evidence.name)) continue;
        if (!xray.actionsFor(evidence, current.state.settings, now).warn) continue;
        await act(installedAppId, loop, server, current.state, evidence);
    }
}

/** Keep the settings' number of honeypots around the players in each dimension. */
async function place(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    state: xray.XrayState,
    dims: readonly xray.Dimension[]
): Promise<void> {
    const positions = xray.readPositions(await server.say([xray.WHERE_EVERYBODY_IS[0]!]));
    if (positions.length === 0) return;
    const inside = xray.readDimensions(await server.say([xray.WHERE_EVERYBODY_IS[1]!]));
    const placed: xray.Honeypot[] = [];
    const retire: xray.Honeypot[] = [];
    let budget = PASS_TRIES;

    for (const dim of dims) {
        const here = positions.filter((one) => inside.get(one.name) === dim);
        if (here.length === 0) continue;
        const near = state.honeypots.filter(
            (trap) =>
                trap.dimension === dim &&
                here.some((one) => xray.withinReach(trap, one, NEAR_ENOUGH))
        );
        const short = (player: { x: number; z: number }) =>
            xray.shortfall(
                [...state.honeypots, ...placed].filter((trap) => trap.dimension === dim),
                player,
                state.settings.perDimension,
                NEAR_ENOUGH
            );
        // Every player gets their own, counted around them. Counting the whole
        // dimension at once left anybody far from the first player with none at
        // all: the quota was already met around somebody else. The ones shortest
        // of them go first, while the pass still has tries.
        const queue = here
            .map((player) => ({ player, missing: short(player) }))
            .filter((one) => one.missing > 0)
            .sort((left, right) => right.missing - left.missing);
        for (const { player: around } of queue) {
            let missing = short(around);
            let tries = 0;
            while (missing > 0 && tries < PLACE_TRIES && budget > 0) {
                const [point] = xray.candidatePoints(dim, around, 1);
                tries += 1;
                budget -= 1;
                if (!point) continue;
                const answer = xray.readTest(
                    await server.say([xray.placeCommand(dim, point.x, point.y, point.z)])
                );
                if (answer !== "passed") continue;
                placed.push({ dimension: dim, ...point, placedAt: Date.now() });
                loop.seen.set(trapKey({ dimension: dim, ...point }), loop.tick);
                missing -= 1;
            }
        }
        // Old ones far from everybody go, oldest first, once there are more than
        // five times what is kept around the players - or twice that for each
        // player, when they are spread wide enough to each have their own.
        const all = state.honeypots.filter((trap) => trap.dimension === dim);
        const kept = state.settings.perDimension * Math.max(5, here.length * 2);
        const surplus = all.length + placed.length - kept;
        if (surplus > 0) {
            retire.push(
                ...all
                    .filter((trap) => !near.includes(trap))
                    .sort((left, right) => left.placedAt - right.placedAt)
                    .slice(0, surplus)
            );
        }
    }

    const cleaned: xray.Honeypot[] = [];
    for (const trap of retire) {
        const answer = xray.readTest(await server.say([xray.removeCommand(trap)]));
        if (answer === "unloaded") cleaned.push(trap);
    }
    if (placed.length === 0 && retire.length === 0) return;
    await updateXray(installedAppId, (fresh) => ({
        ...fresh,
        honeypots: [
            ...fresh.honeypots.filter((trap) => !retire.some((gone) => sameTrap(gone, trap))),
            ...placed
        ],
        cleanup: [...fresh.cleanup, ...cleaned]
    }));
}

/**
 * Drop honeypots that are gone without anybody having mined them - an
 * explosion, lava, a build - and retry putting the rock back where the feature
 * was switched off. Nothing here is ever a hit: that needs a miner beside it.
 */
async function audit(
    installedAppId: string,
    server: ServerContainer,
    state: xray.XrayState
): Promise<void> {
    const gone: xray.Honeypot[] = [];
    for (const trap of state.honeypots) {
        const answer = xray.readTest(await server.say([xray.stillThereCommand(trap)]));
        if (answer === "failed") gone.push(trap);
    }
    const restored: xray.Honeypot[] = [];
    for (const trap of state.cleanup) {
        const answer = xray.readTest(await server.say([xray.removeCommand(trap)]));
        if (answer !== "unloaded") restored.push(trap);
    }
    if (gone.length === 0 && restored.length === 0) return;
    await updateXray(installedAppId, (fresh) => ({
        ...fresh,
        honeypots: fresh.honeypots.filter((trap) => !gone.some((one) => sameTrap(one, trap))),
        cleanup: fresh.cleanup.filter((trap) => !restored.some((one) => sameTrap(one, trap)))
    }));
}

/** Player names, lowercased, out of a `data get entity @s Dimension` over a selector. */
function namesIn(output: string): Set<string> {
    return new Set([...xray.readDimensions(output).keys()].map((name) => name.toLowerCase()));
}

/** Who a counter says did it since the last look, lowercased, with only them
 *  reset for the next one. */
async function counted(server: ServerContainer, objective: string): Promise<Set<string>> {
    const names = [
        ...xray.readDimensions(await server.say([movement.sinceCommand(objective)])).keys()
    ];
    for (const line of movement.resetCommands(objective, names)) await server.say([line]);
    return new Set(names.map((name) => name.toLowerCase()));
}

const LOG_FILE = "/data/logs/latest.log";
/** The most of the log read for one look. A server that wrote more than this in
 *  a few seconds is being flooded, and the part read is the newest. */
const LOG_READ_MAX = 256 * 1024;
/** Why teleports cannot be judged, for the screen. */
const NO_ADMIN_LOG = gameMessage("games", "lib.teleportsNoAdminLog");
const NO_LOG = gameMessage("games", "lib.teleportsNoLog");
const UNKNOWN_ADMIN_LOG = gameMessage("games", "lib.teleportsUnknownAdminLog");

/** How long the server log is now, or null where it cannot be read. */
async function logLength(server: ServerContainer): Promise<number | null> {
    const result = await server.run(["stat", "-c", "%s", LOG_FILE]).catch(() => null);
    const size = result && result.code === 0 ? Number(result.output.trim()) : Number.NaN;
    return Number.isFinite(size) && size >= 0 ? size : null;
}

/** What the log gained from byte `from` (measured before the last look sampled
 *  anybody) up to now, so it covers everything that happened between the two
 *  looks. Null when that cannot be known, and nothing is concluded then. A log
 *  now shorter than `from` was rotated: all of it is new. */
async function logSince(
    server: ServerContainer,
    from: number | null,
    size: number | null
): Promise<string | null> {
    if (from === null || size === null) return null;
    const start = size < from ? 0 : from;
    // In pieces: one command carries 16 KiB, and a busy few seconds writes more -
    // the newest lines, the ones that explain a jump, were the ones cut off.
    return readContainerRange(server, LOG_FILE, Math.max(start, size - LOG_READ_MAX), size).catch(
        () => null
    );
}

/**
 * One look for flying and teleporting (see `movement.ts`). Operators are never
 * judged, and a teleport is only judged while the game logs operators' commands,
 * since that is how an operator's teleport is told apart.
 */
async function watchMovement(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    state: xray.XrayState
): Promise<void> {
    const now = Date.now();
    if (!loop.moveCounters) {
        for (const line of movement.movementObjectiveCommands()) await server.say([line]);
        loop.moveCounters = true;
    }
    if (now - loop.lastRules >= PLACE_EVERY_MS) {
        loop.lastRules = now;
        loop.logAdmin = movement.readLogAdmin(await server.say([movement.LOG_ADMIN_COMMAND]));
        const ops = await readContainerFile(server, "/data/ops.json").catch(() => null);
        loop.operators = new Set(parseNameFile(ops ?? "").map((name) => name.toLowerCase()));
    }

    // Measured before anybody's position, so whatever moved them since the
    // last look is already in the part of the log that is read.
    const logFrom = loop.logSize;
    const size = await logLength(server);
    loop.logSize = size;

    const positions = xray.readPositions(await server.say([xray.WHERE_EVERYBODY_IS[0]!]));
    const dimensions = xray.readDimensions(await server.say([xray.WHERE_EVERYBODY_IS[1]!]));
    const airborne = new Set(
        xray
            .readPositions(await server.say([movement.AIRBORNE_COMMAND]))
            .map((one) => one.name.toLowerCase())
    );
    const riding = namesIn(await server.say([movement.RIDING_COMMAND]));
    const died = await counted(server, movement.DEATH_OBJECTIVE);
    const glided = await counted(server, movement.GLIDE_OBJECTIVE);

    // Read only if some jump needs explaining, and at most once a look.
    let log: string | null | undefined;
    const teleportCheck =
        loop.logAdmin === false
            ? NO_ADMIN_LOG
            : loop.logAdmin === null
              ? UNKNOWN_ADMIN_LOG
              : size === null
                ? NO_LOG
                : null;
    const judgeTeleports = teleportCheck === null;

    const found: { name: string; incident: movement.Incident }[] = [];
    const present = new Set<string>();
    for (const one of positions) {
        const key = one.name.toLowerCase();
        const dimension = dimensions.get(one.name);
        if (!dimension) continue;
        present.add(key);
        const sample: movement.Sample = { dimension, x: one.x, y: one.y, z: one.z, at: now };
        const track = loop.tracks.get(key) ?? {
            ...movement.NEW_TRACK,
            joinedAt: loop.moveLooked ? now : null
        };
        const operator = loop.operators.has(key);
        const hover = movement.nextHover(track, airborne.has(key) && !operator ? sample : null);
        if (hover.flying) {
            found.push({ name: one.name, incident: movement.incidentAt("flying", sample, null) });
        }
        const previous = track.last;
        const diedAt = movement.respawnAfter(track, sample, died.has(key));
        const excused =
            operator ||
            riding.has(key) ||
            loop.riding.has(key) ||
            track.diedAt !== null ||
            diedAt !== null ||
            movement.joining(track, now) ||
            glided.has(key);
        if (previous && !excused && judgeTeleports && movement.isTeleport(previous, sample)) {
            if (log === undefined) log = await logSince(server, logFrom, size);
            if (log !== null && !movement.explainedByLog(log, one.name)) {
                found.push({
                    name: one.name,
                    incident: movement.incidentAt(
                        "teleport",
                        sample,
                        movement.distanceBetween(previous, sample)
                    )
                });
            }
        }
        loop.tracks.set(key, { ...hover.track, last: sample, diedAt });
    }
    loop.moveLooked = true;
    for (const key of [...loop.tracks.keys()]) if (!present.has(key)) loop.tracks.delete(key);
    loop.riding = riding;

    if (found.length === 0 && teleportCheck === state.teleportCheck) return;
    const next = await updateXray(installedAppId, (fresh) => {
        const kept = { ...fresh.movement };
        for (const { name, incident } of found) {
            const key = name.toLowerCase();
            kept[key] = movement.withIncident(kept[key], name, incident);
        }
        return { ...fresh, movement: kept, teleportCheck };
    });
    if (!next) return;
    for (const name of new Set(found.map((one) => one.name))) {
        await reportMovement(installedAppId, loop, next, name);
    }
}

/** Tell the owner once, when a player's movement first looks likely to be cheating,
 *  and again only after what was reported has left the window. */
async function reportMovement(
    installedAppId: string,
    loop: Loop,
    state: xray.XrayState,
    name: string
): Promise<void> {
    const key = name.toLowerCase();
    const evidence = state.movement[key];
    const now = Date.now();
    if (!evidence || movement.alreadyReported(evidence, now)) return;
    const counting = movement.countingIncidents(evidence, now);
    const flights = counting.filter((one) => one.kind === "flying").length;
    const score = movementScore(flights, counting.length - flights);
    if (score.level !== "likely" && score.level !== "confirmed") return;
    await updateXray(installedAppId, (fresh) => {
        const held = fresh.movement[key];
        if (!held) return fresh;
        return { ...fresh, movement: { ...fresh.movement, [key]: { ...held, reportedAt: now } } };
    });
    const serverName = (await readState(installedAppId))?.name ?? "Minecraft";
    await createNotification({
        userId: loop.ownerId,
        type: "games.xray",
        title: `${name} may be flying or teleporting on ${serverName}`,
        body: `${score.reasons.join(". ")}. Nothing was done to them: look at where and when before deciding.`,
        href: `/apps/installed/${installedAppId}/security`,
        level: "warning",
        actionRequired: true
    }).catch(() => undefined);
}

/** Switched off: every honeypot back to rock, the ones it cannot reach yet kept to retry. */
async function clearTraps(installedAppId: string, loop: Loop): Promise<void> {
    await withServerContainer(loop.ownerId, installedAppId, async (server) => {
        if (!server.running) return;
        const current = await readState(installedAppId);
        if (!current) return;
        const pending = [...current.state.honeypots, ...current.state.cleanup];
        const left: xray.Honeypot[] = [];
        for (const trap of pending) {
            const answer = xray.readTest(await server.say([xray.removeCommand(trap)]));
            if (answer === "unloaded") left.push(trap);
        }
        await updateXray(installedAppId, (fresh) => ({
            ...fresh,
            honeypots: fresh.honeypots.filter(
                (trap) => !pending.some((one) => sameTrap(one, trap))
            ),
            cleanup: [
                ...fresh.cleanup.filter((trap) => !pending.some((one) => sameTrap(one, trap))),
                ...left
            ]
        }));
    });
}

function stopLoop(installedAppId: string): void {
    const loop = loops.get(installedAppId);
    if (loop) clearInterval(loop.timer);
    loops.delete(installedAppId);
}

/** Start the loop for a server that has something to do, unless it is running. */
export function startXrayTraps(ownerId: string, installedAppId: string): void {
    if (loops.has(installedAppId)) return;
    const loop: Loop = {
        ownerId,
        timer: setInterval(() => {
            if (loop.busy) return;
            loop.busy = true;
            void tick(installedAppId, loop)
                .catch((error: unknown) => {
                    // A server that is stopping or restarting does not answer for
                    // a while; the next look asks again.
                    console.warn("polaris: x-ray trap tick failed", installedAppId, String(error));
                })
                .finally(() => {
                    loop.busy = false;
                });
        }, TICK_MS),
        busy: false,
        counters: false,
        tick: 0,
        seen: new Map(),
        lastPlace: 0,
        lastAudit: Date.now(),
        tracks: new Map(),
        moveLooked: false,
        moveCounters: false,
        riding: new Set(),
        operators: new Set(),
        logAdmin: null,
        lastRules: 0,
        logSize: null
    };
    loop.timer.unref?.();
    loops.set(installedAppId, loop);
}

/** The minute sweep: a loop for every server that has honeypots or the movement
 *  watch on, or honeypots left to clear. */
export async function sweepXrayTraps(): Promise<{ running: number }> {
    const rows = await prisma.installedApp.findMany({
        where: { status: { not: "removed" }, catalogId: "minecraft" },
        select: { id: true, ownerId: true, config: true }
    });
    for (const row of rows) {
        const state = xray.readXray(readInstallConfig(row.config));
        if (
            state.settings.enabled ||
            state.settings.movement ||
            state.honeypots.length > 0 ||
            state.cleanup.length > 0
        ) {
            startXrayTraps(row.ownerId, row.id);
        }
    }
    return { running: loops.size };
}
