/**
 * Keeping each pool's runners up, and pointed at whoever is waiting.
 *
 * Three accounts of the world disagree routinely and none of them is trusted on
 * its own. Polaris has a row per runner it started; the machine has a process, or
 * does not; GitHub has a registration, or does not. A machine reboots mid-job, a
 * runner exits before it ever connects, a network drops between the two - and the
 * pass below is written so each of those ends in a runner being replaced rather
 * than in a pool that quietly stopped answering.
 *
 * On top of that, a pool now serves a set of repositories rather than one, which
 * turns "keep N runners up" into "keep N runners up in the right places". Each
 * pass therefore:
 *
 *   1. re-reads what the pool's scope comes to, and stands down anything running
 *      for a repository that has left it;
 *   2. works out what each repository has spent, and stops serving the ones that
 *      are over their budget;
 *   3. finds out who has work waiting, from the webhook or by asking;
 *   4. asks @polaris/core where the runners should be, and moves them.
 *
 * The part worth being careful about is still the registration. An ephemeral
 * runner de-registers itself after its job, but one that never got that far leaves
 * a row GitHub will keep queueing work onto, and that work goes nowhere. Anything
 * GitHub still holds under this pool's name that Polaris cannot account for is
 * removed.
 *
 * A pass never throws. A pool that cannot be reconciled records why on itself, so
 * the operator reads it on the pool instead of in a log they have no reason to
 * open, and the next pool is still tried.
 */

import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { targetKey } from "./runner-scope";
import { parseLabels } from "./runner-labels";
import { liveRunnerNames } from "./runner-service";
import { syncPoolTargets } from "./runner-targets";
import { poolUsage, usageFor } from "./runner-usage";
import { resolveRunnerRelease, runnerPlatform } from "./runner-release";
import { describeDropped, markServed, refreshDemand } from "./runner-demand";
import { openRunnerMachine, poolServerId, type RunnerMachine } from "./runner-machine";
import {
    createRunnerJitConfig,
    deleteGithubRunner,
    listGithubRunners,
    type GithubRunner,
    type RunnerTarget
} from "@/lib/github-runners";
import {
    budgetVerdict,
    placeRunners,
    runnerName,
    runnerNamePrefix,
    RUNNER_JOB_LIVE_STATES,
    type RunnerIsolation,
    type RunnerJobState,
    type RunnerWindow,
    type TargetState
} from "@polaris/core";

const INTERVAL_MS = Number(process.env.POLARIS_RUNNER_RECONCILE_MS) || 30_000;
let started = false;
let running = false;

type PoolRow = Awaited<ReturnType<typeof loadPools>>[number];
type JobRow = PoolRow["jobs"][number];
type StoredTarget = Awaited<ReturnType<typeof syncPoolTargets>>["targets"][number];

function loadPools() {
    return prisma.runnerPool.findMany({
        where: { enabled: true },
        include: { jobs: { where: { state: { in: [...RUNNER_JOB_LIVE_STATES] } } } }
    });
}

/** One pass over every enabled pool. Exported so a test or an operator action can
 *  force one without waiting out the interval. */
export async function reconcileRunnerPools(): Promise<void> {
    for (const pool of await loadPools()) {
        try {
            const note = await reconcilePool(pool);
            if (pool.error !== note) {
                await prisma.runnerPool.update({ where: { id: pool.id }, data: { error: note } });
            }
        } catch (caught) {
            const error = caught instanceof Error ? caught.message : "Could not reconcile this pool";
            await prisma.runnerPool.update({ where: { id: pool.id }, data: { error } }).catch(() => undefined);
        }
    }
}

/** What a job was registered against, from the job's own record of it. */
function jobTarget(job: JobRow): RunnerTarget {
    return {
        scope: job.targetRepo ? "repo" : "org",
        owner: job.targetOwner,
        repo: job.targetRepo ?? undefined
    };
}

function storedTarget(target: StoredTarget): RunnerTarget {
    return { scope: target.kind, owner: target.owner, repo: target.repo ?? undefined };
}

/**
 * Reconcile one pool, returning what the operator should be told about it - or
 * null when there is nothing to say. Returning the note rather than writing it
 * keeps "what happened" in one place instead of spread across every early return.
 */
