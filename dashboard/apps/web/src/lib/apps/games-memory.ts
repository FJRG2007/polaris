/**
 * Keeping a server's heap in step with what the server has become.
 *
 * The heap was decided when the server was created and never again, which is how
 * a server made for a handful of friends and later given a mod loader and six
 * mods ends up out of memory in the middle of generating the world. The symptom
 * is the cruel part: chunks stop appearing and mobs stop moving while the tick
 * rate reads a perfect twenty, because the thread that died is the one nobody
 * watches. See `memory-plan.ts` for the arithmetic; this is what reads the server,
 * the machine and the evidence, and writes the setting.
 *
 * Three rules hold everything here together:
 *
 * - **Only servers that asked.** A server in `fixed` mode keeps the number that
 *   was typed, for ever. Nothing about an existing install changes until somebody
 *   switches it over, so no deployment wakes up using more memory than it did.
 * - **Only upwards, and only with a reason.** The plan raises a heap when the
 *   server has grown into it or has actually run out; it never lowers one on its
 *   own, because a heap that is too big costs a number in a dialog and a heap
 *   that is too small costs a world that stops generating.
 * - **Never a restart of its own.** A new figure is written and picked up by the
 *   restart the operator was going to do anyway. The single exception is a server
 *   that has already run out of memory with nobody on it: there, restarting is
 *   the repair, and waiting means leaving it broken until somebody notices.
 */

import { prisma } from "@polaris/db";
import { readAppRuntimeLog } from "@/lib/deploy-service";
import * as plan from "@/lib/apps/minecraft/memory-plan";
import { isGameServerApp } from "@/lib/apps/games-service";
import { formatMemory } from "@/lib/apps/minecraft/blueprints";
import { createNotification } from "@/lib/notification-service";
import { listEnvVars, setEnvVars } from "@/lib/env-var-service";
import { PROJECTS_KEY, SOFTWARE_KEY } from "@/lib/apps/minecraft/join-guard";
import { loaderForType, parseProjectList } from "@/lib/apps/minecraft/modrinth";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { listGameMachines, parseMemoryMb, type GameMachine } from "@/lib/apps/games-service";

/** The environment key the heap is handed to the image as. */
export const MEMORY_KEY = "MEMORY";

/** Where the last look for an out-of-memory is recorded, so the log is read four
 *  times an hour for a planned server rather than once a minute for every server
 *  on the platform. */
export const MEMORY_WATCH_KEY = "memoryWatch";

/** When an out-of-memory in the log was last acted on. The same run stays in the
 *  log until the server is deployed again, so it is only evidence once more after
 *  that. */
export const MEMORY_EXHAUSTED_KEY = "memoryExhaustedAt";

/** How often a planned server's log is read for evidence it ran out. */
const WATCH_EVERY_MS = 15 * 60 * 1000;

/** How much log to read. An out-of-memory prints its stack immediately; anything
 *  older than the last few hundred lines is a run that has already been acted on. */
const WATCH_TAIL = 400;

/** What the JVM prints when it runs out, and what nothing else prints. */
const OUT_OF_MEMORY = /java\.lang\.OutOfMemoryError/;

/** A server whose heap differs from its plan by less than this is left alone: the
 *  restart is not worth less than half a gigabyte. */
const TOLERANCE_MB = 512;

export interface MemorySweep {
    /** How many planned servers were looked at. */
    readonly checked: number;
    /** How many were given a bigger heap. */
    readonly raised: number;
    /** How many of those were restarted onto it straight away, because they had
     *  run out and nobody was playing. */
    readonly restarted: number;
}

interface PlanContext {
    readonly installedAppId: string;
    readonly applicationId: string;
    readonly ownerId: string;
    readonly name: string;
    readonly config: string | null;
    readonly targetId: string | null;
}

/** Everything the plan needs about one server, read in a single go. Null for an
 *  install that is not this owner's or was never deployed. */
