/**
 * What one run of a repeat does on the server, handed to the timers in
 * `console-repeat-jobs`.
 *
 * Every run asks again what a single run would have asked: whether whoever
 * started it still has the console, and which players are on - so a player who
 * joins halfway through is in the next run, and a grant taken away ends it.
 * Each line then goes through the console's own path (`runConsoleCommand`),
 * with its audit line, exactly as a typed one does.
 *
 * A repeat belongs to one run of the server. It ends when the server is turned
 * off, or when its container is not the one that was up when it started - a
 * restart from anywhere (the button, a schedule, the crash watch) starts a new
 * container, and a repeat carrying on into the next boot is not what anybody
 * asked for. The buttons also end it at once (`games-operations`).
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { gameMessage } from "./game-message";
import type { QueueStep } from "./console-queue";
import { runConsoleCommand } from "./games-operations";
import { mayStillRun, type RunServer } from "./console-run-service";
import { pause, startRepeat, type RunOutcome } from "./console-repeat-jobs";
import { repeatGapMs, type ConsoleRepeatView, type RepeatPlan } from "./console-repeat";

const { readAppContainerRuntime } = host.appContainerMetrics;

/** Which boot of the server a repeat runs on: the container's start time, or
 *  null where it cannot be read (a server on another machine). */
interface Boot {
    readonly startedAt: string | null;
}

/** The boot the server is on, or null when it is not up. */
export async function serverBoot(server: RunServer): Promise<Boot | null> {
    const applicationId = server.install.applicationId;
    if (!applicationId) return null;
    const app = await prisma.application
        .findFirst({ where: { id: applicationId }, select: { desiredState: true } })
        .catch(() => null);
    if (app?.desiredState !== "running") return null;
    const state = await readAppContainerRuntime(applicationId, server.ownerId).catch(() => null);
    if (state && state.status !== "running") return null;
    return { startedAt: state?.startedAt ?? null };
}

/** Whether `now` is still the boot a repeat started on. Unknown on either side
 *  is not a change: nothing is ended on a reading nobody has. */
export function sameBoot(started: Boot, now: Boot | null): boolean {
    if (!now) return false;
    return started.startedAt === null || now.startedAt === null || started.startedAt === now.startedAt;
}

function problemOf(caught: unknown): string {
    return caught instanceof Error ? caught.message : gameMessage("games", "lib.stepFailed");
}

/**
 * Start a repeat on a server that is up. `steps` is what one run sends, worked
 * out again for every run. Throws a carried message when the server is not up
 * or as many repeats are running as may.
 */
export async function startConsoleRepeat(input: {
    readonly actor: { readonly id: string; readonly name: string };
    readonly server: RunServer;
    readonly label: string;
    readonly command: string;
    readonly plan: RepeatPlan;
    readonly steps: () => Promise<readonly QueueStep[]>;
}): Promise<ConsoleRepeatView> {
    const { actor, server } = input;
    const started = await serverBoot(server);
    if (!started) throw new Error(gameMessage("games", "consoleRepeat.errors.offline"));

    const run = async (_run: number, over: () => boolean): Promise<RunOutcome> => {
        if (!(await mayStillRun(actor.id, server.install.id))) return { end: "noAccess" };
        if (!sameBoot(started, await serverBoot(server))) return { end: "serverStopped" };
        let steps: readonly QueueStep[];
        try {
            steps = await input.steps();
        } catch (caught) {
            // Nobody on to write a per-player line for is this run skipped,
            // not the repeat over: somebody may be on by the next.
            return { problem: problemOf(caught) };
        }
        let problem: string | null = null;
        for (const step of steps) {
            if (over()) break;
            if (step.kind === "wait") {
                await pause(step.ms, over);
                continue;
            }
            try {
                await runConsoleCommand({ id: actor.id }, server, step.line);
            } catch (caught) {
                problem ??= problemOf(caught);
            }
        }
        return { problem };
    };

    const view = startRepeat({
        installedAppId: server.install.id,
        label: input.label,
        command: input.command,
        total: input.plan.times,
        gapMs: repeatGapMs(input.plan),
        startedBy: actor.name,
        run
    });
    if (!view) throw new Error(gameMessage("games", "consoleRepeat.errors.busy"));
    return view;
}