async function reconcilePool(pool: PoolRow): Promise<string | null> {
    const { targets, dropped, note } = await syncPoolTargets(pool);
    if (targets.length === 0) {
        // Nothing to serve. Anything still running belongs to a repository that has
        // left, and is stood down below by the same path as any other departure.
        const machine = await openRunnerMachine(poolServerId(pool.hostId), pool.ownerId);
        try {
            for (const job of pool.jobs) await standDown(machine, job, "The pool no longer serves this repository.");
            await machine.sweep(await liveRunnerNames(pool.hostId));
        } finally {
            machine.close();
        }
        return note ?? "This pool serves no repositories.";
    }

    const serving = new Set(targets.map((target) => target.key));
    const machine = await openRunnerMachine(poolServerId(pool.hostId), pool.ownerId);

    try {
        // A runner registered somewhere the pool has stopped serving is work being
        // done on somebody's machine for a repository nobody asked it to serve.
        const departed = pool.jobs.filter((job) => !serving.has(targetKey(job.targetOwner, job.targetRepo)));
        for (const job of departed) {
            await standDown(machine, job, "The pool no longer serves this repository.");
        }

        // GitHub's view, but only where there is something to compare it against:
        // asking about a repository this pool has no runner on would be one call
        // per repository per pass to learn nothing.
        const current = pool.jobs.filter((job) => serving.has(targetKey(job.targetOwner, job.targetRepo)));
        const registered = await listRegistrations(current);

        const alive: JobRow[] = [];
        for (const job of current) {
            const key = targetKey(job.targetOwner, job.targetRepo);
            const still = await settleJob(machine, jobTarget(job), job, registered.get(key)?.get(job.name));
            if (still) alive.push(job);
        }

        const blocked = await applyBudgets(pool, targets);

        // Only worth asking who is waiting when the pool has to choose. With a slot
        // for every repository, every repository gets one regardless.
        await refreshDemand(targets, { needed: targets.length > pool.maxConcurrent });
        const demanded = await prisma.runnerPoolTarget.findMany({
            where: { poolId: pool.id },
            select: { key: true, queued: true }
        });
        const queued = new Map(demanded.map((row) => [row.key, row.queued]));
        const states = buildStates(targets, alive, queued);

        const plan = placeRunners({
            free: pool.maxConcurrent - alive.length,
            perTargetConcurrent: pool.perTargetConcurrent,
            targets: states
        });

        // Released first: each one pays for a start below, and starting before
        // freeing the slot would put the pool over its own concurrency.
        for (const key of plan.release) {
            const idle = alive.find(
                (job) => targetKey(job.targetOwner, job.targetRepo) === key && job.state === "idle"
            );
            if (!idle) continue;
            await standDown(machine, idle, null);
            alive.splice(alive.indexOf(idle), 1);
        }

        if (plan.start.length > 0) {
            // Asked once for the whole pass, not once per runner: each of these is
            // a round trip to a machine that may be on the other side of an SSH
            // connection, and eight runners would be eight of them.
            const ready = await prepareMachine(machine, pool);
            const byKey = new Map(targets.map((target) => [target.key, target]));
            for (const key of plan.start) {
                const target = byKey.get(key);
                if (!target) continue;
                await startRunner(machine, pool, target, ready);
            }
        }

        // Swept against every pool's runners on this machine, not just this one's:
        // two pools can share a server, and each row is written before its runner
        // is started, so this set is never missing one that is about to appear.
        await machine.sweep(await liveRunnerNames(pool.hostId));
        await dropOrphans(targets, pool.name, registered, alive);

        // A scope that lost repositories is worth saying once, because from the
        // outside it looks like runners disappearing for no reason.
        return note ?? describeDropped(dropped) ?? overBudgetNote(blocked);
    } finally {
        machine.close();
    }
}

/** GitHub's runner list for each target this pool currently has runners on. */
async function listRegistrations(jobs: readonly JobRow[]): Promise<Map<string, Map<string, GithubRunner>>> {
    const byTarget = new Map<string, RunnerTarget>();
    for (const job of jobs) {
        byTarget.set(targetKey(job.targetOwner, job.targetRepo), jobTarget(job));
    }
    const listings = new Map<string, Map<string, GithubRunner>>();
    for (const [key, target] of byTarget) {
        const runners = await listGithubRunners(target);
        listings.set(key, new Map(runners.map((runner) => [runner.name, runner])));
    }
    return listings;
}

/**
 * Decide what became of one runner, and return whether it still occupies a slot.
 *
 * A runner whose process is gone is finished if it ever registered and failed if it
 * did not - a runner that exits without connecting did so for a reason (a machine
 * missing a library, an image that will not start), and that reason is only in its
 * log, which is read here before the machine is cleaned.
 */