export async function planContextFor(
    installedAppId: string,
    ownerId: string
): Promise<PlanContext | null> {
    const install = await prisma.installedApp
        .findFirst({
            where: { id: installedAppId, ownerId, status: { not: "removed" } },
            select: { id: true, name: true, applicationId: true, config: true, targetId: true }
        })
        .catch(() => null);
    if (!install?.applicationId) return null;
    return {
        installedAppId: install.id,
        applicationId: install.applicationId,
        ownerId,
        name: install.name,
        config: install.config,
        targetId: install.targetId
    };
}

/**
 * The heap a reset settles on for a server that already exists.
 *
 * The shape's figure knows nothing about the server it lands on, so it is bounded
 * here the way any plan is: by the operator's ceiling and by what the machine can
 * spare. A server in automatic mode is also never taken below what it has - a
 * reset is not a reason to undo a raise it grew or ran out into.
 */
export async function resetHeapMb(
    ownerId: string,
    installedAppId: string,
    heapMb: number
): Promise<number> {
    const context = await planContextFor(installedAppId, ownerId);
    const planned = context ? await plannedMemoryFor(context) : null;
    if (!context || !planned) return heapMb;
    const bounded = plan.clampHeapMb(heapMb, planned.bounds);
    return plan.memoryMode(readInstallConfig(context.config)[plan.MEMORY_MODE_KEY]) === "auto"
        ? Math.max(bounded, planned.currentMb)
        : bounded;
}

/** What one server's plan comes to, and what bounded it. */
export interface PlannedMemory {
    readonly wantedMb: number;
    readonly currentMb: number;
    readonly reason: string;
    readonly bounds: plan.HeapBounds;
}

/**
 * What one server's heap should be, from what it actually is.
 *
 * Every input is read from things Polaris already keeps: the environment the
 * container is built with, and the once-a-minute player samples. Nothing is
 * written down twice to answer this. `machines` is the owner's machine list, for
 * a caller that already has it.
 */
export async function plannedMemoryFor(
    context: PlanContext,
    now: Date = new Date(),
    machines?: readonly GameMachine[]
): Promise<PlannedMemory | null> {
    const env = await listEnvVars("application", context.applicationId, context.ownerId).catch(
        () => []
    );
    const value = (key: string): string => env.find((row) => row.key === key)?.value ?? "";
    const currentMb = parseMemoryMb(value(MEMORY_KEY));
    // A server with no heap to hand out is not a server this plans for: Bedrock
    // runs no JVM, and ARK and FiveM are given no limit at all.
    if (currentMb <= 0) return null;

    const loader = loaderForType(value(SOFTWARE_KEY)) ?? "";
    const mods = parseProjectList(value(PROJECTS_KEY)).length;
    const maxPlayers = Number.parseInt(value("MAX_PLAYERS"), 10);

    const since = new Date(now.getTime() - plan.PEAK_DAYS * 86_400_000);
    const busiest = await prisma.gameSample
        .aggregate({
            where: { installedAppId: context.installedAppId, ts: { gte: since } },
            _max: { playersOnline: true }
        })
        .catch(() => null);
    const players = plan.playersToPlanFor(
        busiest?._max.playersOnline ?? 0,
        Number.isFinite(maxPlayers) ? maxPlayers : 0
    );

    const input = { concurrentPlayers: players, loader, mods };
    const config = readInstallConfig(context.config);
    const listed = machines ?? (await listGameMachines(context.ownerId, false).catch(() => []));
    const bounds: plan.HeapBounds = {
        ceilingMb: plan.memoryCeilingMb(config[plan.MEMORY_CEILING_KEY]),
        ...plan.machineHeapBounds(await machineOf(context, listed), currentMb)
    };
    const wantedMb = plan.clampHeapMb(plan.plannedHeapMb(input), bounds);
    return { wantedMb, currentMb, reason: plan.planReason(input), bounds };
}

/** The machine this server runs on, out of the owner's list. */
async function machineOf(
    context: PlanContext,
    machines: readonly GameMachine[]
): Promise<GameMachine | undefined> {
    const target = context.targetId
        ? await prisma.deployTarget
              .findFirst({
                  where: { id: context.targetId },
                  select: { kind: true, hostId: true }
              })
              .catch(() => null)
        : null;
    const machineId = target?.kind === "host" && target.hostId ? target.hostId : "local";
    return machines.find((entry) => entry.id === machineId);
}

