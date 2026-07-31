/**
 * Keeping each pool's runners up, by comparing three accounts of the world rather
 * than trusting any one of them.
 *
 * Polaris has a row per runner it started. The machine has a process, or does not.
 * GitHub has a registration, or does not. All three disagree routinely - a machine
 * reboots mid-job, a runner exits before it ever connects, a network drops between
 * the two - and the pass below is written so that each of those ends in a runner
 * being replaced rather than in a pool that quietly stopped answering.
 *
 * The part worth being careful about is the registration. An ephemeral runner
 * de-registers itself after its job, but one that never got that far leaves a row
 * GitHub will keep queueing work onto, and that work goes nowhere. Anything GitHub
 * still holds under this pool's name that Polaris cannot account for is removed.
 *
 * A pass never throws. A pool that cannot be reconciled records why on itself, so
 * the operator reads it on the pool instead of in a log they have no reason to open,
 * and the next pool is still tried.
 */

import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { RunnerHost } from "./runner-host";
import { parseLabels } from "./runner-service";
import { resolveRunnerRelease, runnerPlatform } from "./runner-release";
import {
    createRunnerJitConfig,
    deleteGithubRunner,
    listGithubRunners,
    type GithubRunner,
    type RunnerTarget
} from "@/lib/github-runners";
import {
    runnerName,
    runnerNamePrefix,
    RUNNER_JOB_LIVE_STATES,
    type RunnerIsolation,
    type RunnerJobState,
    type RunnerScope
} from "@polaris/core";

const INTERVAL_MS = Number(process.env.POLARIS_RUNNER_RECONCILE_MS) || 30_000;
let started = false;
let running = false;

type PoolRow = Awaited<ReturnType<typeof loadPools>>[number];

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
            await reconcilePool(pool);
            if (pool.error !== null) await prisma.runnerPool.update({ where: { id: pool.id }, data: { error: null } });
        } catch (caught) {
            const error = caught instanceof Error ? caught.message : "Could not reconcile this pool";
            await prisma.runnerPool
                .update({ where: { id: pool.id }, data: { error } })
                .catch(() => undefined);
        }
    }
}

async function reconcilePool(pool: PoolRow): Promise<void> {
    const target: RunnerTarget = {
        scope: pool.scope as RunnerScope,
        owner: pool.targetOwner,
        repo: pool.targetRepo ?? undefined
    };

    // GitHub's view first: it is the only one that says whether a runner is
    // actually taking work, and it is needed to decide what to clean up.
    const registered = await listGithubRunners(target);
    const byName = new Map(registered.map((runner) => [runner.name, runner]));

    const host = await RunnerHost.open(pool.hostId, pool.ownerId);
    try {
        const alive: string[] = [];
        for (const job of pool.jobs) {
            const still = await settleJob(host, target, job, byName.get(job.name));
            if (still) alive.push(job.name);
        }

        await fillSlots(host, pool, target, pool.maxConcurrent - alive.length, alive);
        await dropOrphans(target, pool.name, registered, alive);
        await host.sweep(alive);
    } finally {
        host.close();
    }
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
    host: RunnerHost,
    target: RunnerTarget,
    job: PoolRow["jobs"][number],
    registration: GithubRunner | undefined
): Promise<boolean> {
    const handle = job.handle ? { isolation: job.isolation as RunnerIsolation, handle: job.handle } : null;
    if (handle && (await host.isAlive(handle))) {
        const state: RunnerJobState = registration ? (registration.busy ? "busy" : "idle") : "starting";
        if (state !== job.state) await prisma.runnerJob.update({ where: { id: job.id }, data: { state } });
        return true;
    }

    const log = handle ? await host.reap(job.name, handle).catch(() => "") : "";
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

/** Start runners until the pool is back at its concurrency. */
async function fillSlots(
    host: RunnerHost,
    pool: PoolRow,
    target: RunnerTarget,
    missing: number,
    alive: string[]
): Promise<void> {
    if (missing <= 0) return;

    const probed = await host.probe();
    const platform = runnerPlatform(probed.platform, probed.arch);
    if (!platform) throw new Error(`GitHub publishes no runner for ${probed.platform} on ${probed.arch}`);

    const isolation = pool.isolation as RunnerIsolation;
    if (isolation === "container" && !probed.containerEngine) {
        throw new Error(
            "This pool runs jobs in containers, and the Polaris login on the machine can no longer reach the container engine."
        );
    }

    const release = await resolveRunnerRelease(platform);
    // Before any registration is minted: a machine that cannot get the runner
    // would otherwise leave a registered runner nothing will ever come for.
    await host.prepare(release, isolation);

    const labels = parseLabels(pool.labels);
    for (let slot = 0; slot < missing; slot += 1) {
        // The name is settled before the row exists, so a crash between the two can
        // never leave a nameless runner holding a slot nothing can reconcile.
        const name = runnerName(pool.name, randomUUID());
        const job = await prisma.runnerJob.create({
            data: { poolId: pool.id, name, isolation, state: "starting" },
            select: { id: true }
        });

        const jit = await createRunnerJitConfig(target, { name, labels });
        await prisma.runnerJob.update({ where: { id: job.id }, data: { githubRunnerId: jit.runnerId } });

        try {
            const handle = await host.start({ name, isolation, release, jitConfig: jit.encodedConfig });
            await prisma.runnerJob.update({ where: { id: job.id }, data: { handle: handle.handle } });
            alive.push(name);
        } catch (caught) {
            // The registration exists and nothing will ever use it, so it goes
            // before the error is reported.
            await deleteGithubRunner(target, jit.runnerId).catch(() => undefined);
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
}

/**
 * Remove registrations GitHub still holds that no live runner accounts for. These
 * are what a machine that died mid-job leaves behind: GitHub keeps them online long
 * enough to hand them a workflow that will then wait forever.
 */
async function dropOrphans(
    target: RunnerTarget,
    poolName: string,
    registered: readonly GithubRunner[],
    alive: readonly string[]
): Promise<void> {
    const prefix = runnerNamePrefix(poolName);
    const candidates = registered.filter((runner) => runner.name.startsWith(prefix) && !alive.includes(runner.name));
    if (candidates.length === 0) return;

    // Two pools can be named the same and share a prefix, so a name any pool still
    // has a live runner for is left alone.
    const claimed = new Set(
        (
            await prisma.runnerJob.findMany({
                where: { name: { in: candidates.map((runner) => runner.name) }, state: { in: [...RUNNER_JOB_LIVE_STATES] } },
                select: { name: true }
            })
        ).map((job) => job.name)
    );

    for (const runner of candidates) {
        if (claimed.has(runner.name)) continue;
        await deleteGithubRunner(target, runner.id).catch(() => undefined);
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
