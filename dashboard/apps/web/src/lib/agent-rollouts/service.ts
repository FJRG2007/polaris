/**
 * Staged agent rollouts and the offline command queue, against the database and
 * the servers.
 *
 * The agent here is the host daemon on the machine Polaris runs on: it reports a
 * version on /v1/health and installs the newest build through /v1/update. A
 * server added over SSH runs no agent of its own - Polaris drives its engine
 * through the SSH login - so it answers heartbeats but reports no version, and a
 * rollout leaves it out rather than pretending to update it.
 *
 * Every command, including the update a rollout issues, goes through the queue:
 * a server that is offline keeps its commands until it answers again, and they
 * go out oldest first. One loop does the work, every minute, under a lease so
 * two web containers never deliver the same command twice; every step is a
 * conditional write, safe to run again after a crash.
 */

import * as plan from "./plan";
import * as queue from "./queue";
import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { withLease } from "@/lib/cron/lease";
import { HostdClient } from "@polaris/hostd-client";
import { startHostUpdate } from "@/lib/update-runner";
import { localMachineNameNow } from "@/lib/local-server";
import { fixAssignment } from "@/lib/server-templates/service";
import { hostDockerDriver, localDockerDriver } from "@/lib/docker-service";
import { isLocalMachine, localMachineIdentity } from "@/lib/local-machine";

export const LOCAL_SERVER = "local";
/** Servers looked at per tick; past this the rest wait for the next one. */
const PROBE_CAP = 500;
const PROBE_CONCURRENCY = 6;
/** Commands delivered per server per tick, so one long queue cannot hold the loop. */
const DRAIN_PER_TICK = 10;
/** Finished commands shown per server. */
const HISTORY = 10;
/** How long a finished command, a finished rollout and a removed server's agent are kept. */
const RETENTION_MS = 30 * 86_400_000;

/** A refusal a person can be shown: the code is turned into a sentence on screen. */
export class RolloutRefusal extends Error {
    public constructor(public readonly code: RefusalCode) {
        super(code);
    }
}

export type RefusalCode =
    | "rolloutOpen"
    | "noRollout"
    | "notHalted"
    | "noTargets"
    | "queueFull"
    | "unknownServer"
    | "unknownAssignment"
    | "notCancellable"
    | "badWaves";

export interface ServerRef {
    readonly id: string;
    readonly name: string;
    /** Owner of the Host row, through whom its login is read. Null for local. */
    readonly ownerId: string | null;
}

/** Every server Polaris manages, the box it runs on first, without listing that
 *  box twice when it was also enrolled over SSH. */
export async function listServers(): Promise<ServerRef[]> {
    return (await loadServers()).servers;
}

/** The servers, and the Host rows that turned out to be the local one. */
async function loadServers(): Promise<{ servers: ServerRef[]; localHostIds: string[] }> {
    const [hosts, identity] = await Promise.all([
        prisma.host.findMany({
            select: { id: true, name: true, ownerId: true, address: true, dockerId: true },
            orderBy: { createdAt: "asc" },
            take: PROBE_CAP
        }),
        localMachineIdentity()
    ]);
    const local: ServerRef = { id: LOCAL_SERVER, name: localMachineNameNow(), ownerId: null };
    const remote = hosts
        .filter((host) => !isLocalMachine(host, identity))
        .map((host) => ({ id: host.id, name: host.name, ownerId: host.ownerId }));
    const localHostIds = hosts
        .filter((host) => isLocalMachine(host, identity))
        .map((host) => host.id);
    return { servers: [local, ...remote], localHostIds };
}

/** The server a queue id names. A Host row that is this very machine is the
 *  local server, which is the only one of the two the loop looks at. */
