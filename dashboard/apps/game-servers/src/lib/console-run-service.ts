/**
 * Running a kept command that carries variables, now or on its schedule.
 *
 * The values somebody typed are already checked (`console-vars`); what is done
 * here is everything that needs the server: who is on, the server's own values,
 * the account each player is tied to. Then each line goes through the console's
 * own path (`runConsoleCommand`), with its permission already checked by the
 * caller and its audit line written per command, exactly as a typed one is.
 *
 * The scheduled half is driven by the minute sweep in `games-jobs`, once per
 * server it knows about, with whether that server answered: a server that did
 * not is skipped and the skip is written down, never queued.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { gameOfServer } from "@polaris/core";
import { gameMessage } from "./game-message";
import { isSequence } from "./console-commands";
import { liveContext } from "./minecraft/live-values";
import { runConsoleCommand } from "./games-operations";
import { pause } from "./console-repeat-jobs";
import { isRefusedReply } from "./minecraft/console-reply";
import { readPlayerValues } from "./minecraft/player-read";
import { playerSelector } from "./minecraft/announcement";
import { DEATH_PLACE_VARIABLES, variablesIn } from "./minecraft/text-vars";
import {
    editionOf,
    shownPlayers,
    withServerContainer,
    type ServerContainer
} from "./minecraft/service";
import { MAX_CONSOLE_LINE, parseQueue, type QueueStep } from "./console-queue";
import {
    commandLines,
    commandUses,
    commandVariables,
    MAX_PLAYER_LINES,
    POSITION_READS,
    playerReadsIn,
    usesRelative,
    type CustomVariable,
    type RunTarget
} from "./console-vars";
import {
    CONSOLE_SCHEDULES_KEY,
    advance,
    readConsoleSchedules,
    scheduledWaitProblem,
    type ConsoleSchedule,
    type ScheduleRun
} from "./console-schedule";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

/** What one run is made of, every value already checked. */
export interface KeptRun {
    readonly command: string;
    readonly variables: readonly CustomVariable[];
    readonly values: Readonly<Record<string, string>>;
    readonly target: RunTarget | null;
}

/** The server a run goes to, as the console path needs it. */
export interface RunServer {
    readonly ownerId: string;
    readonly install: {
        readonly id: string;
        readonly catalogId: string;
        readonly applicationId: string | null;
    };
}

/** The Minecraft edition a server runs, or null for every other game. */
export function editionFor(server: RunServer) {
    return gameOfServer(server.install.catalogId)?.id === "minecraft"
        ? editionOf(server.install.catalogId)
        : null;
}

/** What keeps a run from being sent at all, as a carried message, or null: a
 *  per-player command with nobody chosen to write it for. */
export function keptRunProblem(server: RunServer, run: KeptRun): string | null {
    const uses = commandUses(run.command, editionFor(server), run.variables);
    // A `~` counts from where somebody stands, so a command that names nobody
    // has nobody to count from - never the spot the console happens to be at.
    if (
        !uses.perPlayer &&
        usesRelative(commandVariables(run.command, run.variables).custom, run.values)
    ) {
        return gameMessage("games", "consoleVars.errors.relativeNeedsPlayer");
    }
    return uses.perPlayer && !run.target
        ? gameMessage("games", "consoleVars.errors.whichPlayer")
        : null;
}

/**
 * The steps one run takes, with every variable filled in: a single command is
 * one step, or one per player when it is written per player; a sequence is its
 * steps in order, each command filled the same way and each pause kept.
 *
 * A sequence is read as one text for its variables, so `{x=100}` on its first
 * line is asked once and fills `{x}` on every line after it. Throws a carried
 * message when there is nobody to write a per-player line for.
 */
