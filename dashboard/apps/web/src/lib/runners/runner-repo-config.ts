/**
 * What each repository a pool serves is allowed to do with it.
 *
 * The pool decides which machine and how many runners; this decides who gets to
 * use them. They are separate because they are set by different people at
 * different times: a pool is wired up once, and "this repository may now build
 * pull requests from forks" is a decision somebody makes months later about one
 * repository, having thought about that one repository.
 *
 * Two rules hold everywhere below:
 *
 *   - A repository with no row stored gets the cautious defaults, never the
 *     permissive ones. Absence has to mean "nobody has decided", and the answer
 *     to that is no.
 *   - What GitHub says the repository is - public or private - is re-read rather
 *     than remembered. A repository can be made public long after a machine was
 *     pointed at it, and that single change turns "my team can run things here"
 *     into "anybody can".
 */

import { prisma } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { readRepoSafety, type ForkApprovalPolicy } from "@/lib/github-runners";
import {
    DEFAULT_RUNNER_REPO_POLICY,
    parseRunnerEvents,
    repoServingRefusal,
    secretsWarning,
    type RepoVisibility,
    type RunnerEvent,
    type RunnerRepoPolicy
} from "@polaris/core";

/** How long GitHub's answer about a repository is trusted before it is asked
 *  again. Short enough that turning a repository public is noticed the same
 *  hour, long enough that a fifty-repository pool is not a rate limit problem. */
const SAFETY_INTERVAL_MS = Number(process.env.POLARIS_RUNNER_SAFETY_MS) || 30 * 60_000;

/** Repositories re-checked in one pass, oldest answer first, so a large pool
 *  comes round in pieces instead of all at once. */
const SAFETY_PER_PASS = 10;

/** One repository, as the Repositories screen shows it. */
export interface RunnerRepoView {
    /** "owner/repo", or the owner for an organization-level registration. */
    key: string;
    kind: "repo" | "org";
    owner: string;
    repo: string | null;
    policy: RunnerRepoPolicy;
    visibility: RepoVisibility;
    forkApproval: ForkApprovalPolicy | null;
    /** Why nothing is running here, or null. */
    refusal: string | null;
    /** What the secrets set here are currently exposed to, or null. */
    warning: string | null;
    /** Whether this repository can have its own secrets and its own policy. An
     *  organization-level registration is one runner for every repository at
     *  once, so it cannot. */
    perRepo: boolean;
}

/** Turn a stored row (or its absence) into the policy that applies. */
export function policyOf(row: {
    events: string;
    allowForks: boolean;
    allowPublic: boolean;
    secrets: boolean;
} | null): RunnerRepoPolicy {
    if (!row) return DEFAULT_RUNNER_REPO_POLICY;
    return {
        events: parseRunnerEvents(row.events),
        allowForks: row.allowForks,
        allowPublic: row.allowPublic,
        secrets: row.secrets
    };
}

/** Every repository's policy in one pool, keyed the way targets are. */
export async function policiesForPool(poolId: string): Promise<Map<string, RunnerRepoPolicy>> {
    const rows = await prisma.runnerRepoConfig.findMany({ where: { poolId } });
    return new Map(rows.map((row) => [row.key, policyOf(row)]));
}

/** The policy for one repository of one pool. */
export async function policyFor(poolId: string, key: string): Promise<RunnerRepoPolicy> {
    const row = await prisma.runnerRepoConfig.findUnique({ where: { poolId_key: { poolId, key } } });
    return policyOf(row);
}

/**
 * Re-read what GitHub says about the repositories whose answer has gone stale,
 * and record it on the target.
 *
 * Never throws and never blocks a pass: a repository GitHub would not answer
 * about keeps whatever was last known, and a repository that has never been
 * asked stays unknown - which every caller treats as "not established", never as
 * "safe".
 */
