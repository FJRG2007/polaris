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

import { prisma } from "@polaris/db";
import { isGameServerApp } from "@/lib/apps/games-service";
import { createNotification } from "@/lib/notification-service";
import { readAppContainerRuntime } from "@/lib/app-container-metrics";
import { readAppRuntimeLog, setApplicationRunning } from "@/lib/deploy-service";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { crashLoopOf, isCrashLooping, type CrashLoop } from "@/lib/apps/crash-loop";

/**
 * The key an install records the loop it was stopped for under.
 *
 * Kept rather than derived, because the moment the server is stopped the evidence
 * goes with it: the container is not restarting any more, so nothing would be able
 * to say why it is off. This is what lets the server's own page explain itself
 * hours later.
 */
export const CRASH_LOOP_KEY = "crashLoop";

/** What was written down about a loop, for the screen that has to explain a
 *  server that is off. */
export interface CrashLoopRecord extends CrashLoop {
    /** When Polaris stopped it. */
    readonly at: string;
}

/** Enough log to reach past a stack trace to the line above it. A crashed Java
 *  server prints thousands of frames, and the cause is under all of them. */
const CRASH_LOG_TAIL = 600;

export interface HealthSweep {
    readonly checked: number;
    readonly stopped: number;
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
export async function sweepCrashLoops(ownerId: string, now: Date = new Date()): Promise<HealthSweep> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, applicationId: { not: null } },
        select: { id: true, name: true, applicationId: true, catalogId: true, config: true }
    });

    let checked = 0;
    let stopped = 0;
    for (const install of installs) {
        const applicationId = install.applicationId;
        if (!applicationId || !isGameServerApp(install.catalogId)) continue;

        // A server somebody turned off is not failing to start. Asked of the
        // deploy rather than of the container, because the container being down is
        // the very thing in question.
        const app = await prisma.application
            .findFirst({ where: { id: applicationId }, select: { desiredState: true } })
            .catch(() => null);
        if (app?.desiredState !== "running") continue;

        const state = await readAppContainerRuntime(applicationId, ownerId);
        if (!state) continue;
        checked += 1;
        if (!isCrashLooping(state, now)) continue;

        // Read once, and only for a server already judged to be looping - this is
        // ten times the tail an ordinary status read pays for.
        const log = await readAppRuntimeLog(applicationId, ownerId, CRASH_LOG_TAIL).catch(() => "");
        const loop = crashLoopOf(state, log);

        // Written before the stop, so the reason is already on record if the stop
        // is the thing that fails.
        await patchInstallConfig(install.id, {
            [CRASH_LOOP_KEY]: { ...loop, at: now.toISOString() } satisfies CrashLoopRecord
        }).catch(() => undefined);

        const halted = await setApplicationRunning(applicationId, ownerId, false)
            .then(() => true)
            .catch(() => false);
        if (!halted) continue;
        stopped += 1;

        await createNotification({
            userId: ownerId,
            type: "games.crash-loop",
            title: `${install.name} keeps failing to start`,
            body: loop.cause
                ? `${loop.cause}${loop.advice ? ` ${loop.advice}` : ""}`
                : `It restarted ${loop.restarts} times without starting, so it has been stopped.`,
            href: `/apps/installed/${install.id}`,
            level: "warning",
            actionRequired: true
        });
    }
    return { checked, stopped };
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
        at: typeof record.at === "string" ? record.at : ""
    };
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
