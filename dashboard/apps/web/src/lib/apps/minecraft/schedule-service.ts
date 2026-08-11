/**
 * Acting on a server's schedule.
 *
 * Split from `schedule.ts` because everything here reaches something - the
 * install's config row, the server's own player count, the deploy that starts and
 * stops it - and the screen that edits a schedule runs in the browser.
 *
 * Sweeping is deliberately not left to the cron alone. An instance with no cron
 * configured would have schedules that never fire, so the Game servers page sweeps
 * whenever it is read, exactly as scheduled deletions run lazily when a connection
 * is browsed. That makes the cron a guarantee of timeliness rather than a
 * requirement for the feature to work at all.
 */

import { prisma } from "@polaris/db";
import { getServerPlayers } from "./service";
import { getArkPlayers } from "@/lib/apps/ark/service";
import { gameOfServer } from "@/lib/apps/games-catalog";
import { flushGameWorld } from "@/lib/apps/games-flush";
import { setApplicationRunning } from "@/lib/deploy-service";
import { readSchedule, scheduleAction, type GameSchedule } from "./schedule";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";

/** Where the emptiness clock lives inside the install's config. */
const EMPTY_SINCE_KEY = "emptySince";

/** What one sweep did, so the caller can log it and the screen can say it. */
export interface ScheduleSweep {
    readonly started: number;
    readonly stopped: number;
}

/** The schedule on one server. */
export async function getGameSchedule(installedAppId: string): Promise<GameSchedule> {
    const row = await prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } });
    return readSchedule(readInstallConfig(row?.config));
}

/** Write one, merged into the rest of the install's settings. */
export async function setGameSchedule(installedAppId: string, schedule: GameSchedule): Promise<void> {
    await patchInstallConfig(installedAppId, { schedule });
}

/**
 * Apply every schedule this owner has, and report what moved.
 *
 * Best effort per server: one that cannot be reached keeps its schedule and is
 * swept again next time. A server whose schedule is off is not touched at all,
 * which is what makes this safe to run over every install on the instance.
 */
export async function sweepGameSchedules(
    ownerId: string,
    at: Date = new Date(),
    /** Player counts the caller has already paid for, by installed-app id. The
     *  Game servers page has just asked every server who is on; asking again for
     *  the sweep would double the slowest read on the page. */
    known?: ReadonlyMap<string, number>
): Promise<ScheduleSweep> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" }, applicationId: { not: null } },
        select: { id: true, applicationId: true, config: true, catalogId: true }
    });
    let started = 0;
    let stopped = 0;
    for (const install of installs) {
        const config = readInstallConfig(install.config);
        const schedule = readSchedule(config);
        if (!schedule.enabled) continue;
        const app = await prisma.application
            .findFirst({ where: { id: install.applicationId as string }, select: { desiredState: true } })
            .catch(() => null);
        if (!app) continue;
        const running = app.desiredState === "running";

        // Only a running server can be asked who is on it, and only a running
        // server's emptiness is worth timing.
        // "Nobody is playing" is the whole basis for stopping a server, so it is
        // asked in the language of the game it belongs to - ARK answers over
        // arkmanager and Minecraft over rcon-cli, and reading one with the other's
        // client is a server that looks empty and gets stopped underneath people.
        const playersOnline = !running ? 0 : (known?.get(install.id) ?? (await countOnline(ownerId, install)));
        const emptySince = await trackEmptiness(install.id, config, running, playersOnline, at);

        const action = scheduleAction(schedule, at, { running, playersOnline, emptySince });
        if (!action) continue;
        // A scheduled stop is the one nobody is watching, so it is the one where an
        // unwritten world would be noticed last: flush before it goes down.
        if (action !== "start") await flushGameWorld(ownerId, install.id);
        const applied = await setApplicationRunning(install.applicationId as string, ownerId, action === "start")
            .then(() => true)
            .catch(() => false);
        if (!applied) continue;
        if (action === "start") started += 1;
        else stopped += 1;
        // The clock restarts with the server: one that has just been started has
        // not been empty for an hour, whatever it was doing before.
        await patchInstallConfig(install.id, { [EMPTY_SINCE_KEY]: null }).catch(() => undefined);
    }
    return { started, stopped };
}

/** How many people are on one server, whatever game it runs. Nought when it
 *  cannot be asked - a server that is not answering is not one to stop, and the
 *  emptiness clock is what decides that. */
async function countOnline(ownerId: string, install: { id: string; catalogId: string }): Promise<number> {
    if (gameOfServer(install.catalogId)?.id === "ark") {
        const live = await getArkPlayers(ownerId, install.id).catch(() => null);
        return live?.answering ? live.players.length : 0;
    }
    return (await getServerPlayers(ownerId, install.id).catch(() => null))?.players.online ?? 0;
}

/**
 * Keep the clock that says how long a server has been empty, and hand back where
 * it stands.
 *
 * Recorded rather than derived: the log holds the joins and the leaves, but only
 * as far back as it reaches, and a server nobody has touched for a week is
 * precisely the one whose log no longer mentions anybody. Written only when it
 * changes, so a sweep over a busy server writes nothing.
 */
async function trackEmptiness(
    installedAppId: string,
    config: Record<string, unknown>,
    running: boolean,
    playersOnline: number,
    at: Date
): Promise<string | null> {
    const held = typeof config[EMPTY_SINCE_KEY] === "string" ? (config[EMPTY_SINCE_KEY] as string) : null;
    if (!running || playersOnline > 0) {
        if (held !== null) await patchInstallConfig(installedAppId, { [EMPTY_SINCE_KEY]: null }).catch(() => undefined);
        return null;
    }
    if (held !== null) return held;
    const now = at.toISOString();
    await patchInstallConfig(installedAppId, { [EMPTY_SINCE_KEY]: now }).catch(() => undefined);
    return now;
}
