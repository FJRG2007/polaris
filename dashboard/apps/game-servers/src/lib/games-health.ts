/**
 * Catching a game server that will never start, and stopping it.
 *
 * A container the deploy is told to keep up is one the engine restarts every time
 * it dies, which is the right answer for a server that crashed once and the wrong
 * one for a server that cannot start at all. The second case restarts forever: it
 * burns a core and a disk on nothing, and from the outside it looks exactly like a
 * first boot, because a first boot really does take minutes. That is what made it
 * survivable for so long - nobody could tell, so nobody looked.
 *
 * So this does the looking, once a minute, and then does the two things a person
 * would do. It stops the server, because a loop nobody is watching is waste and
 * because "stopped, and here is why" is an honest state where "starting" was not.
 * And it says so - to the notification feed rather than only to a log, since the
 * people this is for are the ones who have not set up alerting and would not know
 * to.
 *
 * Stopping is also what makes the notification arrive once. There is no cooldown
 * here and no record of what has already been said, because ending the loop is
 * what ends the reason to say it again.
 *
 * Only servers Polaris means to be running are looked at. One somebody stopped on
 * purpose is not failing at anything.
 */

import { gameMessage, gameMessageIn } from "./game-message";
import { gameCatalogs } from "../../messages";
import { ownerLocale } from "./owner-words";
import { prisma } from "@polaris/db";
import { isGameServerApp } from "./games-service";
import {
    crashLoopOf,
    isCrashLooping,
    loaderCrashOf,
    loaderInstallFailure,
    outlivedTheLoop,
    reachedReady,
    watchesRestarts,
    type CrashLoop,
    type RestartFacts,
    type RestartWatch
} from "./crash-loop";
import { host } from "@polaris/app-host";

const { createNotification } = host.notificationService;
const { recordAudit } = host.auditService;
const { readAppContainerRuntime } = host.appContainerMetrics;
const { readAppRuntimeLog, setApplicationRunning } = host.deployService;
const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

/**
 * The key an install records the loop it was stopped for under.
 *
 * Kept rather than derived, because the moment the server is stopped the evidence
 * goes with it: the container is not restarting any more, so nothing would be able
 * to say why it is off. This is what lets the server's own page explain itself
 * hours later.
 */
export const CRASH_LOOP_KEY = "crashLoop";

/**
 * The key the last suspicious reading is kept under.
 *
 * A verdict needs two readings a minute apart and this is the first one, held on the
 * install because the sweep that takes it has no memory of its own and the process
 * running it may not be the one that comes back. Written only for a container that
 * already looks like it is restarting, and cleared the moment it stops looking like
 * it - a healthy server never writes here at all.
 */
export const RESTART_WATCH_KEY = "restartWatch";

/** What was written down about a loop, for the screen that has to explain a
 *  server that is off. */
export interface CrashLoopRecord extends CrashLoop {
    /** When Polaris stopped it. */
    readonly at: string;
    /**
     * Whether the stop was Polaris's rather than the operator's.
     *
     * The stop goes through the same switch an operator's does, so the service is
     * then recorded as meant to be off - and nothing used to put it back. A server
     * that was repaired and brought up again stayed "stopped" in every screen, and
     * the pass that halts services which should be off halted it, healthy and with
     * people on it. This is what lets the stop be taken back once the reason for it
     * is gone. Absent on a record written before it existed, which only the guard
     * ever wrote, so absent reads as true.
     */
    readonly stoppedByPolaris: boolean;
}

/** Enough log to reach past a stack trace to the line above it. A crashed Java
 *  server prints thousands of frames, and the cause is under all of them. */
const CRASH_LOG_TAIL = 600;

export interface HealthSweep {
    readonly checked: number;
    readonly stopped: number;
    /** Servers Polaris had stopped for looping, found up and put back to running. */
    readonly resumed: number;
}

/**
 * Look at every game server that is meant to be up, and stop the ones that are
 * only pretending to start.
 *
 * Per owner, like every other sweep here, so one owner's unreachable machine
 * cannot hold up anybody else's. Every step is best effort: a container that
 * cannot be inspected is not evidence of anything, and the next pass is a minute
 * away.
 */