/**
 * The heap a server should start with next time, written where the image reads it.
 *
 * Returns what it wrote, or null for a server whose heap is already right - which
 * is the answer on almost every call, and is why this is cheap enough to run from
 * the action that saves the settings.
 */
export async function applyPlannedMemory(
    context: PlanContext,
    now: Date = new Date()
): Promise<{ fromMb: number; toMb: number; reason: string; } | null> {
    if (plan.memoryMode(readInstallConfig(context.config)[plan.MEMORY_MODE_KEY]) !== "auto") return null;
    const planned = await plannedMemoryFor(context, now);
    return planned ? writePlannedMemory(context, planned, false) : null;
}

/** Writes a plan already worked out. A server seen running out (`exhausted`) is
 *  given a step past what it has, whatever the plan says - the plan is an estimate
 *  and the crash is a fact. */
async function writePlannedMemory(
    context: PlanContext,
    planned: PlannedMemory,
    exhausted: boolean
): Promise<{ fromMb: number; toMb: number; reason: string; } | null> {
    const floor = exhausted ? (plan.raisedHeapMb(planned.currentMb, planned.bounds) ?? 0) : 0;
    const target = Math.max(planned.wantedMb, floor);
    // Only upwards, and - for a server that is merely growing - only when the
    // difference is worth the restart it will be picked up by. A server that has
    // already run out is the exception: half a gigabyte it can actually use beats
    // a tidy figure it cannot, so the tolerance stands aside for it.
    const worthIt =
        floor > 0 ? target > planned.currentMb : target >= planned.currentMb + TOLERANCE_MB;
    if (!worthIt) return null;
    await setEnvVars("application", context.applicationId, context.ownerId, [
        { key: MEMORY_KEY, value: formatMemory(target), isSecret: false }
    ]);
    return { fromMb: planned.currentMb, toMb: target, reason: planned.reason };
}

/**
 * Look at every planned server, and at the ones that have run out.
 *
 * Runs beside the crash-loop sweep, on the same minute, and is deliberately
 * lopsided: the plan is recomputed for every planned server (a handful of indexed
 * reads, against one machine list for the whole sweep), while the log - the
 * expensive part - is only read for a server that has a heap and has not been
 * looked at for a quarter of an hour.
 */
