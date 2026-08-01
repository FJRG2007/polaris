/**
 * What each repository has actually spent on a pool.
 *
 * Counted from the runners Polaris started, because that is the only record there
 * is: an ephemeral runner de-registers itself the moment its job ends, so GitHub
 * stops being able to answer this question seconds after it becomes worth asking.
 *
 * A runner's life is not its consumption. One that waited forty minutes for a job
 * and then worked for two spent two: the waiting cost the pool a slot, not the
 * repository a budget. That is what `busyAt` is for, and a runner that never got a
 * job spent nothing at all.
 */

import { prisma } from "@polaris/db";
import { targetKey } from "./runner-scope";
import { dayStart, windowStart, type RunnerUsage, type RunnerWindow } from "@polaris/core";

const MINUTE_MS = 60_000;

/**
 * Minutes and job counts per target, for one pool.
 *
 * Read over the wider of the two windows and split afterwards, so this is one
 * query rather than one per target - a pool serving fifty repositories would
 * otherwise open the pass with fifty round trips to the database.
 */
export async function poolUsage(
    poolId: string,
    window: RunnerWindow,
    now = new Date()
): Promise<Map<string, RunnerUsage>> {
    const since = windowStart(window, now);
    const today = dayStart(now);
    const from = since < today ? since : today;

    const jobs = await prisma.runnerJob.findMany({
        where: { poolId, startedAt: { gte: from } },
        select: { targetOwner: true, targetRepo: true, busyAt: true, finishedAt: true, startedAt: true }
    });

    const usage = new Map<string, RunnerUsage>();
    for (const job of jobs) {
        const key = targetKey(job.targetOwner, job.targetRepo);
        const current = usage.get(key) ?? { minutes: 0, jobsToday: 0 };
        // A runner still working counts what it has spent so far, so a job that has
        // been running for three hours cannot hide behind not having finished.
        const busyMinutes =
            job.busyAt === null
                ? 0
                : Math.max(0, ((job.finishedAt ?? now).getTime() - job.busyAt.getTime()) / MINUTE_MS);
        usage.set(key, {
            minutes: current.minutes + (job.startedAt >= since ? busyMinutes : 0),
            jobsToday: current.jobsToday + (job.busyAt !== null && job.startedAt >= today ? 1 : 0)
        });
    }
    return usage;
}

/** What one target has spent, or nothing when it has run nothing this window. */
export function usageFor(usage: Map<string, RunnerUsage>, key: string): RunnerUsage {
    return usage.get(key) ?? { minutes: 0, jobsToday: 0 };
}