export async function sweepCrashLoops(
    ownerId: string,
    now: Date = new Date()
): Promise<HealthSweep> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, applicationId: { not: null } },
        select: { id: true, name: true, applicationId: true, catalogId: true, config: true }
    });

    let checked = 0;
    let stopped = 0;
    let resumed = 0;
    for (const install of installs) {
        const applicationId = install.applicationId;
        if (!applicationId || !isGameServerApp(install.catalogId)) continue;

        // A server somebody turned off is not failing to start. Asked of the
        // deploy rather than of the container, because the container being down is
        // the very thing in question.
        const app = await prisma.application
            .findFirst({ where: { id: applicationId }, select: { desiredState: true } })
            .catch(() => null);
        const halted = readCrashLoop(install.config);
        if (app?.desiredState !== "running") {
            // Except one Polaris turned off itself, for looping, that has since been
            // brought up some other way and is up: the stop is over, and leaving the
            // service recorded as off is what got a healthy server stopped again.
            // Only these are inspected, so a server that is simply off costs a query.
            if (app?.desiredState !== "stopped" || !halted?.stoppedByPolaris) continue;
            const down = await readAppContainerRuntime(applicationId, ownerId);
            if (down && (await cameUp(down, applicationId, ownerId, now))) {
                if (await resumeAfterCrashLoop(install.id, applicationId, "healthy")) resumed += 1;
            }
            continue;
        }

        const state = await readAppContainerRuntime(applicationId, ownerId);
        if (!state) continue;
        checked += 1;

        // Nothing to watch: forget whatever was being watched. This is the path a
        // server that recovered leaves by, and leaving the old count behind would
        // make its next restart look like the tail of the loop it got out of.
        const watching = readRestartWatch(install.config);
        if (!watchesRestarts(state, now)) {
            if (watching) await forget(install.id, RESTART_WATCH_KEY);
            // And the verdict itself, once the server has been up long enough to
            // have disproved it, or says it is up. Without this the record was
            // written once and never taken back: a server that was repaired,
            // started and ran for hours still carried it, and the moment its owner
            // stopped it on purpose its page said it keeps failing to start and
            // quoted a crash from that morning. Only ever while the container is
            // up - see `outlivedTheLoop`, which is where the reasoning lives.
            if (halted && (await cameUp(state, applicationId, ownerId, now))) {
                await forget(install.id, CRASH_LOOP_KEY);
            }
            continue;
        }
        // First sighting. Half the evidence, so it is recorded rather than acted
        // on - unless the log already says why, in a way waiting cannot change: a
        // server that could not download its own software fails the same way on
        // every run, seconds apart, and another minute of that is a minute of
        // asking somebody's repository the same question for nothing.
        let log: string | null = null;
        if (!watching) {
            log = await readAppRuntimeLog(applicationId, ownerId, CRASH_LOG_TAIL).catch(() => "");
            if (!loaderInstallFailure(log) || reachedReady(log)) {
                await patchInstallConfig(install.id, {
                    [RESTART_WATCH_KEY]: {
                        restartCount: state.restartCount,
                        at: now.toISOString()
                    } satisfies RestartWatch
                }).catch(() => undefined);
                continue;
            }
        } else if (!isCrashLooping(state, watching, now)) {
            continue;
        }

        // Read once, and only for a server already judged to be looping - this is
        // ten times the tail an ordinary status read pays for.
        log ??= await readAppRuntimeLog(applicationId, ownerId, CRASH_LOG_TAIL).catch(() => "");

        // The counters and the log disagree, and the log wins: it is the server's
        // own account of the run it is on, where a restart count is a number about
        // runs that are over. A server that says it is up does not get stopped for
        // failing to start.
        if (reachedReady(log)) {
            await forget(install.id, RESTART_WATCH_KEY);
            continue;
        }
        let loop = crashLoopOf(state, log);

        // Written before the stop, so the reason is already on record if the stop
        // is the thing that fails.
        await record(install.id, loop, now);

        const halting = await setApplicationRunning(applicationId, ownerId, false)
            .then(() => true)
            .catch(() => false);
        if (!halting) continue;
        stopped += 1;
        // The loop is over, so the readings taken of it are no longer evidence of
        // anything: whatever happens next has to prove itself from scratch.
        await forget(install.id, RESTART_WATCH_KEY);

        // A server that could not download its loader has a runnable one on disk.
        // Held now, with the container down and its files still readable, so
        // pressing Start runs what is installed instead of asking the repository
        // that just failed - and the record says so.
        const loader = loaderCrashOf(loop.cause);
        if (loader) {
            const { pinInstalledLoader } = await import("./minecraft/loader-pin-service");
            const pinned = await pinInstalledLoader(ownerId, install.id, now).catch(() => null);
            // Only a version read off the disk just now is one this can promise runs
            // offline; a version somebody set before is theirs, and is left to say so.
            if (pinned?.state === "pinned") {
                loop = {
                    ...loop,
                    advice: gameMessage(
                        "games",
                        loader.unreadable
                            ? "lib.crash.loaderUnreadablePinned"
                            : "lib.crash.loaderUnreachablePinned",
                        { loader: pinned.loader, version: pinned.version }
                    )
                };
                await record(install.id, loop, now);
            }
        }

        const locale = await ownerLocale(ownerId);
        const t = gameCatalogs.translator(locale, "games");
        await createNotification({
            userId: ownerId,
            type: "games.crash-loop",
            title: t("notify.crashLoopTitle", { name: install.name }),
            body: loop.cause
                ? `${loop.cause}${loop.advice ? ` ${gameMessageIn(locale, loop.advice)}` : ""}`
                : t("notify.crashLoopBody", { count: loop.restarts }),
            href: `/apps/installed/${install.id}`,
            level: "warning",
            actionRequired: true
        });
    }
    return { checked, stopped, resumed };
}

