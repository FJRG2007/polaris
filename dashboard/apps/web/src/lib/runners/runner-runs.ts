/**
 * What has actually run on the operator's machines.
 *
 * One ephemeral runner is one job, so the runner rows are the history - there is
 * no separate record to keep. What they could not say until now is *what* they
 * ran: the runner de-registers itself the moment its job ends, and GitHub stops
 * being able to answer. The guard on the machine writes that down as the job is
 * handed over, and it is read back when the runner is reaped.
 *
 * Three outcomes share this list and all three are worth seeing:
 *
 *   - it ran, and there is a workflow run on GitHub to open;
 *   - it was refused, because the repository does not allow that event, or that
 *     pull request came from a fork. Somebody is waiting on a red check and this
 *     is the only place that says why;
 *   - it never started, because the machine could not run the runner at all.
 *
 * A runner that was stood down without ever being given a job is not a run and is
 * left out. Listing them would bury the twelve real runs of a day under a hundred
 * rows recording that a pool rebalanced itself.
 */

import { prisma } from "@polaris/db";
import { targetKey } from "./runner-scope";
import { outcomeOf, type RunnerJobState, type RunnerRunOutcome } from "@polaris/core";

/** One run, as the Runs screen shows it. */
export interface RunnerRunView {
    id: string;
    /** The pool that served it, and the machine it ran on. */
    poolId: string;
    poolName: string;
    hostName: string;
    /** "owner/repo" it ran for. */
    target: string;
    /** The workflow's name, or null when the runner never got as far as a job. */
    workflow: string | null;
    jobName: string | null;
    /** GitHub's run id, so the row can link to the run itself. */
    runId: string | null;
    event: string | null;
    actor: string | null;
    ref: string | null;
    sha: string | null;
    state: RunnerJobState;
    /** Why Polaris would not let it run, or null. */
    refusedReason: string | null;
    /** Why the runner itself failed, or null. */
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
    /** How long it held the machine, in seconds, or null while it still does. */
    seconds: number | null;
}

/** What the list is narrowed to. Every field is optional; absent means all. */
export interface RunnerRunFilter {
    poolId?: string;
    target?: string;
    /** ran | refused | failed | running - the outcomes, not the internal states. */
    outcome?: RunnerRunOutcome;
    limit?: number;
}

/** How many runs one page shows. Enough to cover a busy day without turning the
 *  screen into a scroll nobody reads to the end of. */
const PAGE = 50;

export async function listRunnerRuns(ownerId: string, filter: RunnerRunFilter = {}): Promise<RunnerRunView[]> {
    const rows = await prisma.runnerJob.findMany({
        where: {
            pool: { ownerId, ...(filter.poolId ? { id: filter.poolId } : {}) },
            // A runner that was never given a job is not a run. It either recorded
            // what it was handed, or it fell over trying - anything else is a pool
            // moving a spare runner from one repository to another.
            OR: [{ workflow: { not: null } }, { refusedReason: { not: null } }, { state: "failed" }, { state: "busy" }]
        },
        include: { pool: { select: { name: true, host: { select: { name: true } } } } },
        orderBy: { startedAt: "desc" },
        take: Math.min(filter.limit ?? PAGE, 200)
    });

    const runs = rows.map((row) => {
        const state = row.state as RunnerJobState;
        const finished = row.finishedAt;
        return {
            id: row.id,
            poolId: row.poolId,
            poolName: row.pool.name,
            hostName: row.pool.host?.name ?? "this machine",
            target: targetKey(row.targetOwner, row.targetRepo),
            workflow: row.workflow,
            jobName: row.jobName,
            runId: row.runId,
            event: row.event,
            actor: row.actor,
            ref: row.ref,
            sha: row.sha,
            state,
            refusedReason: row.refusedReason,
            error: row.error,
            startedAt: row.startedAt.toISOString(),
            finishedAt: finished?.toISOString() ?? null,
            // Measured from when the job was taken rather than from when the runner
            // was started: a runner that waited an hour and worked for two minutes
            // held the machine for two minutes, and saying an hour would be a lie.
            seconds: finished && row.busyAt ? Math.max(0, Math.round((finished.getTime() - row.busyAt.getTime()) / 1000)) : null
        };
    });

    // Filtered after the read rather than in it: the outcome is a reading of three
    // columns and there is nothing in the database to index it by. The page is
    // bounded above, so this is a filter over at most a couple of hundred rows.
    return runs.filter((run) => {
        if (filter.target && run.target !== filter.target) return false;
        if (filter.outcome && outcomeOf(run) !== filter.outcome) return false;
        return true;
    });
}

/** The pools and repositories the Runs screen offers as filters, so it shows what
 *  this operator actually has rather than a free-text box. */
export async function runFilterOptions(
    ownerId: string
): Promise<{ pools: Array<{ id: string; name: string }>; targets: string[] }> {
    const pools = await prisma.runnerPool.findMany({
        where: { ownerId },
        select: { id: true, name: true, targets: { select: { key: true } } },
        orderBy: { createdAt: "asc" }
    });
    const targets = new Set<string>();
    for (const pool of pools) for (const target of pool.targets) targets.add(target.key);
    return {
        pools: pools.map((pool) => ({ id: pool.id, name: pool.name })),
        targets: [...targets].sort()
    };
}
