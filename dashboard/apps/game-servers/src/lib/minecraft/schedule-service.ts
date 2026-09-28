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
import { type GameId, gameOfServer, withTimeout } from "@polaris/core";
import { createWorldBackup } from "./world-service";
import { runArkCommand } from "../ark/service";
import { getArkPlayers } from "../ark/service";
import { broadcastToFivem, getFivemPlayers, runFivemCommand } from "../fivem/service";
import { flushGameWorld } from "../games-flush";
import { broadcastToMinecraft, getServerPlayers, runConsoleLine } from "./service";
import { readPendingRestart } from "../games-restart";
import { runDueRestart } from "../games-restart-service";
import { gameServerCatalogIds } from "../game-catalog";
import {
    CHECKED_AT_KEY,
    EMPTY_SINCE_KEY,
    ROUTINE_RUNS_KEY,
    readRoutineRuns,
    readSchedule,
    routinesDue,
    scheduleAction,
    type GameSchedule,
    type ScheduledRoutine
} from "./schedule";
import { host } from "@polaris/app-host";

const { setApplicationRunning } = host.deployService;
const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

/**
 * How long a server gets to say who is on it before the sweep stops waiting.
 *
 * Asking costs a command inside the container, and a container that has wedged -
 * a stale SSH channel, a daemon that stopped answering - does not refuse it, it
 * simply never replies. Without a bound here that one server holds the whole
 * pass open, and since the runner will not start a pass while the last one is
 * still going, every schedule on the instance stops firing until the process is
 * restarted. That is what "I set a schedule and nothing ever happened" looks
 * like from the outside.
 */
const COUNT_TIMEOUT_MS = 15_000;

/** How often the note saying a sweep ran is worth rewriting. Well under the
 *  minute the cron runs on, so a schedule that is being followed always says so. */
const CHECK_NOTE_EVERY_MS = 30_000;

/**
 * How often a screen somebody is watching may sweep.
 *
 * The screens sweep so that an instance with no cron still has schedules that
 * fire, and they are read every few seconds - the presence watcher every three.
 * Nothing a sweep does needs that: a window opens or closes on the minute, the
 * cron itself runs once a minute, and the check note above is only rewritten
 * every thirty seconds. So a watched screen sweeps at that rate and no faster;
 * the cron is not throttled and neither is a caller that asks directly.
 */
const WATCHED_SWEEP_EVERY_MS = 30_000;

/** When each audience last swept, by owner and the servers it was narrowed to. */
const watchedSweeps = new Map<string, number>();

/** Whether the note is old enough to be worth writing again. */
function staleCheck(config: Record<string, unknown>, at: Date): boolean {
    const held =
        typeof config[CHECKED_AT_KEY] === "string"
            ? Date.parse(config[CHECKED_AT_KEY] as string)
            : Number.NaN;
    return Number.isNaN(held) || at.getTime() - held >= CHECK_NOTE_EVERY_MS;
}

/** What one sweep did, so the caller can log it and the screen can say it. */
export interface ScheduleSweep {
    readonly started: number;
    readonly stopped: number;
    /** Servers put through a restart somebody booked for later - when the last
     *  person left, or at a time they picked. */
    readonly restarted: number;
}

/** Narrowings the callers that already know something can hand in. */
export interface SweepOptions {
    /**
     * Player counts the caller has already paid for, by installed-app id. The
     * Game servers page has just asked every server who is on; asking again for
     * the sweep would double the slowest read on the page.
     *
     * Null for a server the caller asked and could not tell - which is not nought.
     * An entry either way means the server is not asked again here, so a caller
     * that has already had silence from it does not pay for that silence twice.
     */
    readonly known?: ReadonlyMap<string, number | null>;
    /** Sweep these installs rather than everything the owner has, for a server's
     *  own page - which polls anyway, and is the screen somebody is watching when
     *  they wonder why their schedule has not fired. Everything the caller left
     *  out is left alone, so a screen about one server does not reach into every
     *  other one to decide whether it is empty. */
    readonly only?: string | readonly string[];
}

