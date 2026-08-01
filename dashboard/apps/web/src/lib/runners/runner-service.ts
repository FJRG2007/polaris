/**
 * Runner pools: the operator-facing half of the CI system.
 *
 * A pool is an offer of one of the operator's machines to GitHub, so creating one
 * is checked against reality before it is stored rather than after: the connection
 * is asked whether it may register runners where the scope points, the scope is
 * resolved so a pool that would serve nothing is refused at the form rather than
 * discovered empty an hour later, and the machine is asked what it can actually do.
 * Those answers are refusals, not adjustments - a pool that quietly became less
 * isolated than what was asked for would leave a workflow author believing
 * something untrue about where their secrets run.
 *
 * Deleting a pool is the same care in reverse. The runners it started are processes
 * on somebody's machine and rows in somebody's GitHub account, and a pool now has
 * runners in several accounts at once; the pool is removed only once every one of
 * them has been cleaned up.
 */

import { prisma } from "@polaris/db";
import { parseLabels } from "./runner-labels";
import { recordAudit } from "@/lib/audit-service";
import { runnerPlatform } from "./runner-release";
import { poolUsage, usageFor } from "./runner-usage";
import { storeScope, targetKey } from "./runner-scope";
import { resolveScope, syncPoolTargets } from "./runner-targets";
import { openRunnerMachine, poolServerId } from "./runner-machine";
import { getLocalServerName, LOCAL_SERVER_FALLBACK_NAME } from "@/lib/local-server";
import { deleteGithubRunner, getRunnerAccess, type RunnerTarget } from "@/lib/github-runners";
import {
    estimateRunnerCapacity,
    LOCAL_SERVER_ID,
    resolveRunnerIsolation,
    RUNNER_JOB_LIVE_STATES,
    runnerTargetRefusal,
    type CreateRunnerPoolInput,
    type MachineResources,
    type RunnerIsolation,
    type RunnerJobState,
    type RunnerLimits,
    type RunnerScope,
    type RunnerScopeInput,
    type RunnerTargetKind,
    type UpdateRunnerPoolInput
} from "@polaris/core";

export { parseLabels };

/** One repository (or organization) a pool serves, as the dashboard shows it. */
export interface RunnerTargetView {
    key: string;
    kind: RunnerTargetKind;
    owner: string;
    repo: string | null;
    /** Jobs waiting on GitHub that this pool could take, as last observed. */
    queued: number;
    /** Runners this pool has up here right now. */
    live: number;
    /** Minutes of runner time spent in the pool's window. */
    minutes: number;
    jobsToday: number;
    /** Why it is not being served, or null. */
    blocked: string | null;
}

/** A pool as the dashboard shows it. */
export interface RunnerPoolView {
    id: string;
    name: string;
    /** The server it runs on: a Host id, or "local" for the Polaris box. */
    serverId: string;
    hostName: string;
    scope: RunnerScope;
    /** What the scope comes to, in one line: "acme/website", "4 repositories". */
    scopeSummary: string;
    targets: RunnerTargetView[];
    labels: string[];
    maxConcurrent: number;
    limits: RunnerLimits;
    isolation: RunnerIsolation;
    enabled: boolean;
    error: string | null;
    /** Runners of this pool that are up, so the card can say "2 of 3 waiting". */
    live: number;
    jobs: RunnerJobView[];
}

export interface RunnerJobView {
    id: string;
    name: string;
    /** Where this one was registered, so a job row says what it ran for. */
    target: string;
    state: RunnerJobState;
    error: string | null;
    startedAt: string;
    finishedAt: string | null;
}

/** How many finished runners a pool shows. Recent history answers "did anything
 *  run", which is the question; the full log lives in the workflow run. */
const JOB_HISTORY = 8;

/** The pool's limits, read off the row. */
function poolLimits(pool: {
    perTargetConcurrent: number | null;
    minutesBudget: number | null;
    minutesWindow: string;
    jobsPerDay: number | null;
    onExhausted: string;
}): RunnerLimits {
    return {
        perTargetConcurrent: pool.perTargetConcurrent,
        minutesBudget: pool.minutesBudget,
        minutesWindow: pool.minutesWindow === "day" ? "day" : "month",
        jobsPerDay: pool.jobsPerDay,
        onExhausted: pool.onExhausted === "warn" ? "warn" : "pause"
    };
}

/** What a pool serves, in the fewest words that are still true. */
function summarize(scope: RunnerScope, targets: readonly { key: string; kind: string }[]): string {
    if (scope === "org") return `${targets[0]?.key ?? "an organization"} (organization)`;
    if (targets.length === 0) return "nothing yet";
    if (targets.length === 1) return targets[0]?.key ?? "";
    return `${targets.length} repositories`;
}

