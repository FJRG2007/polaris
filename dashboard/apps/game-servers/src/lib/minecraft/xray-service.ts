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
 * The loop is memory; what it knows is on the install's settings, and the minute
 * sweep (`sweepXrayTraps`) starts it again after Polaris restarts or updates.
 * Every write reads the settings afresh first, so a player cleared from the
 * screen while the loop runs stays cleared.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { javaComponent } from "./announcement";
import { timeoutPlayer } from "./timeout-service";
import { withServerContainer, type ServerContainer } from "./service";
import * as xray from "./xray";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;
const { createNotification } = host.notificationService;

const TICK_MS = 4_000;
const PLACE_EVERY_MS = 60_000;
const AUDIT_EVERY_MS = 10 * 60_000;
/** Tries per placement pass: most points are next to a cave or a build and refused. */
const PLACE_TRIES = 16;
/** A honeypot this far from everybody is no use where it is; the oldest go first
 *  once there are more than the settings keep around the players. */
const NEAR_ENOUGH = 128;

interface Loop {
    readonly ownerId: string;
    readonly timer: ReturnType<typeof setInterval>;
    busy: boolean;
    counters: boolean;
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

/** Change the stored state from what is stored now, never from a stale copy. */
async function update(
    installedAppId: string,
    change: (state: xray.XrayState) => xray.XrayState
): Promise<xray.XrayState | null> {
    const current = await readState(installedAppId);
    if (!current) return null;
    const next = change(current.state);
    await patchInstallConfig(installedAppId, { [xray.XRAY_KEY]: next });
    return next;
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

    await withServerContainer(loop.ownerId, installedAppId, async (server) => {
        if (!server.running || server.edition !== "java") return;
        if (!loop.counters) {
            for (const line of xray.objectiveCommands()) await server.say([line]);
            loop.counters = true;
        }
        for (const dim of dims) await watch(installedAppId, loop, server, state, dim);
        if (now - loop.lastPlace >= PLACE_EVERY_MS) {
            loop.lastPlace = now;
            await place(installedAppId, server, state, dims);
        }
        if (now - loop.lastAudit >= AUDIT_EVERY_MS) {
            loop.lastAudit = now;
            await audit(installedAppId, server, state);
        }
    });
}

/** Who mined the ore since the last look, and whether a honeypot beside them is gone. */
async function watch(
    installedAppId: string,
    loop: Loop,
    server: ServerContainer,
    state: xray.XrayState,
    dim: xray.Dimension
): Promise<void> {
    const miners = xray.readPositions(await server.say([xray.minedSinceCommand(dim)]));
    for (const miner of miners) {
        await server.say([xray.resetCounterCommand(dim, miner.name)]);
        for (const trap of xray.trapsNear(state.honeypots, dim, miner)) {
            const answer = xray.readTest(await server.say([xray.stillThereCommand(trap)]));
            // Unloaded is not gone: nothing is concluded from a place the game
            // cannot see.
            if (answer !== "failed") continue;
            await recordHit(installedAppId, loop, server, miner.name, trap);
        }
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
    const next = await update(installedAppId, (state) => {
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

    if (todo.warn && xray.isPlayerName(evidence.name)) {
        const text = javaComponent(state.settings.warning, false);
        await server.say([`tellraw ${evidence.name} ${text}`]).catch(() => undefined);
        await server
            .say([`title ${evidence.name} title ${javaComponent("&c&lAnti X-Ray", false)}`])
            .catch(() => undefined);
    }
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
    if (todo.report || todo.warn || banned) {
        await update(installedAppId, (fresh) => {
            const held = fresh.evidence[key];
            if (!held) return fresh;
            return {
                ...fresh,
                evidence: {
                    ...fresh.evidence,
                    [key]: {
                        ...held,
                        reportedHits: todo.report ? hits : held.reportedHits,
                        warnedAt: todo.warn ? now : held.warnedAt,
                        bannedAt: banned ? now : held.bannedAt
                    }
                }
            };
        });
    }
    if (todo.report || banned) {
        const done = banned
            ? ` Banned for ${state.settings.banHours} h.`
            : todo.warn
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

/** Keep the settings' number of honeypots around the players in each dimension. */
async function place(
    installedAppId: string,
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
    await update(installedAppId, (fresh) => ({
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
    await update(installedAppId, (fresh) => ({
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
        await update(installedAppId, (fresh) => ({ ...fresh, honeypots: [], cleanup: left }));
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