/** The schedule on one server. */
export async function getGameSchedule(installedAppId: string): Promise<GameSchedule> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true }
    });
    return readSchedule(readInstallConfig(row?.config));
}

/** Write one, merged into the rest of the install's settings. */
export async function setGameSchedule(
    installedAppId: string,
    schedule: GameSchedule
): Promise<void> {
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
    options: SweepOptions = {}
): Promise<ScheduleSweep> {
    const { known, only } = options;
    // Game servers only: a schedule and a booked restart are both theirs, and any
    // other app's config is a row read to be thrown away.
    const installs = await prisma.installedApp.findMany({
        where: {
            ownerId,
            status: { not: "removed" },
            applicationId: { not: null },
            catalogId: { in: gameServerCatalogIds() },
            ...(only ? { id: typeof only === "string" ? only : { in: [...only] } } : {})
        },
        select: { id: true, applicationId: true, config: true, catalogId: true }
    });
    // What each one has to do is decided from its own config, so the ones with
    // nothing to do are dropped before anything else is read, and the rest have
    // their applications read in one query rather than one each.
    const pending = installs
        .map((install) => {
            const config = readInstallConfig(install.config);
            // A restart somebody booked for later rides on this walk. It is not
            // part of the schedule and does not need one: a server with no
            // schedule at all still has settings that only take effect when it
            // comes back, and this is the pass that notices the last player has
            // left.
            return {
                install,
                config,
                schedule: readSchedule(config),
                waiting: readPendingRestart(config)
            };
        })
        .filter((entry) => entry.schedule.enabled || entry.waiting);
    const desired =
        pending.length === 0
            ? new Map<string, string>()
            : await prisma.application
                  .findMany({
                      where: {
                          id: { in: pending.map((entry) => entry.install.applicationId as string) }
                      },
                      select: { id: true, desiredState: true }
                  })
                  .then((apps) => new Map(apps.map((app) => [app.id, app.desiredState])))
                  .catch(() => new Map<string, string>());
    let started = 0;
    let stopped = 0;
    let restarted = 0;
    for (const { install, config, schedule, waiting } of pending) {
        const desiredState = desired.get(install.applicationId as string);
        if (desiredState === undefined) continue;
        const app = { desiredState };
        const running = app.desiredState === "running";

        // Only a running server can be asked who is on it, and only a running
        // server's emptiness is worth timing.
        // "Nobody is playing" is the whole basis for stopping a server, so it is
        // asked in the language of the game it belongs to - ARK answers over
        // arkmanager and Minecraft over rcon-cli, and reading one with the other's
        // client is a server that looks empty and gets stopped underneath people.
        const playersOnline = !running
            ? 0
            : known?.has(install.id)
              ? (known.get(install.id) ?? null)
              : await countOnline(ownerId, install);
        const emptySince = await trackEmptiness(install.id, config, running, playersOnline, at);

        // Only against a server that is up: a stopped one applies whatever is
        // waiting the next time somebody starts it, and starting it for them is not
        // what "restart when nobody is playing" asked for.
        if (waiting && running && (await runDueRestart(ownerId, install.id, playersOnline))) {
            restarted += 1;
            // Nothing else this pass. The server is on its way down and back, and a
            // schedule that also fired would be acting on a state that no longer
            // exists by the time it lands.
            continue;
        }
        if (!schedule.enabled) continue;
        // Written whether or not anything is due, because "the sweep reached this
        // server" is exactly what somebody whose schedule appears to do nothing
        // cannot otherwise find out. Not on every pass though: a server's own page
        // sweeps on its poll, and a row rewritten every five seconds to say the
        // same thing is a write nobody reads.
        if (staleCheck(config, at)) {
            await patchInstallConfig(install.id, { [CHECKED_AT_KEY]: at.toISOString() }).catch(
                () => undefined
            );
        }

        const action = scheduleAction(schedule, at, { running, playersOnline, emptySince });
        if (!action) continue;
        // A scheduled stop is the one nobody is watching, so it is the one where an
        // unwritten world would be noticed last: flush before it goes down.
        if (action !== "start") await flushGameWorld(ownerId, install.id);
        const applied = await setApplicationRunning(
            install.applicationId as string,
            ownerId,
            action === "start"
        )
            .then(() => true)
            .catch(() => false);
        if (!applied) continue;
        if (action === "start") started += 1;
        else stopped += 1;
        // The clock restarts with the server: one that has just been started has
        // not been empty for an hour, whatever it was doing before.
        await patchInstallConfig(install.id, { [EMPTY_SINCE_KEY]: null }).catch(() => undefined);
    }
    return { started, stopped, restarted };
}