async function findServer(serverId: string): Promise<ServerRef> {
    const local: ServerRef = { id: LOCAL_SERVER, name: localMachineNameNow(), ownerId: null };
    if (serverId === LOCAL_SERVER) return local;
    const [host, identity] = await Promise.all([
        prisma.host.findUnique({
            where: { id: serverId },
            select: { id: true, name: true, ownerId: true, address: true, dockerId: true }
        }),
        localMachineIdentity()
    ]);
    if (!host) throw new RolloutRefusal("unknownServer");
    if (isLocalMachine(host, identity)) return local;
    return { id: host.id, name: host.name, ownerId: host.ownerId };
}

/** Ask one server whether it is there, and what agent it runs. */
async function probe(server: ServerRef): Promise<{ online: boolean; version: string | null }> {
    try {
        if (server.id === LOCAL_SERVER) {
            const health = await new HostdClient().health().catch(() => null);
            if (health) return { online: true, version: health.version ?? null };
            // No agent answering (the limited edition has none): the box is still
            // there while its engine answers, it just has nothing to update.
            const driver = localDockerDriver();
            try {
                return { online: await driver.ping(), version: null };
            } finally {
                await driver.dispose();
            }
        }
        const driver = await hostDockerDriver(server.id, server.ownerId ?? "");
        try {
            return { online: await driver.ping(), version: null };
        } finally {
            await driver.dispose();
        }
    } catch {
        return { online: false, version: null };
    }
}

async function inPool<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>) {
    let next = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) {
            const item = items[next++]!;
            await run(item);
        }
    });
    await Promise.all(workers);
}

/** Probe every server and record the heartbeats; returns the ones that answered. */
export async function recordHeartbeats(
    servers: readonly ServerRef[],
    now = new Date()
): Promise<Set<string>> {
    const online = new Set<string>();
    await inPool(servers, PROBE_CONCURRENCY, async (server) => {
        const found = await probe(server);
        if (!found.online) return;
        online.add(server.id);
        await prisma.serverAgent.upsert({
            where: { serverId: server.id },
            create: { serverId: server.id, version: found.version, heartbeatAt: now },
            update: { version: found.version, heartbeatAt: now }
        });
    });
    return online;
}

// ---------------------------------------------------------------------------
// The command queue
// ---------------------------------------------------------------------------

export interface EnqueueInput {
    readonly id: string;
    readonly serverId: string;
    readonly expiry: queue.ExpiryChoice;
    readonly command: queue.CommandSpec;
}

/**
 * Queue a command, or return the one already queued under this id: the client
 * mints the id, so a submit sent twice is still one command.
 */
export async function enqueueCommand(
    input: EnqueueInput,
    actorId: string | null,
    now = new Date()
) {
    const server = await findServer(input.serverId);
    const existing = await prisma.serverCommand.findUnique({ where: { id: input.id } });
    if (existing) {
        if (existing.serverId !== server.id) throw new RolloutRefusal("unknownServer");
        return existing;
    }
    if (input.command.kind === "template.apply") {
        const assignment = await prisma.hostTemplateAssignment.findUnique({
            where: { id: input.command.assignmentId },
            select: { hostId: true }
        });
        const owner = assignment ? await findServer(assignment.hostId).catch(() => null) : null;
        if (!owner || owner.id !== server.id) throw new RolloutRefusal("unknownAssignment");
    }
    const waiting = await prisma.serverCommand.count({
        where: { serverId: server.id, status: { in: ["queued", "delivering"] } }
    });
    if (!queue.hasRoom(waiting)) throw new RolloutRefusal("queueFull");
    try {
        return await prisma.serverCommand.create({
            data: {
                id: input.id,
                serverId: server.id,
                kind: input.command.kind,
                payload: queue.payloadOf(input.command),
                actorId,
                expiresAt: new Date(now.getTime() + queue.EXPIRY_CHOICES[input.expiry])
            }
        });
    } catch (error) {
        // Two submits of the same id raced: the other one created it.
        const raced = await prisma.serverCommand.findUnique({ where: { id: input.id } });
        if (raced) return raced;
        throw error;
    }
}