export async function sweepMemoryPlans(
    ownerId: string,
    now: Date = new Date()
): Promise<MemorySweep> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, applicationId: { not: null } },
        select: {
            id: true,
            name: true,
            catalogId: true,
            applicationId: true,
            config: true,
            targetId: true
        }
    });

    let machines: GameMachine[] | null = null;
    let checked = 0;
    let raised = 0;
    let restarted = 0;
    for (const install of installs) {
        const applicationId = install.applicationId;
        if (!applicationId || !isGameServerApp(install.catalogId)) continue;
        const config = readInstallConfig(install.config);
        if (plan.memoryMode(config[plan.MEMORY_MODE_KEY]) !== "auto") continue;

        const app = await prisma.application
            .findFirst({ where: { id: applicationId }, select: { desiredState: true } })
            .catch(() => null);
        if (app?.desiredState !== "running") continue;

        const context: PlanContext = {
            installedAppId: install.id,
            applicationId,
            ownerId,
            name: install.name,
            config: install.config,
            targetId: install.targetId
        };
        machines ??= await listGameMachines(ownerId, false).catch(() => []);
        const planned = await plannedMemoryFor(context, now, machines);
        if (!planned) continue;
        checked += 1;

        // Has it actually run out? Only asked of a server that has not been asked
        // recently, because this is the one expensive read here.
        const watched = recordedAt(config[MEMORY_WATCH_KEY]);
        const due = watched === null || now.getTime() - watched >= WATCH_EVERY_MS;
        let exhausted = false;
        if (due) {
            const log = await readAppRuntimeLog(applicationId, ownerId, WATCH_TAIL).catch(() => "");
            exhausted =
                OUT_OF_MEMORY.test(log) &&
                (await redeployedSince(applicationId, recordedAt(config[MEMORY_EXHAUSTED_KEY])));
        }

        let failed = false;
        const applied = await writePlannedMemory(context, planned, exhausted).catch(() => {
            failed = true;
            return null;
        });
        if (due) {
            await patchInstallConfig(install.id, {
                [MEMORY_WATCH_KEY]: now.toISOString(),
                ...(exhausted && !failed ? { [MEMORY_EXHAUSTED_KEY]: now.toISOString() } : {})
            }).catch(() => undefined);
        }
        if (failed) continue;
        if (!applied) {
            if (exhausted) {
                await createNotification({
                    userId: ownerId,
                    type: "games.memory-exhausted",
                    title: `${install.name} ran out of memory`,
                    body: `It ran out at ${formatMemory(planned.currentMb)}, which is as far as it may go: ${
                        planned.currentMb >= plan.memoryCeilingMb(config[plan.MEMORY_CEILING_KEY])
                            ? "that is its memory limit"
                            : "that is all its machine can spare"
                    }. Raise the limit under Memory, or free up memory on the machine, and restart it.`,
                    href: `/apps/installed/${install.id}`,
                    level: "warning",
                    actionRequired: true
                }).catch(() => undefined);
            }
            continue;
        }
        raised += 1;
        const machine = await machineOf(context, machines);
        machines = machines.map((entry) =>
            entry === machine
                ? { ...entry, committedMb: entry.committedMb + applied.toMb - applied.fromMb }
                : entry
        );

        // Restarting is only ever the repair for a server that has already broken,
        // and only when it costs nobody their evening.
        const playing = await playersOnline(install.id, now);
        const repairNow = exhausted && playing === 0;
        let done = false;
        if (repairNow) {
            const { deployApplication } = await import("@/lib/deploy-service");
            done = await deployApplication(applicationId, ownerId, null)
                .then(() => true)
                .catch(() => false);
            if (done) restarted += 1;
        }

        await createNotification({
            userId: ownerId,
            type: "games.memory-raised",
            title: `${install.name} was given more memory`,
            body: exhausted
                ? `It ran out of memory, so its heap went from ${formatMemory(applied.fromMb)} to ${formatMemory(applied.toMb)}.${
                      done
                          ? " It was restarted onto it, since nobody was playing."
                          : repairNow
                            ? " Restarting it onto that did not go through, so it picks it up at its next restart."
                            : " It picks that up at its next restart."
                  }`
                : `Its heap went from ${formatMemory(applied.fromMb)} to ${formatMemory(applied.toMb)} for ${applied.reason}. It picks that up at its next restart.`,
            href: `/apps/installed/${install.id}`,
            level: exhausted ? "warning" : "info",
            actionRequired: false
        }).catch(() => undefined);
    }
    return { checked, raised, restarted };
}

/** A time recorded on the install, in milliseconds, or null for one that never
 *  was. */
function recordedAt(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
}

/** Whether the server has been deployed again since its last out-of-memory was
 *  acted on. Until it has, the log still holds that same run - and a raised heap
 *  is only picked up by a deploy, so there is nothing new to act on. */
async function redeployedSince(applicationId: string, actedAt: number | null): Promise<boolean> {
    if (actedAt === null) return true;
    const deployment = await prisma.deployment
        .findFirst({
            where: {
                deployableType: "application",
                deployableId: applicationId,
                createdAt: { gt: new Date(actedAt) }
            },
            select: { id: true }
        })
        .catch(() => null);
    return deployment !== null;
}

/** How many people were on a minute ago, from the samples already being taken. A
 *  server nothing has sampled recently reads as empty, which is the right answer
 *  for one that is not being watched. */
async function playersOnline(installedAppId: string, now: Date): Promise<number> {
    const sample = await prisma.gameSample
        .findFirst({
            where: { installedAppId, ts: { gte: new Date(now.getTime() - 5 * 60 * 1000) } },
            orderBy: { ts: "desc" },
            select: { playersOnline: true }
        })
        .catch(() => null);
    return sample?.playersOnline ?? 0;
}