/**
 * The sweep a screen runs while somebody is watching it, at most once every
 * `WATCHED_SWEEP_EVERY_MS` for the same owner and servers. Null when it was not
 * this caller's turn.
 */
export async function sweepWatchedGameSchedules(
    ownerId: string,
    options: SweepOptions = {}
): Promise<ScheduleSweep | null> {
    const now = Date.now();
    const only = options.only;
    const key = `${ownerId}|${only === undefined ? "*" : typeof only === "string" ? only : [...only].sort().join(",")}`;
    const last = watchedSweeps.get(key);
    if (last !== undefined && now - last < WATCHED_SWEEP_EVERY_MS) return null;
    // Taken before the sweep rather than after it, so two screens arriving at
    // once do not both sweep.
    watchedSweeps.set(key, now);
    for (const [held, at] of watchedSweeps) {
        if (now - at >= WATCHED_SWEEP_EVERY_MS && held !== key) watchedSweeps.delete(held);
    }
    return sweepGameSchedules(ownerId, new Date(now), options);
}

/**
 * How many people are on one server, whatever game it runs.
 *
 * Null when it could not be asked - a server that is not answering is not one to
 * stop. Nought and null were the same value here once, which meant a server that
 * had gone quiet because it was busy unpacking its first install read as empty and
 * was stopped in the middle of it.
 *
 * Bounded, because the failure that matters is not an error: a container that has
 * wedged never answers at all, and an unbounded wait there is a sweep that never
 * finishes and a schedule that never fires again.
 */
async function countOnline(
    ownerId: string,
    install: { id: string; catalogId: string }
): Promise<number | null> {
    const game = gameOfServer(install.catalogId)?.id;
    const ask =
        game === "ark"
            ? getArkPlayers(ownerId, install.id).then((live) =>
                  live.answering ? live.players.length : null
              )
            : game === "fivem"
              ? getFivemPlayers(ownerId, install.id).then((live) =>
                    live.answering ? live.players.length : null
                )
              : getServerPlayers(ownerId, install.id).then((live) =>
                    live.answering ? live.players.online : null
                );
    return withTimeout(ask, COUNT_TIMEOUT_MS, "the server did not say who was on it").catch(
        () => null
    );
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
    playersOnline: number | null,
    at: Date
): Promise<string | null> {
    const held =
        typeof config[EMPTY_SINCE_KEY] === "string" ? (config[EMPTY_SINCE_KEY] as string) : null;
    // A server that could not be asked changes nothing: the clock it had is kept,
    // so a minute of silence in the middle of an empty evening does not restart
    // the count, and a server that has never answered never starts one.
    if (playersOnline === null) return held;
    if (!running || playersOnline > 0) {
        if (held !== null)
            await patchInstallConfig(installedAppId, { [EMPTY_SINCE_KEY]: null }).catch(
                () => undefined
            );
        return null;
    }
    if (held !== null) return held;
    const now = at.toISOString();
    await patchInstallConfig(installedAppId, { [EMPTY_SINCE_KEY]: now }).catch(() => undefined);
    return now;
}