export async function listRunnerPools(ownerId: string): Promise<RunnerPoolView[]> {
    const [pools, localName] = await Promise.all([
        prisma.runnerPool.findMany({
            where: { ownerId },
            include: {
                host: { select: { name: true } },
                targets: { orderBy: { key: "asc" } },
                jobs: { orderBy: { startedAt: "desc" }, take: JOB_HISTORY }
            },
            orderBy: { createdAt: "asc" }
        }),
        getLocalServerName()
    ]);

    return Promise.all(
        pools.map(async (pool) => {
            const limits = poolLimits(pool);
            const usage = await poolUsage(pool.id, limits.minutesWindow);
            const liveJobs = await prisma.runnerJob.findMany({
                where: { poolId: pool.id, state: { in: [...RUNNER_JOB_LIVE_STATES] } },
                select: { targetOwner: true, targetRepo: true }
            });

            return {
                id: pool.id,
                name: pool.name,
                serverId: poolServerId(pool.hostId),
                hostName: pool.host?.name ?? localName ?? LOCAL_SERVER_FALLBACK_NAME,
                scope: pool.scope as RunnerScope,
                scopeSummary: summarize(pool.scope as RunnerScope, pool.targets),
                targets: pool.targets.map((target) => {
                    const spent = usageFor(usage, target.key);
                    return {
                        key: target.key,
                        kind: target.kind === "org" ? ("org" as const) : ("repo" as const),
                        owner: target.owner,
                        repo: target.repo,
                        queued: target.queued,
                        live: liveJobs.filter((job) => targetKey(job.targetOwner, job.targetRepo) === target.key).length,
                        minutes: Math.round(spent.minutes),
                        jobsToday: spent.jobsToday,
                        blocked: target.blocked
                    };
                }),
                labels: parseLabels(pool.labels),
                maxConcurrent: pool.maxConcurrent,
                limits,
                isolation: pool.isolation as RunnerIsolation,
                enabled: pool.enabled,
                error: pool.error,
                live: liveJobs.length,
                jobs: pool.jobs.map((job) => ({
                    id: job.id,
                    name: job.name,
                    target: targetKey(job.targetOwner, job.targetRepo),
                    state: job.state as RunnerJobState,
                    error: job.error,
                    startedAt: job.startedAt.toISOString(),
                    finishedAt: job.finishedAt?.toISOString() ?? null
                }))
            };
        })
    );
}

/**
 * Every runner Polaris still expects to find on one machine, whichever pool
 * started it.
 *
 * A sweep removes what no live runner accounts for, and it is the machine that is
 * being swept, not the pool: two pools can share a server, and a sweep that only
 * knew about its own pool's runners would take another pool's job down with it.
 * `exceptPoolId` leaves out a pool being deleted, whose runners have already been
 * reaped by the time the machine is swept.
 */
export async function liveRunnerNames(hostId: string | null, exceptPoolId?: string): Promise<string[]> {
    const jobs = await prisma.runnerJob.findMany({
        where: {
            state: { in: [...RUNNER_JOB_LIVE_STATES] },
            pool: { hostId, ...(exceptPoolId === undefined ? {} : { id: { not: exceptPoolId } }) }
        },
        select: { name: true }
    });
    return jobs.map((job) => job.name);
}

/** What a machine can be asked to do, read off the machine itself. The pool form
 *  asks for this before it offers isolation choices, so nobody picks one the
 *  machine cannot honour, or a concurrency the machine cannot carry. */
export interface RunnerHostReadiness {
    platform: string;
    arch: string;
    containerEngine: boolean;
    /** How Polaris drives it: over a login, or only through its container engine. */
    reach: "login" | "engine";
    resources: MachineResources;
    /** Jobs this machine is worth being offered at once, 0 when it cannot take one. */
    recommended: number;
    /** What the machine has, in one line for the form. */
    capacityNote: string;
    /** Null when this machine can run runners at all - a platform GitHub does not
     *  publish a runner for, or one with nothing left to run a job with. */
    unsupported: string | null;
}

export async function probeRunnerHost(ownerId: string, serverId: string): Promise<RunnerHostReadiness> {
    const machine = await openRunnerMachine(serverId, ownerId);
    try {
        const probed = await machine.probe();
        const capacity = estimateRunnerCapacity(probed.resources);
        const platform = runnerPlatform(probed.platform, probed.arch)
            ? null
            : `GitHub publishes no runner for ${probed.platform || "this system"} on ${probed.arch || "this processor"}.`;
        // The local box answers through the host daemon, so an engine that does
        // not reply is a daemon to look at - not an unsupported processor, which
        // is what the platform message above would otherwise claim.
        const unreachable =
            machine.reach === "engine" && !probed.containerEngine
                ? "Polaris cannot reach this machine's container engine, which is the only way it runs jobs here. Check that the host daemon is running."
                : null;
        return {
            platform: probed.platform,
            arch: probed.arch,
            containerEngine: probed.containerEngine,
            reach: machine.reach,
            resources: probed.resources,
            recommended: capacity.recommended,
            capacityNote: capacity.note,
            unsupported: unreachable ?? platform ?? capacity.refusal
        };
    } finally {
        machine.close();
    }
}