async function settleJob(
    machine: RunnerMachine,
    target: RunnerTarget,
    job: JobRow,
    registration: GithubRunner | undefined
): Promise<boolean> {
    const handle = job.handle ? { isolation: job.isolation as RunnerIsolation, handle: job.handle } : null;
    if (handle && (await machine.isAlive(handle))) {
        const state: RunnerJobState = registration ? (registration.busy ? "busy" : "idle") : "starting";
        if (state !== job.state) {
            await prisma.runnerJob.update({
                where: { id: job.id },
                data: {
                    state,
                    // The moment it was first seen working is where its consumption
                    // starts being counted, and it is only ever set once.
                    ...(state === "busy" && job.busyAt === null ? { busyAt: new Date() } : {})
                }
            });
            job.state = state;
        }
        return true;
    }

    const log = handle ? await machine.reap(job.name, handle).catch(() => "") : "";
    // "starting" means it never showed up in a GitHub listing, so it never
    // connected: this one did not run a job, it fell over.
    const failed = job.state === "starting";
    await prisma.runnerJob.update({
        where: { id: job.id },
        data: {
            state: failed ? "failed" : "finished",
            error: failed ? exitReason(log) : null,
            finishedAt: new Date()
        }
    });

    // An ephemeral runner removes its own registration once it has taken a job.
    // One that is still listed never did, so Polaris removes it.
    if (registration) await deleteGithubRunner(target, registration.id).catch(() => undefined);
    return false;
}

/**
 * Stop one runner and give its slot back: off the machine, out of GitHub, closed
 * in the record. Used both for a repository that has left the pool's scope and for
 * an idle runner being moved to one that has work.
 *
 * A busy runner is never passed here. Interrupting somebody's build to rebalance a
 * pool would be a worse failure than the imbalance.
 */
async function standDown(machine: RunnerMachine, job: JobRow, reason: string | null): Promise<void> {
    if (job.handle) {
        await machine.reap(job.name, { isolation: job.isolation as RunnerIsolation, handle: job.handle }).catch(() => "");
    }
    if (job.githubRunnerId !== null) {
        await deleteGithubRunner(jobTarget(job), job.githubRunnerId).catch(() => undefined);
    }
    await prisma.runnerJob.update({
        where: { id: job.id },
        data: { state: "finished", error: reason, finishedAt: new Date() }
    });
}

/**
 * Work out what each repository has spent and record why it is not being served.
 *
 * The reason is stored on the target rather than only used here, because "why is
 * nothing running for this repository" is a question asked on the pool card long
 * after the pass that answered it.
 */
async function applyBudgets(pool: PoolRow, targets: readonly StoredTarget[]): Promise<Map<string, string | null>> {
    const limits = {
        perTargetConcurrent: pool.perTargetConcurrent,
        minutesBudget: pool.minutesBudget,
        minutesWindow: pool.minutesWindow as RunnerWindow,
        jobsPerDay: pool.jobsPerDay,
        onExhausted: pool.onExhausted === "warn" ? ("warn" as const) : ("pause" as const)
    };
    const usage = await poolUsage(pool.id, limits.minutesWindow);
    const verdicts = new Map<string, string | null>();

    for (const target of targets) {
        const verdict = budgetVerdict(usageFor(usage, target.key), limits);
        // `warn` reports the overage without withholding the runner, so what is
        // stored is the sentence and what gates placement is `allowed`.
        const blocked = verdict.allowed ? null : verdict.exceeded;
        verdicts.set(target.key, verdict.exceeded);
        if (target.blocked !== blocked) {
            await prisma.runnerPoolTarget.update({ where: { id: target.id }, data: { blocked } });
            target.blocked = blocked;
        }
    }
    return verdicts;
}

/** What each target looks like to the placement rules. */
function buildStates(
    targets: readonly StoredTarget[],
    alive: readonly JobRow[],
    queued: Map<string, number>
): TargetState[] {
    return targets.map((target) => {
        const mine = alive.filter((job) => targetKey(job.targetOwner, job.targetRepo) === target.key);
        return {
            key: target.key,
            queued: queued.get(target.key) ?? 0,
            live: mine.length,
            idle: mine.filter((job) => job.state === "idle").length,
            blocked: target.blocked,
            lastServedAt: target.lastServedAt?.getTime() ?? 0
        };
    });
}

/** One line for the pool card when repositories are over budget, or null. */
function overBudgetNote(blocked: Map<string, string | null>): string | null {
    const over = [...blocked.entries()].filter(([, reason]) => reason !== null);
    if (over.length === 0) return null;
    const [first] = over;
    if (over.length === 1 && first) return `${first[0]}: ${first[1]}`;
    return `${over.length} repositories are over their budget this window.`;
}

/**
 * Check the machine can still do what the pool asks and get the runner onto it.
 *
 * Done before any registration is minted: a machine that cannot fetch the runner
 * would otherwise leave a registration on GitHub that nothing will ever come for.
 */