/** Write down the loop a server is being stopped for. */
async function record(installedAppId: string, loop: CrashLoop, now: Date): Promise<void> {
    await patchInstallConfig(installedAppId, {
        [CRASH_LOOP_KEY]: {
            ...loop,
            at: now.toISOString(),
            stoppedByPolaris: true
        } satisfies CrashLoopRecord
    }).catch(() => undefined);
}

/** Drop a key from an install's config, best effort like everything else here. */
async function forget(installedAppId: string, key: string): Promise<void> {
    await patchInstallConfig(installedAppId, { [key]: null }).catch(() => undefined);
}

/** The last suspicious reading taken of this server, if one was. */
export function readRestartWatch(config: string | null): RestartWatch | null {
    const value = readInstallConfig(config)[RESTART_WATCH_KEY];
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.restartCount !== "number") return null;
    return {
        restartCount: record.restartCount,
        at: typeof record.at === "string" ? record.at : ""
    };
}

/** What was recorded about the loop this server was stopped for, if it was. */
export function readCrashLoop(config: string | null): CrashLoopRecord | null {
    const value = readInstallConfig(config)[CRASH_LOOP_KEY];
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    return {
        restarts: typeof record.restarts === "number" ? record.restarts : 0,
        cause: typeof record.cause === "string" ? record.cause : null,
        advice: typeof record.advice === "string" ? record.advice : null,
        at: typeof record.at === "string" ? record.at : "",
        stoppedByPolaris: record.stoppedByPolaris !== false
    };
}

/** How much log decides whether a server that was stopped for looping is now up. */
const READY_TAIL = 200;

/**
 * Whether a container is up and has got somewhere: running, not between two
 * restarts, and either past the point a loop could hide (`outlivedTheLoop`) or
 * saying so itself with its ready line. The second is what lets a server that
 * was just recreated healthy be believed within one pass rather than after two
 * minutes of being called stopped.
 */
async function cameUp(
    state: RestartFacts,
    applicationId: string,
    ownerId: string,
    now: Date
): Promise<boolean> {
    if (state.status !== "running" || state.restarting === true) return false;
    if (outlivedTheLoop(state, now)) return true;
    const log = await readAppRuntimeLog(applicationId, ownerId, READY_TAIL).catch(() => "");
    return reachedReady(log);
}

/**
 * The loop Polaris stopped this server for is over: forget it, and put the
 * service back to running if the stop was Polaris's.
 *
 * Only ever from "stopped" to "running", and only for a stop the guard made: an
 * operator who stopped the server on purpose keeps it stopped. Recorded in the
 * audit log with nobody as the actor, because nobody pressed anything.
 */
export async function resumeAfterCrashLoop(
    installedAppId: string,
    applicationId: string,
    why: "healthy" | "answering" | "running"
): Promise<boolean> {
    const install = await prisma.installedApp
        .findFirst({ where: { id: installedAppId }, select: { config: true } })
        .catch(() => null);
    const record = readCrashLoop(install?.config ?? null);
    if (!record) return false;
    await forget(installedAppId, CRASH_LOOP_KEY);
    await forget(installedAppId, RESTART_WATCH_KEY);
    if (!record.stoppedByPolaris) return false;
    const resumed = await prisma.application
        .updateMany({
            where: { id: applicationId, desiredState: "stopped" },
            data: { desiredState: "running" }
        })
        .then((result) => result.count > 0)
        .catch(() => false);
    if (resumed) {
        await recordAudit({
            actorId: null,
            action: "games.crash-loop-resumed",
            targetType: "installedApp",
            targetId: installedAppId,
            metadata: { why, stoppedAt: record.at }
        }).catch(() => undefined);
    }
    return resumed;
}

/**
 * Whether a container found running under a service recorded as stopped is one
 * Polaris stopped for looping and somebody has since brought up - in which case
 * it is taken as running rather than stopped again. For the pass that halts what
 * should be off, which would otherwise undo the repair.
 */
export async function adoptsRunningService(ownerId: string, applicationId: string): Promise<boolean> {
    const install = await prisma.installedApp
        .findFirst({
            where: { ownerId, applicationId, status: { not: "removed" } },
            select: { id: true, catalogId: true, config: true }
        })
        .catch(() => null);
    if (!install || !isGameServerApp(install.catalogId)) return false;
    if (!readCrashLoop(install.config)?.stoppedByPolaris) return false;
    return resumeAfterCrashLoop(install.id, applicationId, "running");
}

/**
 * Forget the loop, because somebody has started the server again.
 *
 * Cleared on the way in rather than when the server next reaches the point of
 * answering: a banner about the last crash on a server that is currently booting
 * is the same lie in the other direction, and if it crashes again the next sweep
 * writes it back within the minute.
 */
export async function clearCrashLoop(installedAppId: string): Promise<void> {
    await patchInstallConfig(installedAppId, { [CRASH_LOOP_KEY]: null }).catch(() => undefined);
}