/**
 * Queue a command a sender could not deliver, but only when the server is really
 * not answering: a server that answers and refuses has said no, and that answer
 * is the caller's to show. True when it was queued.
 */
export async function queueIfOffline(
    serverId: string,
    command: queue.CommandSpec,
    actorId: string
): Promise<boolean> {
    const server = await findServer(serverId).catch(() => null);
    if (!server || (await probe(server)).online) return false;
    await enqueueCommand({ id: randomUUID(), serverId: server.id, expiry: "1d", command }, actorId);
    return true;
}

/** The queue's server id for a Containers connection id, or null for a stored
 *  connection that is not one of Polaris's servers. */
export function serverOfConnection(connectionId: string): string | null {
    if (connectionId === LOCAL_SERVER) return LOCAL_SERVER;
    if (!connectionId.startsWith("host:")) return null;
    const id = connectionId.slice("host:".length);
    return queue.serverIdSchema.safeParse(id).success ? id : null;
}

/** Cancel a command that is still waiting. One already out is not called back. */
export async function cancelCommand(id: string): Promise<void> {
    const done = await prisma.serverCommand.updateMany({
        where: { id, status: "queued" },
        data: { status: "cancelled", finishedAt: new Date() }
    });
    if (done.count === 0) throw new RolloutRefusal("notCancellable");
}

type Outcome = { ok: true; result: string } | { ok: false; result: string; offline?: boolean };

/** Carry one command out over the path the rest of Polaris already uses. */
async function execute(server: ServerRef, command: queue.CommandSpec): Promise<Outcome> {
    switch (command.kind) {
        case "container.restart":
        case "container.start":
        case "container.stop": {
            const driver =
                server.id === LOCAL_SERVER
                    ? localDockerDriver()
                    : await hostDockerDriver(server.id, server.ownerId ?? "");
            try {
                if (!(await driver.ping())) return { ok: false, result: "offline", offline: true };
                if (command.kind === "container.restart") await driver.restart(command.container);
                else if (command.kind === "container.start") await driver.start(command.container);
                else await driver.stop(command.container);
                return { ok: true, result: "done" };
            } finally {
                await driver.dispose();
            }
        }
        case "template.apply": {
            const owner =
                server.ownerId ??
                (
                    await prisma.hostTemplateAssignment.findUnique({
                        where: { id: command.assignmentId },
                        select: { template: { select: { ownerId: true } } }
                    })
                )?.template.ownerId;
            if (!owner) return { ok: false, result: "unknownAssignment" };
            const view = await fixAssignment(owner, command.assignmentId);
            return { ok: true, result: `template:${view.status}` };
        }
        case "agent.update": {
            if (server.id !== LOCAL_SERVER) return { ok: false, result: "noAgent" };
            const started = await startHostUpdate();
            if (started === "started") return { ok: true, result: "updateStarted" };
            if (started === "unreachable") return { ok: false, result: "offline", offline: true };
            return { ok: false, result: `update:${started}` };
        }
    }
}

/**
 * Deliver what a server has waiting, oldest first. Each command is claimed with
 * a conditional write before it goes out, so only one process ever sends it; a
 * server that stops answering half-way keeps the rest for the next tick.
 */