/**
 * Run the errands whose moment has arrived.
 *
 * Separate from the windows above because it is a different question. A window
 * decides whether the server should be up; a routine is a thing to do while it is -
 * restart it before anybody is on, warn everyone, take a backup, run the command
 * that resets the arena.
 *
 * Each routine's actions run in order and stop at the first failure, because the
 * order is the point: a restart that happens whether or not the warning went out is
 * not the sequence anybody wrote. What happened is recorded against the routine,
 * which is the difference between a schedule that works and one that quietly does
 * nothing at four in the morning with nobody watching.
 */
export async function runGameRoutines(
    ownerId: string,
    installedAppId: string,
    now: Date = new Date()
): Promise<number> {
    const install = await prisma.installedApp
        .findFirst({
            where: { id: installedAppId, ownerId, status: { not: "removed" } },
            select: { config: true, catalogId: true }
        })
        .catch(() => null);
    if (!install) return 0;

    const config = readInstallConfig(install.config);
    const due = routinesDue(readSchedule(config), now, readRoutineRuns(config));
    if (due.length === 0) return 0;

    const game = gameOfServer(install.catalogId)?.id ?? null;
    let ran = 0;
    for (const routine of due) {
        const outcome = await runRoutine(ownerId, installedAppId, routine, game);
        // Written whether it worked or not, and written first: a routine whose last
        // step killed the process still has to be recorded as having started, or
        // the next sweep runs the whole thing again.
        await patchInstallConfig(installedAppId, {
            [ROUTINE_RUNS_KEY]: {
                ...readRoutineRuns(readInstallConfig(install.config)),
                [routine.id]: { at: now.toISOString(), ok: outcome === null, detail: outcome ?? "" }
            }
        }).catch(() => undefined);
        ran += 1;
    }
    return ran;
}

/** Every action in order, stopping at the first that fails. Returns why it
 *  stopped, or null when it all went through. */
async function runRoutine(
    ownerId: string,
    installedAppId: string,
    routine: ScheduledRoutine,
    game: GameId | null
): Promise<string | null> {
    for (const action of routine.actions) {
        try {
            switch (action.kind) {
                case "broadcast":
                    // Each game says it its own way, and saying it the other way is
                    // a message nobody in the game ever sees.
                    if (game === "ark")
                        await runArkCommand(ownerId, installedAppId, `Broadcast ${action.value}`);
                    else if (game === "fivem")
                        await broadcastToFivem(ownerId, installedAppId, action.value);
                    else await broadcastToMinecraft(ownerId, installedAppId, action.value);
                    break;
                case "command":
                    if (game === "ark") await runArkCommand(ownerId, installedAppId, action.value);
                    else if (game === "fivem")
                        await runFivemCommand(ownerId, installedAppId, action.value);
                    else await runConsoleLine(ownerId, installedAppId, action.value);
                    break;
                case "backup":
                    // Only Minecraft has backups in Polaris, so for the others this
                    // is a step that would silently do nothing - said out loud
                    // instead.
                    if (game !== "minecraft") return "This server has no backups to take";
                    await createWorldBackup(ownerId, installedAppId);
                    break;
                case "restart":
                    // Flushed first, exactly as a scheduled stop is: a restart that
                    // drops the last few minutes of a world is a restart nobody
                    // asked for.
                    await flushGameWorld(ownerId, installedAppId).catch(() => undefined);
                    await setApplicationRunning(
                        await applicationOf(ownerId, installedAppId),
                        ownerId,
                        false
                    );
                    await setApplicationRunning(
                        await applicationOf(ownerId, installedAppId),
                        ownerId,
                        true
                    );
                    break;
            }
        } catch (caught) {
            return caught instanceof Error ? caught.message : "That step did not work";
        }
    }
    return null;
}

/** The deploy behind an install, which the restart action needs and nothing else
 *  in this file did. */
async function applicationOf(ownerId: string, installedAppId: string): Promise<string> {
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, ownerId },
        select: { applicationId: true }
    });
    if (!install?.applicationId) throw new Error("This server has not been deployed yet");
    return install.applicationId;
}
