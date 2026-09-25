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
 * The loop is memory; what it knows is on the install's settings, and the minute
 * sweep (`sweepXrayTraps`) starts it again after Polaris restarts or updates.
 * Every write goes through `updateXray`, which only lands on the settings it
 * read, so a player cleared from the screen while the loop runs stays cleared
 * and a honeypot placed while the settings are saved is never forgotten.
 */

import * as xray from "./xray";
import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { javaComponent } from "./announcement";
import { timeoutPlayer } from "./timeout-service";
import { withServerContainer, type ServerContainer } from "./service";

const { readInstallConfig } = host.appsInstallConfig;
const { createNotification } = host.notificationService;

const TICK_MS = 4_000;
const PLACE_EVERY_MS = 60_000;
const AUDIT_EVERY_MS = 10 * 60_000;
/** Tries per placement pass: most points are next to a cave or a build and refused. */
const PLACE_TRIES = 16;
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
    throw new Error("The server's settings kept changing while this was saved. Try again.");
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
    if (!state.settings.enabled) {
        if (state.honeypots.length === 0 && state.cleanup.length === 0)
            return stopLoop(installedAppId);
        return clearTraps(installedAppId, loop);
    }
    const now = Date.now();
    const dims = xray.DIMENSIONS.filter(
        (dim) => dim !== "minecraft:the_nether" || state.settings.nether
    );
    loop.tick += 1;
    const claimed = new Set<string>();

    await withServerContainer(loop.ownerId, installedAppId, async (server) => {
        if (!server.running || server.edition !== "java") return;
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

    for (const dim of dims) {
        const here = positions.filter((one) => inside.get(one.name) === dim);
        if (here.length === 0) continue;
        const near = state.honeypots.filter(
            (trap) =>
                trap.dimension === dim &&
                here.some((one) => Math.hypot(one.x - trap.x, one.z - trap.z) <= NEAR_ENOUGH)
        );
        let missing = state.settings.perDimension - near.length;
        let tries = 0;
        while (missing > 0 && tries < PLACE_TRIES) {
            const around = here[tries % here.length]!;
            const [point] = xray.candidatePoints(dim, around, 1);
            tries += 1;
            if (!point) continue;
            const answer = xray.readTest(
                await server.say([xray.placeCommand(dim, point.x, point.y, point.z)])
            );
            if (answer !== "passed") continue;
            placed.push({ dimension: dim, ...point, placedAt: Date.now() });
            loop.seen.set(trapKey({ dimension: dim, ...point }), loop.tick);
            missing -= 1;
        }
        // Old ones far from everybody go, oldest first, once there are more than
        // five times what is kept around the players.
        const all = state.honeypots.filter((trap) => trap.dimension === dim);
        const surplus = all.length + placed.length - state.settings.perDimension * 5;
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
        lastAudit: Date.now()
    };
    loop.timer.unref?.();
    loops.set(installedAppId, loop);
}

/** The minute sweep: a loop for every server that has honeypots on, or left to clear. */
export async function sweepXrayTraps(): Promise<{ running: number }> {
    const rows = await prisma.installedApp.findMany({
        where: { status: { not: "removed" }, catalogId: "minecraft" },
        select: { id: true, ownerId: true, config: true }
    });
    for (const row of rows) {
        const state = xray.readXray(readInstallConfig(row.config));
        if (state.settings.enabled || state.honeypots.length > 0 || state.cleanup.length > 0) {
            startXrayTraps(row.ownerId, row.id);
        }
    }
    return { running: loops.size };
}
