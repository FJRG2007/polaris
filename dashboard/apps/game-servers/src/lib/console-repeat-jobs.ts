/**
 * The repeats running right now, and the timers that drive them.
 *
 * Held in this process's memory, like the challenge loops, and never stored:
 * a repeat lasts minutes, and one that came back after the dashboard restarted
 * would be a command firing on a server nobody is watching any more. A restart
 * ends every repeat with nothing left behind to clean up.
 *
 * What one run does is handed in (`console-repeat-service`), so this module
 * knows nothing of servers and is driven by fake timers in a test. Bounded: so
 * many at once per server and overall, and an ended one is kept only long
 * enough for the console to say how it ended.
 */

import { randomUUID } from "node:crypto";
import {
    MAX_REPEATS_OVERALL,
    MAX_REPEATS_PER_SERVER,
    type ConsoleRepeatView,
    type RepeatEnd
} from "./console-repeat";

/** How one run went: the repeat goes on (with what went wrong, if anything),
 *  or it ends here. */
export type RunOutcome = { readonly end: RepeatEnd } | { readonly problem: string | null };

/** One run. `run` counts from 1; `over` turns true the moment it is stopped,
 *  for a run that pauses to give up its pause. */
export type RepeatRun = (run: number, over: () => boolean) => Promise<RunOutcome>;

/** How long an ended repeat stays listed, so the console can say why it ended. */
export const KEEP_ENDED_MS = 60_000;

interface Job {
    readonly id: string;
    readonly installedAppId: string;
    readonly label: string;
    readonly command: string;
    readonly total: number;
    readonly gapMs: number;
    readonly startedBy: string;
    readonly run: RepeatRun;
    done: number;
    nextAt: number | null;
    ended: RepeatEnd | null;
    lastProblem: string | null;
    timer: ReturnType<typeof setTimeout> | null;
}

const jobs = new Map<string, Job>();

function view(job: Job): ConsoleRepeatView {
    return {
        id: job.id,
        label: job.label,
        command: job.command,
        done: job.done,
        total: job.total,
        gapMs: job.gapMs,
        nextAt: job.nextAt,
        startedBy: job.startedBy,
        ended: job.ended,
        lastProblem: job.lastProblem
    };
}

function active(): Job[] {
    return [...jobs.values()].filter((job) => job.ended === null);
}

function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(fn, ms);
    // Never what keeps the process alive.
    (timer as { unref?: () => void }).unref?.();
    return timer;
}

function end(job: Job, why: RepeatEnd): void {
    if (job.ended) return;
    job.ended = why;
    job.nextAt = null;
    if (job.timer) clearTimeout(job.timer);
    job.timer = later(() => jobs.delete(job.id), KEEP_ENDED_MS);
}

function schedule(job: Job, ms: number): void {
    job.nextAt = Date.now() + ms;
    job.timer = later(() => void fire(job), ms);
}

async function fire(job: Job): Promise<void> {
    if (job.ended) return;
    job.timer = null;
    job.nextAt = null;
    let outcome: RunOutcome;
    try {
        outcome = await job.run(job.done + 1, () => job.ended !== null);
    } catch (caught) {
        outcome = { problem: caught instanceof Error ? caught.message : null };
    }
    // Stopped while it ran: the stop stands, and says so.
    if (job.ended) return;
    if ("end" in outcome) {
        end(job, outcome.end);
        return;
    }
    job.done += 1;
    job.lastProblem = outcome.problem;
    if (job.done >= job.total) end(job, "finished");
    else schedule(job, job.gapMs);
}

/** Start a repeat; its first run goes now. Null when as many are running as
 *  may, on this server or overall. */
export function startRepeat(input: {
    readonly installedAppId: string;
    readonly label: string;
    readonly command: string;
    readonly total: number;
    readonly gapMs: number;
    readonly startedBy: string;
    readonly run: RepeatRun;
}): ConsoleRepeatView | null {
    const running = active();
    if (running.length >= MAX_REPEATS_OVERALL) return null;
    if (
        running.filter((job) => job.installedAppId === input.installedAppId).length >=
        MAX_REPEATS_PER_SERVER
    ) {
        return null;
    }
    const job: Job = {
        ...input,
        id: randomUUID(),
        done: 0,
        nextAt: null,
        ended: null,
        lastProblem: null,
        timer: null
    };
    jobs.set(job.id, job);
    schedule(job, 0);
    return view(job);
}

/** Every repeat on one server, running or just ended, oldest first. */
export function listRepeats(installedAppId: string): ConsoleRepeatView[] {
    return [...jobs.values()].filter((job) => job.installedAppId === installedAppId).map(view);
}

/** Stop one repeat on one server. False for one that is not running there. */
export function stopRepeat(installedAppId: string, id: string): boolean {
    const job = jobs.get(id);
    if (!job || job.installedAppId !== installedAppId || job.ended) return false;
    end(job, "stopped");
    return true;
}

/** End every repeat on a server, for a server being stopped or restarted. */
export function endRepeatsOn(installedAppId: string, why: RepeatEnd = "serverStopped"): number {
    let ended = 0;
    for (const job of active()) {
        if (job.installedAppId !== installedAppId) continue;
        end(job, why);
        ended += 1;
    }
    return ended;
}

/** Wait `ms`, giving up early once `over` turns true. */
export async function pause(ms: number, over: () => boolean): Promise<void> {
    const until = Date.now() + ms;
    while (!over() && Date.now() < until) {
        await new Promise((resolve) =>
            later(() => resolve(undefined), Math.min(250, until - Date.now()))
        );
    }
}

/** For tests: forget every repeat and its timers. */
export function resetRepeatsForTest(): void {
    for (const job of jobs.values()) if (job.timer) clearTimeout(job.timer);
    jobs.clear();
}