export async function keptCommandSteps(server: RunServer, run: KeptRun): Promise<QueueStep[]> {
    const edition = editionFor(server);
    const read = commandVariables(run.command, run.variables);
    const uses = commandUses(run.command, edition, run.variables);
    const parsed = isSequence(read.command)
        ? parseQueue(read.command, MAX_CONSOLE_LINE)
        : { steps: [{ kind: "command", line: read.command } as const], problem: null };
    if (parsed.problem) throw new Error(parsed.problem);
    const steps: readonly QueueStep[] = parsed.steps;
    const fill = { edition, custom: read.custom, values: run.values, server: {} };
    const each = (fillWith: typeof fill, players: Parameters<typeof commandLines>[2]) =>
        steps.flatMap((step): QueueStep[] =>
            step.kind === "wait"
                ? [step]
                : commandLines(step.line, fillWith, players).map((line) => ({
                      kind: "command",
                      line
                  }))
        );
    const problem = keptRunProblem(server, run);
    if (problem) throw new Error(problem);
    if (!uses.catalogue) return each(fill, []);

    const players = await shownPlayers(server.ownerId, server.install.id).catch(() => null);
    // Where somebody stands, or where the last death was, is the game's to say:
    // asked right before the lines are written, so they are where it is now.
    const relative = usesRelative(read.custom, run.values);
    const reads = [
        ...new Set([...playerReadsIn(read.command, edition), ...(relative ? POSITION_READS : [])])
    ];
    const deathPlace = variablesIn(read.command).some((use) =>
        DEATH_PLACE_VARIABLES.includes(use.spec?.name ?? "")
    );
    const withGame = <T>(work: (game: ServerContainer | null) => Promise<T>): Promise<T> =>
        reads.length > 0 || deathPlace
            ? withServerContainer(server.ownerId, server.install.id, work)
            : work(null);
    return withGame(async (game) => {
        const context = await liveContext(server.install.id, [run.command], players, game);
        const filled = { ...fill, server: context.values };
        if (!uses.perPlayer) return each(filled, []);

        const accounts = new Map(
            (context.recipients ?? []).map((recipient) => [
                recipient.name.toLowerCase(),
                recipient
            ])
        );
        const names =
            run.target && "player" in run.target
                ? [run.target.player]
                : [...(players?.players ?? [])];
        if (names.length === 0) {
            throw new Error(gameMessage("games", "consoleVars.errors.nobodyOn"));
        }
        // Only for the players a line is written for (`commandLines`).
        const asked = names
            .filter((name) => playerSelector(name) !== null)
            .slice(0, MAX_PLAYER_LINES);
        const answers =
            game && reads.length > 0 ? await readPlayerValues(game, asked, reads) : null;
        return each(
            filled,
            names.map((name) => ({
                name,
                values: {
                    ...accounts.get(name.toLowerCase())?.values,
                    ...answers?.get(name.toLowerCase())
                }
            }))
        );
    });
}

/** The lines one run sends, with every variable filled in. Throws a carried
 *  message for a run that pauses: a pause runs from the console, where it can
 *  be watched and stopped, or in the background for a schedule (`fire`) -
 *  never inside a request. */
export async function keptCommandLines(server: RunServer, run: KeptRun): Promise<string[]> {
    const steps = await keptCommandSteps(server, run);
    if (steps.some((step) => step.kind === "wait")) {
        throw new Error(gameMessage("games", "lib.pausesOnlyLive"));
    }
    return steps.flatMap((step) => (step.kind === "command" ? [step.line] : []));
}

/** Send every line of a run and answer what the server said to each. A line the
 *  server refuses is reported and the rest still go, as in "Run several". */
export async function runKeptCommand(
    actorId: string,
    server: RunServer,
    run: KeptRun
): Promise<KeptReply[]> {
    const lines = await keptCommandLines(server, run);
    return sendSteps(
        actorId,
        server,
        lines.map((line) => ({ kind: "command", line }))
    );
}

/** What the server said to one line, and whether that was a refusal. */
export interface KeptReply {
    readonly line: string;
    readonly output: string;
    readonly failed: boolean;
}