/**
 * Whether this connection may register runners everywhere a scope points.
 *
 * Checked per account rather than per repository: GitHub grants runner
 * registration at the account level, so a scope covering thirty repositories of
 * one account is one question, not thirty.
 */
async function refuseScope(scope: RunnerScopeInput, targets: readonly { kind: RunnerTargetKind; owner: string }[]) {
    const access = await getRunnerAccess();
    const asked = new Map<string, { kind: RunnerTargetKind; owner: string }>();
    for (const target of targets) asked.set(`${target.kind}:${target.owner.toLowerCase()}`, target);
    for (const target of asked.values()) {
        const refusal = runnerTargetRefusal(access, target.kind, target.owner);
        if (refusal) return refusal;
    }
    // A scope that names people rather than repositories is worth refusing in its
    // own terms, since "no targets" reads as a Polaris fault otherwise.
    if (targets.length === 0 && (scope.kind === "users" || scope.kind === "group")) {
        return "Nobody chosen has linked a GitHub account yet, so this pool would serve nothing.";
    }
    return null;
}

export async function createRunnerPool(ownerId: string, input: CreateRunnerPoolInput): Promise<{ id: string }> {
    const resolution = await resolveScope(input.scope);
    if (resolution.targets.length === 0) throw new Error(resolution.note ?? "This scope serves no repositories.");

    const refusal = await refuseScope(input.scope, resolution.targets);
    if (refusal) throw new Error(refusal);

    // The machine is asked, not the enrollment record: a container engine can be
    // installed or its group membership revoked long after a server was added,
    // and the disk it builds in fills up without anybody telling Polaris.
    const readiness = await probeRunnerHost(ownerId, input.serverId);
    if (readiness.unsupported) throw new Error(readiness.unsupported);

    const isolation = resolveRunnerIsolation(input.isolation, {
        platform: readiness.platform === "darwin" ? "darwin" : "linux",
        containerEngine: readiness.containerEngine,
        reach: readiness.reach
    });
    if (isolation.refusal) throw new Error(isolation.refusal);

    // The form caps this at the same number, but the form is not the gate: a pool
    // sized past the machine fails as a build that ran out of memory hours later.
    if (input.maxConcurrent > readiness.recommended) {
        throw new Error(
            `This machine is worth about ${readiness.recommended} ${readiness.recommended === 1 ? "job" : "jobs"} at once (${readiness.capacityNote}).`
        );
    }

    const pool = await prisma.runnerPool.create({
        data: {
            ownerId,
            hostId: input.serverId === LOCAL_SERVER_ID ? null : input.serverId,
            name: input.name,
            ...storeScope(input.scope),
            labels: JSON.stringify(input.labels),
            maxConcurrent: input.maxConcurrent,
            isolation: isolation.isolation,
            perTargetConcurrent: input.limits.perTargetConcurrent,
            minutesBudget: input.limits.minutesBudget,
            minutesWindow: input.limits.minutesWindow,
            jobsPerDay: input.limits.jobsPerDay,
            onExhausted: input.limits.onExhausted,
            targetsResolvedAt: new Date(),
            targets: {
                create: resolution.targets.map((target) => ({
                    key: target.key,
                    kind: target.kind,
                    owner: target.owner,
                    repo: target.repo
                }))
            }
        },
        select: { id: true }
    });

    await recordAudit({
        actorId: ownerId,
        action: "runner.pool.create",
        targetType: "runnerPool",
        targetId: pool.id,
        metadata: {
            scope: input.scope.kind,
            targets: resolution.targets.length,
            isolation: isolation.isolation,
            maxConcurrent: input.maxConcurrent
        }
    });
    return pool;
}

/** Change what a pool does without changing which machine it does it on. Moving a
 *  pool to another server would strand every runner it has running there, so that
 *  is not something an edit can do. */
