/**
 * Polaris runs its own schedule.
 *
 * Everything else that happens on a timer here already does - the WAF sentinel,
 * the analytics roll-up, alarm evaluation, domain health, the runner reconciler -
 * all started from `instrumentation.ts` when the server comes up. Scheduled work
 * was the exception: it lived behind `/api/cron/*` and only happened if somebody
 * had set a secret and pointed a scheduler at it, which meant that on an ordinary
 * install a backup plan was a promise nothing kept.
 *
 * One interval for the lot of it, following the update watcher rather than the
 * one-timer-per-poller shape: six more timers would be six more things to reason
 * about, and each job knows how often it wants to run anyway. The tick is cheap -
 * it looks at six numbers and usually does nothing.
 *
 * Nothing here decides what the work is. Each job is a call into the service that
 * owns it; this file owns only when.
 */

import { runJobBody, SCHEDULED_JOBS, type ScheduledJob } from "./jobs";

/** How often the table is looked at. The floor on any job's cadence. */
const TICK_MS = Number(process.env.POLARIS_CRON_TICK_MS) || 60_000;

/** Long enough that boot is over. The first pass on a fresh instance can be the
 *  heaviest one it ever runs - everything is overdue at once - and competing with
 *  the rest of startup for it helps nobody. */
const FIRST_PASS_MS = 45_000;

let started = false;

/** When each job last finished, so a long one does not immediately go again. */
const lastRunAt = new Map<string, number>();

/** Jobs in flight in this process. The lease covers the other processes; this
 *  covers a pass that takes longer than its own cadence. */
const running = new Set<string>();

function due(job: ScheduledJob, now: number): boolean {
    const last = lastRunAt.get(job.key);
    return last === undefined || now - last >= job.everyMs;
}

/**
 * Run one job now, whatever the clock says, and report what it did. Null means it
 * did not run because somebody else is already running it - this process, or
 * another one holding its lease.
 *
 * This is what the cron routes call, so an external trigger and the internal tick
 * cannot both be inside the same job: an operator who wired their own scheduler
 * against the old advice keeps it, and it stops doubling up rather than starting
 * to.
 */
export async function runScheduledJob(key: string): Promise<unknown> {
    const job = SCHEDULED_JOBS.find((entry) => entry.key === key);
    if (!job) throw new Error(`No scheduled job called ${key}`);
    return run(job);
}

async function run(job: ScheduledJob): Promise<unknown> {
    if (running.has(job.key)) return null;
    running.add(job.key);
    try {
        return await runJobBody(job);
    } finally {
        // Stamped on the way out rather than on the way in: a job that takes
        // longer than its own cadence would otherwise be due again the instant it
        // returned, and would run back to back forever.
        lastRunAt.set(job.key, Date.now());
        running.delete(job.key);
    }
}

/**
 * Start the schedule. Idempotent, and skipped entirely when
 * `POLARIS_CRON=off` - the escape hatch for an instance where the first pass is
 * doing more than somebody wants it to while they look into it.
 */
export function startScheduledWork(): void {
    if (started || process.env.POLARIS_CRON === "off") return;
    started = true;

    const tick = (): void => {
        const now = Date.now();
        for (const job of SCHEDULED_JOBS) {
            if (!due(job, now)) continue;
            void run(job).catch((error: unknown) =>
                console.error(`polaris: the ${job.key} pass failed:`, error)
            );
        }
    };

    setTimeout(tick, FIRST_PASS_MS).unref?.();
    setInterval(tick, TICK_MS).unref?.();
}