/**
 * Send a run's steps in order, holding each pause, and answer what the server
 * said to every line. A line counts as failed when it never reached the game or
 * when the game answered that it did not run it (`isRefusedReply`) - a refusal
 * comes back as text, not as an error.
 */
async function sendSteps(
    actorId: string,
    server: RunServer,
    steps: readonly QueueStep[]
): Promise<KeptReply[]> {
    const edition = editionFor(server);
    const replies: KeptReply[] = [];
    for (const step of steps) {
        if (step.kind === "wait") {
            await pause(step.ms, () => false);
            continue;
        }
        const line = step.line;
        try {
            const output = await runConsoleCommand({ id: actorId }, server, line);
            replies.push({ line, output, failed: isRefusedReply(edition, output) });
        } catch (caught) {
            replies.push({
                line,
                output:
                    caught instanceof Error
                        ? caught.message
                        : gameMessage("games", "lib.stepFailed"),
                failed: true
            });
        }
    }
    return replies;
}

/**
 * Fire this server's scheduled commands that are due.
 *
 * `answering` is what the activity sweep found a moment ago: a server that did
 * not answer has every due moment skipped. The list is read again just before
 * it is written, and only the schedules this pass moved are replaced in it, so a
 * schedule somebody stopped or added while a command ran is not undone.
 */
export async function runConsoleSchedules(
    ownerId: string,
    installedAppId: string,
    answering: boolean,
    now: Date = new Date()
): Promise<number> {
    const install = await prisma.installedApp
        .findFirst({
            where: { id: installedAppId, ownerId, status: { not: "removed" } },
            select: { id: true, catalogId: true, applicationId: true, config: true }
        })
        .catch(() => null);
    if (!install) return 0;

    const moved = new Map<string, ConsoleSchedule>();
    const afterWrite: (() => void)[] = [];
    let ran = 0;
    for (const schedule of readConsoleSchedules(readInstallConfig(install.config))) {
        const step = advance(schedule, now);
        if (step.next === schedule) continue;
        let last: ScheduleRun | null = step.next.last;
        let revoked = false;
        if (step.fire) {
            revoked = !(await mayStillRun(schedule.createdBy, installedAppId));
            last = revoked
                ? {
                      at: now.toISOString(),
                      outcome: "failed",
                      detail: gameMessage("games", "consoleSchedule.noAccess")
                  }
                : answering
                  ? await fire({ ownerId, install }, schedule, now, afterWrite)
                  : {
                        at: now.toISOString(),
                        outcome: "skipped",
                        detail: gameMessage("games", "consoleSchedule.offline")
                    };
            if (last.outcome === "ran") ran += 1;
        }
        moved.set(schedule.id, {
            ...step.next,
            nextAt: revoked ? null : step.next.nextAt,
            skipped: step.next.skipped + (last?.outcome === "skipped" && step.fire ? 1 : 0),
            last
        });
    }
    if (moved.size === 0) return 0;

    const fresh = await prisma.installedApp
        .findUnique({ where: { id: installedAppId }, select: { config: true } })
        .catch(() => null);
    const list = readConsoleSchedules(readInstallConfig(fresh?.config));
    await patchInstallConfig(installedAppId, {
        [CONSOLE_SCHEDULES_KEY]: list.map((entry) => moved.get(entry.id) ?? entry)
    }).catch(() => undefined);
    for (const start of afterWrite) start();
    return ran;
}

/** Write how a run with pauses ended onto its schedule - only if the schedule
 *  is still there and its last run is still this one. */
async function settleScheduleRun(
    installedAppId: string,
    scheduleId: string,
    run: ScheduleRun
): Promise<void> {
    const fresh = await prisma.installedApp
        .findUnique({ where: { id: installedAppId }, select: { config: true } })
        .catch(() => null);
    const list = readConsoleSchedules(readInstallConfig(fresh?.config));
    if (!list.some((entry) => entry.id === scheduleId && entry.last?.at === run.at)) return;
    await patchInstallConfig(installedAppId, {
        [CONSOLE_SCHEDULES_KEY]: list.map((entry) =>
            entry.id === scheduleId && entry.last?.at === run.at ? { ...entry, last: run } : entry
        )
    });
}