export async function updateRunnerPool(ownerId: string, input: UpdateRunnerPoolInput): Promise<boolean> {
    const stored = await prisma.runnerPool.findFirst({
        where: { id: input.id, ownerId },
        select: { hostId: true, maxConcurrent: true }
    });
    if (!stored) return false;

    // Asking for more runners is the one edit that puts more work on the machine,
    // so it is held to the same estimate creating the pool was. Lowering it, or
    // pausing, never pays for a probe - a machine that is off must still be
    // possible to turn a pool off on.
    if (input.maxConcurrent !== undefined && input.maxConcurrent > stored.maxConcurrent) {
        const readiness = await probeRunnerHost(ownerId, poolServerId(stored.hostId));
        if (input.maxConcurrent > readiness.recommended) {
            throw new Error(
                `This machine is worth about ${readiness.recommended} ${readiness.recommended === 1 ? "job" : "jobs"} at once (${readiness.capacityNote}).`
            );
        }
    }

    // A new scope is checked the way a new pool's is, so an edit cannot point a
    // machine somewhere the connection may not register runners.
    let scope: { scope: string; scopeConfig: string } | null = null;
    if (input.scope !== undefined) {
        const resolution = await resolveScope(input.scope);
        if (resolution.targets.length === 0) throw new Error(resolution.note ?? "This scope serves no repositories.");
        const refusal = await refuseScope(input.scope, resolution.targets);
        if (refusal) throw new Error(refusal);
        scope = storeScope(input.scope);
    }

    const { count } = await prisma.runnerPool.updateMany({
        where: { id: input.id, ownerId },
        data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.labels === undefined ? {} : { labels: JSON.stringify(input.labels) }),
            ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.limits === undefined
                ? {}
                : {
                      perTargetConcurrent: input.limits.perTargetConcurrent,
                      minutesBudget: input.limits.minutesBudget,
                      minutesWindow: input.limits.minutesWindow,
                      jobsPerDay: input.limits.jobsPerDay,
                      onExhausted: input.limits.onExhausted
                  }),
            // A changed scope is re-resolved on the next pass rather than here, so
            // the edit returns as soon as it is stored and the runners follow.
            ...(scope === null ? {} : { ...scope, targetsResolvedAt: null })
        }
    });
    if (count === 0) return false;

    await recordAudit({ actorId: ownerId, action: "runner.pool.update", targetType: "runnerPool", targetId: input.id });
    return true;
}

/**
 * Re-read what a pool's scope comes to, now rather than on the next pass. For an
 * operator who just created a repository, or just had somebody link an account,
 * and does not want to wait out the interval.
 */
export async function refreshRunnerPoolTargets(ownerId: string, poolId: string): Promise<boolean> {
    const pool = await prisma.runnerPool.findFirst({
        where: { id: poolId, ownerId },
        select: { id: true, scope: true, scopeConfig: true, targetsResolvedAt: true }
    });
    if (!pool) return false;
    await syncPoolTargets(pool, { force: true });
    return true;
}

/**
 * Remove a pool, and everything it left running. The machine is cleaned first and
 * GitHub second, because a registration outliving its process is a runner GitHub
 * keeps queueing work onto - the failure mode worth avoiding even if the delete
 * itself has to be retried.
 *
 * Each runner is de-registered where it was registered, from its own record of it:
 * one pool's runners can be spread across every repository of an account.
 */
export async function deleteRunnerPool(ownerId: string, poolId: string): Promise<void> {
    const pool = await prisma.runnerPool.findFirst({
        where: { id: poolId, ownerId },
        include: { jobs: { where: { finishedAt: null } } }
    });
    if (!pool) return;

    // Stop handing out new runners before tearing the old ones down, so a
    // reconcile pass racing this delete does not refill what it just emptied.
    await prisma.runnerPool.update({ where: { id: pool.id }, data: { enabled: false } });

    if (pool.jobs.length > 0) {
        try {
            const machine = await openRunnerMachine(poolServerId(pool.hostId), ownerId);
            try {
                for (const job of pool.jobs) {
                    if (!job.handle) continue;
                    await machine.reap(job.name, { isolation: job.isolation as RunnerIsolation, handle: job.handle });
                }
                // Everything this pool had is reaped above; what is left on the
                // machine belongs to other pools and is not this delete's to take.
                await machine.sweep(await liveRunnerNames(pool.hostId, pool.id));
            } finally {
                machine.close();
            }
        } catch {
            // The machine may be off, which is not a reason to keep a pool nobody
            // wants. The GitHub side below is the half that would otherwise keep
            // sending work somewhere.
        }
    }

    for (const job of pool.jobs) {
        if (job.githubRunnerId === null) continue;
        const target: RunnerTarget = {
            scope: job.targetRepo ? "repo" : "org",
            owner: job.targetOwner,
            repo: job.targetRepo ?? undefined
        };
        await deleteGithubRunner(target, job.githubRunnerId).catch(() => undefined);
    }

    await prisma.runnerPool.delete({ where: { id: pool.id } });
    await recordAudit({ actorId: ownerId, action: "runner.pool.delete", targetType: "runnerPool", targetId: poolId });
}