export async function drainServer(server: ServerRef, now = new Date()): Promise<number> {
    const rows = await prisma.serverCommand.findMany({
        where: { serverId: server.id, status: { in: ["queued", "delivering"] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: queue.QUEUE_LIMIT
    });
    const { deliver, expire, abandon } = queue.drainOrder(rows, now);
    if (expire.length) {
        await prisma.serverCommand.updateMany({
            where: {
                id: { in: expire.map((row) => row.id) },
                status: { in: ["queued", "delivering"] }
            },
            data: { status: "expired", finishedAt: now }
        });
    }
    if (abandon.length) {
        await prisma.serverCommand.updateMany({
            where: { id: { in: abandon.map((row) => row.id) }, status: "delivering" },
            data: { status: "failed", result: "interrupted", finishedAt: now }
        });
    }
    let delivered = 0;
    for (const row of deliver.slice(0, DRAIN_PER_TICK)) {
        const claimed = await prisma.serverCommand.updateMany({
            where: { id: row.id, status: row.status, attempts: row.attempts },
            data: { status: "delivering", startedAt: now, attempts: { increment: 1 } }
        });
        if (claimed.count === 0) continue;
        const command = queue.readCommand(row.kind, row.payload);
        let outcome: Outcome;
        try {
            outcome = command
                ? await execute(server, command)
                : { ok: false, result: "unreadable" };
        } catch (error) {
            console.error(`polaris: command ${row.id} on ${server.id} failed:`, error);
            outcome = { ok: false, result: "failed" };
        }
        if (!outcome.ok && outcome.offline) {
            // Not an answer, an absence: put it back and stop here, so what is
            // behind it does not overtake it.
            await prisma.serverCommand.updateMany({
                where: { id: row.id, status: "delivering" },
                data: { status: "queued", startedAt: null }
            });
            break;
        }
        await prisma.serverCommand.updateMany({
            where: { id: row.id, status: "delivering" },
            data: {
                status: outcome.ok ? "done" : "failed",
                result: outcome.result,
                finishedAt: new Date()
            }
        });
        if (!outcome.ok && row.kind === "agent.update") {
            await prisma.agentRolloutTarget.updateMany({
                where: { serverId: server.id, state: "updating", rollout: { status: "running" } },
                data: { state: "failed", error: "refused", finishedAt: new Date() }
            });
        }
        delivered++;
    }
    return delivered;
}

// ---------------------------------------------------------------------------
// Rollouts
// ---------------------------------------------------------------------------

export interface StartInput {
    readonly version: string;
    readonly waves: readonly number[];
    readonly healthMinutes: number;
}

/** Plan a rollout over every server and start its first wave on the next tick. */
export async function startRollout(input: StartInput, actorId: string) {
    if (!plan.validWaves(input.waves)) throw new RolloutRefusal("badWaves");
    const servers = await listServers();
    const agents = await prisma.serverAgent.findMany({
        where: { serverId: { in: servers.map((server) => server.id) } }
    });
    const byId = new Map(agents.map((agent) => [agent.serverId, agent]));
    const planServers = servers.map((server) => ({
        id: server.id,
        version: byId.get(server.id)?.version ?? null,
        pinnedVersion: byId.get(server.id)?.pinnedVersion ?? null
    }));
    const targets = plan.planRollout(planServers, input.version, input.waves);
    if (!targets.some((target) => target.state === "pending")) {
        throw new RolloutRefusal("noTargets");
    }
    try {
        return await prisma.agentRollout.create({
            data: {
                version: input.version,
                previousVersion: plan.previousVersion(planServers, input.version),
                waves: JSON.stringify(input.waves),
                healthMinutes: input.healthMinutes,
                actorId,
                openKey: "open",
                targets: {
                    create: targets.map((target) => ({
                        serverId: target.serverId,
                        wave: target.wave,
                        state: target.state,
                        fromVersion: target.fromVersion,
                        error: target.reason
                    }))
                }
            }
        });
    } catch (error) {
        if (isUniqueViolation(error)) throw new RolloutRefusal("rolloutOpen");
        throw error;
    }
}

function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === "P2002";
}

async function openRollout() {
    return prisma.agentRollout.findUnique({ where: { openKey: "open" } });
}

/** Retry the servers that failed and carry on from the wave that halted. */
export async function resumeRollout(): Promise<void> {
    const rollout = await openRollout();
    if (!rollout) throw new RolloutRefusal("noRollout");
    if (rollout.status !== "halted") throw new RolloutRefusal("notHalted");
    await prisma.$transaction([
        prisma.agentRolloutTarget.updateMany({
            where: { rolloutId: rollout.id, state: "failed" },
            data: {
                state: "pending",
                error: null,
                startedAt: null,
                healthySince: null,
                finishedAt: null
            }
        }),
        prisma.agentRollout.updateMany({
            where: { id: rollout.id, status: "halted" },
            data: { status: "running", haltReason: null }
        })
    ]);
}

/** Halt by hand, as a failure would. */
export async function haltRollout(): Promise<void> {
    const rollout = await openRollout();
    if (!rollout) throw new RolloutRefusal("noRollout");
    await prisma.agentRollout.updateMany({
        where: { id: rollout.id, status: "running" },
        data: { status: "halted", haltReason: "manual" }
    });
}

/**
 * End the rollout and keep every server it reached on the previous version: no
 * further wave runs, the updates still waiting are cancelled, and those servers
 * are pinned so the next rollout leaves them alone until someone unpins them.
 */
export async function rollbackRollout(): Promise<{ pinned: number }> {
    const rollout = await openRollout();
    if (!rollout) throw new RolloutRefusal("noRollout");
    const targets = await prisma.agentRolloutTarget.findMany({
        where: { rolloutId: rollout.id },
        select: { serverId: true, state: true }
    });
    const pins = plan.rollbackPins(
        targets.map((target) => ({
            serverId: target.serverId,
            state: target.state as plan.TargetState
        }))
    );
    const now = new Date();
    const ended = await prisma.agentRollout.updateMany({
        where: { id: rollout.id, openKey: "open" },
        data: { status: "rolled-back", openKey: null, finishedAt: now }
    });
    if (ended.count === 0) throw new RolloutRefusal("noRollout");
    await prisma.serverCommand.updateMany({
        where: {
            kind: "agent.update",
            status: "queued",
            serverId: { in: targets.map((target) => target.serverId) },
            payload: JSON.stringify({ version: rollout.version })
        },
        data: { status: "cancelled", finishedAt: now }
    });
    if (rollout.previousVersion) {
        for (const serverId of pins) {
            await prisma.serverAgent.upsert({
                where: { serverId },
                create: { serverId, pinnedVersion: rollout.previousVersion },
                update: { pinnedVersion: rollout.previousVersion }
            });
        }
    }
    return { pinned: rollout.previousVersion ? pins.length : 0 };
}

/** Pin a server to a version (rollouts of any other version skip it), or unpin it. */
export async function setPin(serverId: string, version: string | null): Promise<void> {
    await findServer(serverId);
    await prisma.serverAgent.upsert({
        where: { serverId },
        create: { serverId, pinnedVersion: version },
        update: { pinnedVersion: version }
    });
}

/** One step of the open rollout: start the current wave, gate it, move on. */
export async function advanceRollout(
    servers: readonly ServerRef[],
    now = new Date()
): Promise<void> {
    const rollout = await openRollout();
    if (!rollout || rollout.status !== "running") return;
    const wave = await prisma.agentRolloutTarget.findMany({
        where: { rolloutId: rollout.id, wave: rollout.wave }
    });
    const agents = await prisma.serverAgent.findMany({
        where: { serverId: { in: wave.map((target) => target.serverId) } }
    });
    const byId = new Map(agents.map((agent) => [agent.serverId, agent]));
    const known = new Set(servers.map((server) => server.id));
    const config = { version: rollout.version, healthMs: rollout.healthMinutes * 60_000 };
    const states: plan.TargetState[] = [];
    for (const target of wave) {
        const agent = byId.get(target.serverId);
        let state = target.state as plan.TargetState;
        if (state === "pending") {
            const pinned = agent?.pinnedVersion ?? null;
            if (!known.has(target.serverId) || (pinned !== null && pinned !== rollout.version)) {
                state = "skipped";
                await prisma.agentRolloutTarget.updateMany({
                    where: { id: target.id, state: "pending" },
                    data: {
                        state,
                        error: known.has(target.serverId) ? "pinned" : "no-agent",
                        finishedAt: now
                    }
                });
            } else {
                state = "updating";
                const claimed = await prisma.agentRolloutTarget.updateMany({
                    where: { id: target.id, state: "pending" },
                    data: { state, startedAt: now }
                });
                const queued =
                    claimed.count === 0 ||
                    (await enqueueCommand(
                        {
                            id: randomUUID(),
                            serverId: target.serverId,
                            expiry: "1h",
                            command: { kind: "agent.update", version: rollout.version }
                        },
                        rollout.actorId,
                        now
                    ).then(
                        () => true,
                        (error: unknown) => {
                            if (!(error instanceof RolloutRefusal)) {
                                console.error(
                                    `polaris: rollout update for ${target.serverId} not queued:`,
                                    error
                                );
                            }
                            return false;
                        }
                    ));
                if (!queued) {
                    state = "failed";
                    await prisma.agentRolloutTarget.updateMany({
                        where: { id: target.id, state: "updating" },
                        data: { state, error: "refused", finishedAt: now }
                    });
                }
            }
        } else if (state === "updating" || state === "verifying") {
            const step = plan.stepTarget(
                {
                    state,
                    startedAt: target.startedAt,
                    healthySince: target.healthySince,
                    fromVersion: target.fromVersion
                },
                { version: agent?.version ?? null, heartbeatAt: agent?.heartbeatAt ?? null },
                now,
                config
            );
            state = step.state;
            await prisma.agentRolloutTarget.updateMany({
                where: { id: target.id, state: target.state },
                data: {
                    state: step.state,
                    healthySince: step.healthySince,
                    error: step.reason,
                    finishedAt: step.state === "healthy" || step.state === "failed" ? now : null
                }
            });
        }
        states.push(state);
    }
    const verdict = plan.waveVerdict(states);
    if (verdict === "halt") {
        await prisma.agentRollout.updateMany({
            where: { id: rollout.id, status: "running" },
            data: { status: "halted", haltReason: "failed" }
        });
        return;
    }
    if (verdict !== "advance") return;
    const later = await prisma.agentRolloutTarget.count({
        where: { rolloutId: rollout.id, wave: { gt: rollout.wave } }
    });
    await prisma.agentRollout.updateMany({
        where: { id: rollout.id, status: "running", wave: rollout.wave },
        data:
            later > 0
                ? { wave: rollout.wave + 1 }
                : { status: "done", openKey: null, finishedAt: now }
    });
}

/** The loop's whole job, once. */
export async function tick(now = new Date()): Promise<void> {
    await withLease("agent-rollouts", 5 * 60_000, async () => {
        const servers = await listServers();
        const online = await recordHeartbeats(servers, now);
        const waiting = await prisma.serverCommand.groupBy({
            by: ["serverId"],
            where: { status: { in: ["queued", "delivering"] } }
        });
        const byId = new Map(servers.map((server) => [server.id, server]));
        const removed = await removedServers(
            waiting.map((row) => row.serverId).filter((serverId) => !byId.has(serverId))
        );
        for (const { serverId } of waiting) {
            const server = byId.get(serverId);
            if (!server) {
                if (!removed.has(serverId)) continue;
                // The server was removed: nothing it was waiting for can arrive.
                await prisma.serverCommand.updateMany({
                    where: { serverId, status: "queued" },
                    data: { status: "expired", finishedAt: now, result: "unknownServer" }
                });
                continue;
            }
            if (online.has(serverId)) await drainServer(server, now);
            else {
                await prisma.serverCommand.updateMany({
                    where: { serverId, status: "queued", expiresAt: { lte: now } },
                    data: { status: "expired", finishedAt: now }
                });
            }
        }
        await advanceRollout(servers, now);
        await pruneFinished(now);
    });
}

/** Of these server ids, the ones that no longer name a server at all. */
async function removedServers(serverIds: readonly string[]): Promise<Set<string>> {
    const ids = serverIds.filter((serverId) => serverId !== LOCAL_SERVER);
    if (ids.length === 0) return new Set();
    const hosts = await prisma.host.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const present = new Set(hosts.map((host) => host.id));
    return new Set(ids.filter((serverId) => !present.has(serverId)));
}

/** Forget what finished longer ago than the retention window, and the agent
 *  records of servers that were removed. */
export async function pruneFinished(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    await prisma.serverCommand.deleteMany({
        where: {
            status: { in: ["done", "failed", "expired", "cancelled"] },
            finishedAt: { lt: cutoff }
        }
    });
    await prisma.agentRollout.deleteMany({ where: { openKey: null, finishedAt: { lt: cutoff } } });
    const agents = await prisma.serverAgent.findMany({
        where: { serverId: { not: LOCAL_SERVER }, updatedAt: { lt: cutoff } },
        select: { serverId: true },
        take: PROBE_CAP
    });
    const gone = await removedServers(agents.map((agent) => agent.serverId));
    if (gone.size > 0)
        await prisma.serverAgent.deleteMany({ where: { serverId: { in: [...gone] } } });
}

let started = false;
let running = false;

export function startRolloutLoop(): void {
    if (started) return;
    started = true;
    const run = (): void => {
        if (running) return;
        running = true;
        void tick()
            .catch((error) => console.error("polaris: agent rollout tick failed:", error))
            .finally(() => {
                running = false;
            });
    };
    setInterval(run, 60_000).unref?.();
    setTimeout(run, 30_000).unref?.();
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export interface CommandView {
    readonly id: string;
    readonly kind: string;
    readonly target: string;
    readonly status: string;
    readonly result: string | null;
    readonly createdAt: string;
    readonly expiresAt: string;
}

export interface ServerAgentView {
    readonly id: string;
    readonly name: string;
    readonly version: string | null;
    readonly heartbeatAt: string | null;
    readonly online: boolean;
    readonly pinnedVersion: string | null;
    readonly waiting: CommandView[];
    /** The templates applied to this server, which a template command picks from. */
    readonly assignments: { id: string; name: string }[];
}

export interface RolloutView {
    readonly id: string;
    readonly version: string;
    readonly previousVersion: string | null;
    readonly status: string;
    readonly wave: number;
    readonly waves: number[];
    readonly healthMinutes: number;
    readonly haltReason: string | null;
    readonly createdAt: string;
    readonly targets: {
        serverId: string;
        wave: number;
        state: string;
        fromVersion: string | null;
        error: string | null;
    }[];
}

export interface RolloutScreen {
    readonly servers: ServerAgentView[];
    readonly rollout: RolloutView | null;
}

function commandView(
    row: {
        id: string;
        kind: string;
        payload: string;
        status: string;
        result: string | null;
        createdAt: Date;
        expiresAt: Date;
    },
    templates: ReadonlyMap<string, string> = new Map()
): CommandView {
    const spec = queue.readCommand(row.kind, row.payload);
    const target = !spec
        ? ""
        : "container" in spec
          ? spec.container
          : "version" in spec
            ? spec.version
            : (templates.get(spec.assignmentId) ?? spec.assignmentId);
    return {
        id: row.id,
        kind: row.kind,
        target,
        status: row.status,
        result: row.result,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString()
    };
}

/** The templates applied to each server, keyed by the server's queue id. */
async function assignmentsByServer(
    servers: readonly ServerRef[],
    localHostIds: readonly string[]
): Promise<Map<string, { id: string; name: string }[]>> {
    const hostIds = [
        ...servers.filter((server) => server.id !== LOCAL_SERVER).map((server) => server.id),
        ...localHostIds
    ];
    const local = new Set(localHostIds);
    const rows = hostIds.length
        ? await prisma.hostTemplateAssignment.findMany({
              where: { hostId: { in: hostIds } },
              select: { id: true, hostId: true, template: { select: { name: true } } },
              orderBy: { createdAt: "asc" },
              take: hostIds.length * queue.QUEUE_LIMIT
          })
        : [];
    const byServer = new Map<string, { id: string; name: string }[]>();
    for (const row of rows) {
        const serverId = local.has(row.hostId) ? LOCAL_SERVER : row.hostId;
        byServer.set(serverId, [
            ...(byServer.get(serverId) ?? []),
            { id: row.id, name: row.template.name }
        ]);
    }
    return byServer;
}

/** Everything the screen draws, in one read per table. Every waiting command is
 *  read, since each server holds at most QUEUE_LIMIT of them and any of them may
 *  be cancelled; finished ones are read per server, when asked for. */
export async function rolloutScreen(now = new Date()): Promise<RolloutScreen> {
    const { servers, localHostIds } = await loadServers();
    const ids = servers.map((server) => server.id);
    const [agents, waiting, assignments, rollout] = await Promise.all([
        prisma.serverAgent.findMany({ where: { serverId: { in: ids } } }),
        prisma.serverCommand.findMany({
            where: { serverId: { in: ids }, status: { in: ["queued", "delivering"] } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: queue.QUEUE_LIMIT * ids.length
        }),
        assignmentsByServer(servers, localHostIds),
        prisma.agentRollout.findFirst({
            orderBy: { createdAt: "desc" },
            include: { targets: { orderBy: [{ wave: "asc" }, { serverId: "asc" }] } }
        })
    ]);
    const agentOf = new Map(agents.map((agent) => [agent.serverId, agent]));
    const templates = new Map([...assignments.values()].flat().map((one) => [one.id, one.name]));
    return {
        servers: servers.map((server) => {
            const agent = agentOf.get(server.id);
            const heartbeat = agent?.heartbeatAt ?? null;
            return {
                id: server.id,
                name: server.name,
                version: agent?.version ?? null,
                heartbeatAt: heartbeat?.toISOString() ?? null,
                online:
                    heartbeat !== null &&
                    now.getTime() - heartbeat.getTime() <= plan.HEARTBEAT_STALE_MS,
                pinnedVersion: agent?.pinnedVersion ?? null,
                waiting: waiting
                    .filter((row) => row.serverId === server.id)
                    .map((row) => commandView(row, templates)),
                assignments: assignments.get(server.id) ?? []
            };
        }),
        rollout: rollout
            ? {
                  id: rollout.id,
                  version: rollout.version,
                  previousVersion: rollout.previousVersion,
                  status: rollout.status,
                  wave: rollout.wave,
                  waves: plan.parseWaves(rollout.waves),
                  healthMinutes: rollout.healthMinutes,
                  haltReason: rollout.haltReason,
                  createdAt: rollout.createdAt.toISOString(),
                  targets: rollout.targets.map((target) => ({
                      serverId: target.serverId,
                      wave: target.wave,
                      state: target.state,
                      fromVersion: target.fromVersion,
                      error: target.error
                  }))
              }
            : null
    };
}

/** One server's most recent finished commands. */
export async function commandHistory(serverId: string): Promise<CommandView[]> {
    const server = await findServer(serverId);
    const rows = await prisma.serverCommand.findMany({
        where: { serverId: server.id, status: { notIn: ["queued", "delivering"] } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: HISTORY
    });
    const assignmentIds = rows.flatMap((row) => {
        const spec = queue.readCommand(row.kind, row.payload);
        return spec?.kind === "template.apply" ? [spec.assignmentId] : [];
    });
    const assignments = assignmentIds.length
        ? await prisma.hostTemplateAssignment.findMany({
              where: { id: { in: assignmentIds } },
              select: { id: true, template: { select: { name: true } } }
          })
        : [];
    const templates = new Map(assignments.map((one) => [one.id, one.template.name]));
    return rows.map((row) => commandView(row, templates));
}