async function prepareMachine(
    machine: RunnerMachine,
    pool: PoolRow
): Promise<{ release: Awaited<ReturnType<typeof resolveRunnerRelease>>; isolation: RunnerIsolation }> {
    const probed = await machine.probe();
    const platform = runnerPlatform(probed.platform, probed.arch);
    if (!platform) throw new Error(`GitHub publishes no runner for ${probed.platform} on ${probed.arch}`);

    const isolation = pool.isolation as RunnerIsolation;
    if (isolation === "container" && !probed.containerEngine) {
        throw new Error(
            machine.reach === "engine"
                ? "Polaris can no longer reach this machine's container engine, which is the only way it runs jobs here."
                : "This pool runs jobs in containers, and the Polaris login on the machine can no longer reach the container engine."
        );
    }

    const release = await resolveRunnerRelease(platform);
    await machine.prepare(release, isolation);
    return { release, isolation };
}

/** Start one runner for one target, on a machine already prepared for it. */
async function startRunner(
    machine: RunnerMachine,
    pool: PoolRow,
    target: StoredTarget,
    ready: { release: Awaited<ReturnType<typeof resolveRunnerRelease>>; isolation: RunnerIsolation }
): Promise<void> {
    const { release, isolation } = ready;

    // The name is settled before the row exists, so a crash between the two can
    // never leave a nameless runner holding a slot nothing can reconcile.
    const name = runnerName(pool.name, randomUUID());
    const job = await prisma.runnerJob.create({
        data: {
            poolId: pool.id,
            name,
            isolation,
            state: "starting",
            targetOwner: target.owner,
            targetRepo: target.repo
        },
        select: { id: true }
    });

    const jit = await createRunnerJitConfig(storedTarget(target), { name, labels: parseLabels(pool.labels) });
    await prisma.runnerJob.update({ where: { id: job.id }, data: { githubRunnerId: jit.runnerId } });

    try {
        const handle = await machine.start({ name, isolation, release, jitConfig: jit.encodedConfig });
        await prisma.runnerJob.update({ where: { id: job.id }, data: { handle: handle.handle } });
        await markServed(target.id);
    } catch (caught) {
        // The registration exists and nothing will ever use it, so it goes before
        // the error is reported.
        await deleteGithubRunner(storedTarget(target), jit.runnerId).catch(() => undefined);
        await prisma.runnerJob.update({
            where: { id: job.id },
            data: {
                state: "failed",
                finishedAt: new Date(),
                error: caught instanceof Error ? caught.message : "The machine did not start the runner"
            }
        });
        throw caught;
    }
}

/**
 * Remove registrations GitHub still holds that no live runner accounts for. These
 * are what a machine that died mid-job leaves behind: GitHub keeps them online long
 * enough to hand them a workflow that will then wait forever.
 */
async function dropOrphans(
    targets: readonly StoredTarget[],
    poolName: string,
    registered: Map<string, Map<string, GithubRunner>>,
    alive: readonly JobRow[]
): Promise<void> {
    const prefix = runnerNamePrefix(poolName);
    const living = new Set(alive.map((job) => job.name));
    const byKey = new Map(targets.map((target) => [target.key, target]));

    for (const [key, runners] of registered) {
        const target = byKey.get(key);
        if (!target) continue;
        const candidates = [...runners.values()].filter(
            (runner) => runner.name.startsWith(prefix) && !living.has(runner.name)
        );
        if (candidates.length === 0) continue;

        // Two pools can be named the same and share a prefix, so a name any pool
        // still has a live runner for is left alone.
        const claimed = new Set(
            (
                await prisma.runnerJob.findMany({
                    where: {
                        name: { in: candidates.map((runner) => runner.name) },
                        state: { in: [...RUNNER_JOB_LIVE_STATES] }
                    },
                    select: { name: true }
                })
            ).map((job) => job.name)
        );

        for (const runner of candidates) {
            if (claimed.has(runner.name)) continue;
            await deleteGithubRunner(storedTarget(target), runner.id).catch(() => undefined);
        }
    }
}

/** The line of a dead runner's log worth showing. The runner is verbose and most
 *  of it is startup noise; the operator needs the sentence that says why. */
function exitReason(log: string): string {
    const lines = log
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const complaint = [...lines].reverse().find((line) => /error|cannot|not found|denied|failed/i.test(line));
    return (complaint ?? lines.at(-1) ?? "The runner exited before it registered").slice(0, 500);
}

/** Start the reconcile loop (idempotent). Passes never overlap: one of them holds
 *  SSH connections open and starts processes, and two doing that at once would
 *  double a pool's runners. */
export function startRunnerReconciler(): void {
    if (started) return;
    started = true;
    const tick = (): void => {
        if (running) return;
        running = true;
        void reconcileRunnerPools()
            .catch((error) => console.error("polaris: runner reconcile failed:", error))
            .finally(() => {
                running = false;
            });
    };
    setInterval(tick, INTERVAL_MS).unref?.();
    // First pass once the server has settled, like the other background loops.
    setTimeout(tick, 20_000).unref?.();
}
