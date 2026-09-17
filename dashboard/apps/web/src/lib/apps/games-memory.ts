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
import { loaderForType } from "@/lib/apps/minecraft/modrinth";
import { formatMemory } from "@/lib/apps/minecraft/blueprints";
import { createNotification } from "@/lib/notification-service";
import { listEnvVars, setEnvVars } from "@/lib/env-var-service";
import { listGameMachines, parseMemoryMb } from "@/lib/apps/games-service";
import { PROJECTS_KEY, SOFTWARE_KEY } from "@/lib/apps/minecraft/join-guard";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";

/** The environment key the heap is handed to the image as. */
export const MEMORY_KEY = "MEMORY";

/** Where the last look for an out-of-memory is recorded, so the log is read four
 *  times an hour for a planned server rather than once a minute for every server
 *  on the platform. */
export const MEMORY_WATCH_KEY = "memoryWatch";

/** How often a planned server's log is read for evidence it ran out. */
const WATCH_EVERY_MS = 15 * 60 * 1000;

/** How much log to read. An out-of-memory prints its stack immediately; anything
 *  older than the last few hundred lines is a run that has already been acted on. */
const WATCH_TAIL = 400;

/** What the JVM prints when it runs out, and what nothing else prints. */
const OUT_OF_MEMORY = /java\.lang\.OutOfMemoryError/;

/** A server whose heap could differ from its plan by less than this is left alone:
 *  the restart is not worth half a gigabyte. */
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
 * What one server's heap should be, from what it actually is.
 *
 * Every input is read from things Polaris already keeps: the environment the
 * container is built with, and the once-a-minute player samples. Nothing is
 * written down twice to answer this.
 */
export async function plannedMemoryFor(
    context: PlanContext,
    now: Date = new Date()
): Promise<{ wantedMb: number; currentMb: number; reason: string } | null> {
    const env = await listEnvVars("application", context.applicationId, context.ownerId).catch(
        () => []
    );
    const value = (key: string): string => env.find((row) => row.key === key)?.value ?? "";
    const currentMb = parseMemoryMb(value(MEMORY_KEY));
    // A server with no heap to hand out is not a server this plans for: Bedrock
    // runs no JVM, and ARK and FiveM are given no limit at all.
    if (currentMb <= 0) return null;

    const loader = loaderForType(value(SOFTWARE_KEY)) ?? "";
    const mods = value(PROJECTS_KEY)
        .split(/[,\n]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0).length;
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
    const bounds = await machineBounds(context, currentMb);
    const wantedMb = plan.clampHeapMb(plan.plannedHeapMb(input), {
        ceilingMb: plan.memoryCeilingMb(config[plan.MEMORY_CEILING_KEY]),
        ...bounds
    });
    return { wantedMb, currentMb, reason: plan.planReason(input) };
}

/** What the machine this server runs on has left, with this server's own heap
 *  taken back out of the promised total - it is about to be replaced, not added
 *  to. */
async function machineBounds(
    context: PlanContext,
    currentMb: number
): Promise<{ machineTotalMb: number | null; otherServersMb: number }> {
    const machines = await listGameMachines(context.ownerId, false).catch(() => []);
    const target = context.targetId
        ? await prisma.deployTarget
              .findFirst({
                  where: { id: context.targetId },
                  select: { kind: true, hostId: true }
              })
              .catch(() => null)
        : null;
    const machineId = target?.kind === "host" && target.hostId ? target.hostId : "local";
    const machine = machines.find((entry) => entry.id === machineId);
    if (!machine) return { machineTotalMb: null, otherServersMb: 0 };
    return {
        machineTotalMb:
            machine.memoryTotalBytes !== null
                ? Math.floor(machine.memoryTotalBytes / (1024 * 1024))
                : null,
        otherServersMb: Math.max(0, machine.committedMb - currentMb)
    };
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
    options: { atLeastMb?: number } = {},
    now: Date = new Date()
): Promise<{ fromMb: number; toMb: number; reason: string } | null> {
    if (plan.memoryMode(readInstallConfig(context.config)[plan.MEMORY_MODE_KEY]) !== "auto") return null;
    const wanted = await plannedMemoryFor(context, now);
    if (!wanted) return null;
    const target = Math.max(wanted.wantedMb, options.atLeastMb ?? 0);
    // Only upwards, and - for a server that is merely growing - only when the
    // difference is worth the restart it will be picked up by. A server that has
    // already run out is the exception: half a gigabyte it can actually use beats
    // a tidy figure it cannot, so the caller that has seen the evidence passes a
    // floor and the tolerance stands aside for it.
    const floor = options.atLeastMb ?? 0;
    const worthIt = floor > 0 ? target > wanted.currentMb : target > wanted.currentMb + TOLERANCE_MB;
    if (!worthIt) return null;
    await setEnvVars("application", context.applicationId, context.ownerId, [
        { key: MEMORY_KEY, value: formatMemory(target), isSecret: false }
    ]);
    return { fromMb: wanted.currentMb, toMb: target, reason: wanted.reason };
}

/**
 * Look at every planned server, and at the ones that have run out.
 *
 * Runs beside the crash-loop sweep, on the same minute, and is deliberately
 * lopsided: the plan is recomputed for every planned server (a handful of indexed
 * reads), while the log - the expensive part - is only read for a server that has
 * not been looked at for a quarter of an hour.
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
        checked += 1;

        const context: PlanContext = {
            installedAppId: install.id,
            applicationId,
            ownerId,
            name: install.name,
            config: install.config,
            targetId: install.targetId
        };

        // Has it actually run out? Only asked of a server that has not been asked
        // recently, because this is the one expensive read here.
        const watched = watchedAt(config);
        const due = watched === null || now.getTime() - watched >= WATCH_EVERY_MS;
        let exhausted = false;
        if (due) {
            const log = await readAppRuntimeLog(applicationId, ownerId, WATCH_TAIL).catch(() => "");
            exhausted = OUT_OF_MEMORY.test(log);
            await patchInstallConfig(install.id, {
                [MEMORY_WATCH_KEY]: now.toISOString()
            }).catch(() => undefined);
        }

        const current = await plannedMemoryFor(context, now);
        if (!current) continue;
        // A server that has run out needs more than it is running on, whatever the
        // plan says - the plan is an estimate and the crash is a fact.
        const floor = exhausted
            ? (plan.raisedHeapMb(current.currentMb, {
                  ceilingMb: plan.memoryCeilingMb(config[plan.MEMORY_CEILING_KEY]),
                  ...(await machineBounds(context, current.currentMb))
              }) ?? 0)
            : 0;
        const applied = await applyPlannedMemory(context, { atLeastMb: floor }, now).catch(
            () => null
        );
        if (!applied) continue;
        raised += 1;

        // Restarting is only ever the repair for a server that has already broken,
        // and only when it costs nobody their evening.
        const playing = await playersOnline(install.id, now);
        const repairNow = exhausted && playing === 0;
        if (repairNow) {
            const { deployApplication } = await import("@/lib/deploy-service");
            const done = await deployApplication(applicationId, ownerId, null)
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
                      repairNow
                          ? " It was restarted onto it, since nobody was playing."
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

/** When this server was last read for an out-of-memory, in milliseconds, or null
 *  for one that never has been. */
function watchedAt(config: Record<string, unknown>): number | null {
    const value = config[MEMORY_WATCH_KEY];
    if (typeof value !== "string") return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
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