export async function refreshRepoSafety(
    targets: readonly {
        id: string;
        kind: "repo" | "org";
        owner: string;
        repo: string | null;
        visibility: string | null;
        checkedAt: Date | null;
    }[]
): Promise<void> {
    const now = Date.now();
    const due = targets
        .filter((target) => target.kind === "repo" && target.repo)
        .filter((target) => !target.checkedAt || now - target.checkedAt.getTime() >= SAFETY_INTERVAL_MS)
        .sort((a, b) => (a.checkedAt?.getTime() ?? 0) - (b.checkedAt?.getTime() ?? 0))
        .slice(0, SAFETY_PER_PASS);

    for (const target of due) {
        const safety = await readRepoSafety(target.owner, target.repo ?? "");
        // Written back onto the row in hand as well as into the database: the pass
        // that asked for this decides what to serve a moment later, off these same
        // objects, and re-reading them would be a query to learn what was just
        // returned.
        if (safety.visibility !== null) target.visibility = safety.visibility;
        await prisma.runnerPoolTarget
            .update({
                where: { id: target.id },
                data: {
                    // Only overwrite with an answer. A GitHub outage must not turn
                    // a known-public repository into an unknown one, because the
                    // refusal that protects it is keyed on knowing.
                    ...(safety.visibility === null ? {} : { visibility: safety.visibility }),
                    ...(safety.forkApproval === null ? {} : { forkApproval: safety.forkApproval }),
                    checkedAt: new Date()
                }
            })
            .catch(() => undefined);
    }
}

/** Read a target's stored visibility back into the shape the policy expects. */
export function visibilityOf(stored: string | null): RepoVisibility {
    return stored === "public" || stored === "private" ? stored : null;
}

/**
 * Every repository of every pool the owner has, ready to be listed.
 *
 * Assembled here rather than in the page so the refusal and the warning are
 * computed in one place: they are the same sentences the machine enforces and
 * the pool card shows, and three copies of that reasoning would eventually
 * disagree about which repositories are actually being served.
 */
export async function listRunnerRepos(
    ownerId: string
): Promise<Array<{ poolId: string; poolName: string; hostName: string | null; repos: RunnerRepoView[] }>> {
    const pools = await prisma.runnerPool.findMany({
        where: { ownerId },
        include: { targets: { orderBy: { key: "asc" } }, host: { select: { name: true } } },
        orderBy: { createdAt: "asc" }
    });

    const results = [];
    for (const pool of pools) {
        const policies = await policiesForPool(pool.id);
        results.push({
            poolId: pool.id,
            poolName: pool.name,
            hostName: pool.host?.name ?? null,
            repos: pool.targets.map((target) => {
                const kind = target.kind === "org" ? ("org" as const) : ("repo" as const);
                const policy = policies.get(target.key) ?? DEFAULT_RUNNER_REPO_POLICY;
                const visibility = visibilityOf(target.visibility);
                return {
                    key: target.key,
                    kind,
                    owner: target.owner,
                    repo: target.repo,
                    policy,
                    visibility,
                    forkApproval: (target.forkApproval as ForkApprovalPolicy | null) ?? null,
                    refusal: repoServingRefusal(policy, visibility) ?? target.blocked,
                    warning: secretsWarning(policy, visibility),
                    perRepo: kind === "repo"
                };
            })
        });
    }
    return results;
}

/** Change what one repository is allowed to do, and say so in the audit log -
 *  widening what may run on somebody's machine is exactly the kind of change
 *  that has to be attributable afterwards. */
export async function setRepoPolicy(
    ownerId: string,
    input: { poolId: string; key: string; events: RunnerEvent[]; allowForks: boolean; allowPublic: boolean; secrets: boolean }
): Promise<void> {
    const pool = await prisma.runnerPool.findFirst({
        where: { id: input.poolId, ownerId },
        select: { id: true }
    });
    if (!pool) throw new Error("Pool not found");

    const target = await prisma.runnerPoolTarget.findFirst({
        where: { poolId: input.poolId, key: input.key },
        select: { id: true }
    });
    if (!target) throw new Error("This pool does not serve that repository");

    const data = {
        events: JSON.stringify(input.events),
        allowForks: input.allowForks,
        allowPublic: input.allowPublic,
        secrets: input.secrets
    };
    await prisma.runnerRepoConfig.upsert({
        where: { poolId_key: { poolId: input.poolId, key: input.key } },
        create: { poolId: input.poolId, key: input.key, ...data },
        update: data
    });

    await recordAudit({
        actorId: ownerId,
        action: "runner.repo.policy",
        targetType: "runnerPool",
        targetId: input.poolId,
        metadata: {
            repository: input.key,
            events: input.events.join(","),
            forks: input.allowForks,
            public: input.allowPublic,
            secrets: input.secrets
        }
    });
}