/** Whether whoever set a schedule up still has the console on this server: a
 *  grant taken away, a share revoked or an account switched off ends it. */
export async function mayStillRun(userId: string, installedAppId: string): Promise<boolean> {
    try {
        const user = await host.mcp.actingUser(userId);
        if (!user) return false;
        const access = await host.appsInstallAccess.gameServerAccess(
            user,
            installedAppId,
            "games.console"
        );
        return access !== null;
    } catch {
        return false;
    }
}

/** The schedules whose run with pauses is still going, by id: the next moment of
 *  one is skipped rather than started on top of it. */
const runningSchedules = new Set<string>();

/** How a run went, from what the server said to each of its lines. */
export function scheduleOutcome(at: Date, replies: readonly KeptReply[]): ScheduleRun {
    const failed = replies.find((reply) => reply.failed);
    return {
        at: at.toISOString(),
        outcome: failed ? "failed" : "ran",
        detail: failed ? failed.output.slice(0, 200) : ""
    };
}

/** Run a scheduled run with pauses off the sweep, and write how it ended. */
function runInBackground(
    server: RunServer,
    schedule: ConsoleSchedule,
    steps: readonly QueueStep[],
    now: Date
): void {
    runningSchedules.add(schedule.id);
    void sendSteps(schedule.createdBy, server, steps)
        .then((replies) => scheduleOutcome(now, replies))
        .catch((caught: unknown): ScheduleRun => ({
            at: now.toISOString(),
            outcome: "failed",
            detail:
                caught instanceof Error
                    ? caught.message.slice(0, 200)
                    : gameMessage("games", "lib.stepFailed")
        }))
        .then((run) => settleScheduleRun(server.install.id, schedule.id, run))
        .catch(() => undefined)
        .finally(() => runningSchedules.delete(schedule.id));
}

/**
 * Fire one schedule.
 *
 * A run without pauses is sent here and its outcome returned. A run with pauses
 * - a `wait 5` between two lines, or the "Start after" one in front - is not
 * waited out inside the sweep: one server's minute-long sequence would hold up
 * every other server's schedules and stretch the pass past its lease. It is
 * started in the background instead, bounded (`MOST_SCHEDULED_WAIT_S` in all,
 * one at a time per schedule), shown as running, and its outcome written onto
 * the schedule when it ends.
 */
async function fire(
    server: RunServer,
    schedule: ConsoleSchedule,
    now: Date,
    afterWrite: (() => void)[]
): Promise<ScheduleRun> {
    try {
        const steps = await keptCommandSteps(server, schedule);
        if (!steps.some((step) => step.kind === "wait")) {
            return scheduleOutcome(now, await sendSteps(schedule.createdBy, server, steps));
        }
        const tooLong = scheduledWaitProblem(steps);
        if (tooLong) return { at: now.toISOString(), outcome: "failed", detail: tooLong };
        if (runningSchedules.has(schedule.id)) {
            return {
                at: now.toISOString(),
                outcome: "skipped",
                detail: gameMessage("games", "consoleSchedule.stillRunning")
            };
        }
        // Started once the sweep has written "running", so a short run cannot
        // finish first and have its outcome overwritten by it.
        afterWrite.push(() => runInBackground(server, schedule, steps, now));
        return { at: now.toISOString(), outcome: "running", detail: "" };
    } catch (caught) {
        return {
            at: now.toISOString(),
            outcome: "failed",
            detail:
                caught instanceof Error
                    ? caught.message.slice(0, 200)
                    : gameMessage("games", "lib.stepFailed")
        };
    }
}
