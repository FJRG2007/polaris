/**
 * Turning "what this pool serves" into "where its runners get registered".
 *
 * A scope is intent - one repository, a whole account, the people in a group - and
 * a target is a place GitHub will accept a runner. Only two of the scopes are the
 * same thing twice: the rest are questions for GitHub or for the user directory,
 * whose answers change without anybody editing the pool. A repository created this
 * morning should be served this afternoon, and somebody who unlinked their GitHub
 * account should stop being served entirely.
 *
 * So resolution is periodic rather than per pass. Asking GitHub for an account's
 * repositories every thirty seconds would spend the connection's rate limit on an
 * answer that changes about as often as somebody runs `gh repo create`, and the
 * rate limit is shared with everything else Polaris does with GitHub.
 *
 * What comes back is stored, because the pass after this one needs to know what
 * each target has queued and when it was last served. Targets that fall out of a
 * scope are reported rather than quietly deleted: their runners are processes on a
 * machine and rows in somebody's GitHub account, and somebody has to stand them
 * down.
 */

import { prisma } from "@polaris/db";
import { listReposForOwner } from "@/lib/github-service";
import { parseStoredScope, targetKey } from "./runner-scope";
import { githubLoginsForGroup, githubLoginsForUsers } from "@/lib/github-identity";
import { MAX_RUNNER_TARGETS, type RunnerScopeInput, type RunnerTargetKind } from "@polaris/core";

export { parseStoredScope, targetKey };

/** How long a resolved target list is trusted before it is asked for again. */
const RESOLVE_INTERVAL_MS = Number(process.env.POLARIS_RUNNER_RESOLVE_MS) || 10 * 60_000;

/** One place a pool registers runners. */
export interface ResolvedTarget {
    /** "owner/repo", or "owner" for an organization registration. */
    readonly key: string;
    readonly kind: RunnerTargetKind;
    readonly owner: string;
    readonly repo: string | null;
}

export interface TargetResolution {
    readonly targets: readonly ResolvedTarget[];
    /** What the operator should know about the answer: a scope that resolved to
     *  nothing, or one that resolved to more than a pool may serve. Null when
     *  there is nothing to say. */
    readonly note: string | null;
}

/** Every repository of an account, as one target each. */
async function reposOf(owner: string): Promise<ResolvedTarget[]> {
    const repos = await listReposForOwner(owner);
    return repos.map((repo) => {
        const [login, name] = repo.fullName.split("/");
        return { key: repo.fullName, kind: "repo" as const, owner: login ?? owner, repo: name ?? "" };
    });
}

/** Resolve a scope without touching what is stored. Exported for the pool form,
 *  which shows what a scope will actually come to before it is saved. */
export async function resolveScope(scope: RunnerScopeInput): Promise<TargetResolution> {
    const targets = await gather(scope);
    const deduped = dedupe(targets);
    if (deduped.length === 0) return { targets: [], note: emptyNote(scope) };
    if (deduped.length > MAX_RUNNER_TARGETS) {
        return {
            targets: deduped.slice(0, MAX_RUNNER_TARGETS),
            note: `This resolves to ${deduped.length} repositories; the ${MAX_RUNNER_TARGETS} most recently pushed are served.`
        };
    }
    return { targets: deduped, note: null };
}

async function gather(scope: RunnerScopeInput): Promise<ResolvedTarget[]> {
    switch (scope.kind) {
        case "repo":
            return [{ key: targetKey(scope.owner, scope.repo), kind: "repo", owner: scope.owner, repo: scope.repo }];
        case "org":
            return [{ key: scope.owner, kind: "org", owner: scope.owner, repo: null }];
        case "repos":
            return scope.repos.map((entry) => ({
                key: targetKey(entry.owner, entry.repo),
                kind: "repo" as const,
                owner: entry.owner,
                repo: entry.repo
            }));
        case "account":
            return reposOf(scope.owner);
        case "users": {
            const linked = await githubLoginsForUsers(scope.userIds);
            return (await Promise.all(linked.map((account) => reposOf(account.login)))).flat();
        }
        case "group": {
            const linked = await githubLoginsForGroup(scope.groupId);
            return (await Promise.all(linked.map((account) => reposOf(account.login)))).flat();
        }
    }
}

/** Two people in a group can be collaborators on the same repository, and a
 *  picked list can repeat one. Serving it twice would be two registrations
 *  competing for the same jobs. */
function dedupe(targets: readonly ResolvedTarget[]): ResolvedTarget[] {
    const seen = new Map<string, ResolvedTarget>();
    for (const target of targets) {
        const key = target.key.toLowerCase();
        if (!seen.has(key)) seen.set(key, target);
    }
    return [...seen.values()];
}

/** Why a scope came to nothing, in the terms of the thing that was asked for. */
function emptyNote(scope: RunnerScopeInput): string {
    switch (scope.kind) {
        case "account":
            return `Polaris cannot see any repositories on ${scope.owner}. Check the GitHub App is installed there.`;
        case "users":
            return "None of the people chosen have linked a GitHub account yet, so there is nothing to serve.";
        case "group":
            return "Nobody in that group has linked a GitHub account yet, so there is nothing to serve.";
        default:
            return "This scope resolves to no repositories.";
    }
}

export interface SyncedTargets {
    /** Every target the pool serves now, as stored. */
    readonly targets: Array<{
        id: string;
        key: string;
        kind: RunnerTargetKind;
        owner: string;
        repo: string | null;
        queued: number;
        /** When the queued count was last refreshed. Carried through because it is
         *  what stops the demand poll asking GitHub again on the very next pass. */
        queuedAt: Date | null;
        lastServedAt: Date | null;
        blocked: string | null;
    }>;
    /** Targets that were being served and are not any more, so whatever they have
     *  running can be stood down. */
    readonly dropped: ResolvedTarget[];
    readonly note: string | null;
}

/**
 * Bring a pool's stored targets in line with its scope, re-resolving only when the
 * last answer has gone stale.
 *
 * A pool whose scope names its targets outright (one repository, one organization,
 * a list that was picked) is resolved every time, because doing so costs nothing
 * and is always right.
 */
export async function syncPoolTargets(
    pool: { id: string; scope: string; scopeConfig: string; targetsResolvedAt: Date | null },
    options: { force?: boolean } = {}
): Promise<SyncedTargets> {
    const stored = await prisma.runnerPoolTarget.findMany({ where: { poolId: pool.id } });
    const scope = parseStoredScope(pool.scope, pool.scopeConfig);
    if (!scope) {
        return {
            targets: stored.map(asView),
            dropped: [],
            note: "This pool's scope could not be read, so it is serving whatever it last resolved to."
        };
    }

    const fresh =
        pool.targetsResolvedAt !== null && Date.now() - pool.targetsResolvedAt.getTime() < RESOLVE_INTERVAL_MS;
    const cheap = scope.kind === "repo" || scope.kind === "org" || scope.kind === "repos";
    if (!options.force && fresh && !cheap) return { targets: stored.map(asView), dropped: [], note: null };

    const resolution = await resolveScope(scope);
    const wanted = new Map(resolution.targets.map((target) => [target.key, target]));
    const dropped = stored.filter((row) => !wanted.has(row.key));

    // A scope that momentarily resolves to nothing - GitHub answering 502, an
    // installation being repaired - would otherwise tear down every runner the
    // pool has. Keep what is there and say why.
    if (resolution.targets.length === 0 && stored.length > 0) {
        return { targets: stored.map(asView), dropped: [], note: resolution.note };
    }

    for (const target of resolution.targets) {
        await prisma.runnerPoolTarget.upsert({
            where: { poolId_key: { poolId: pool.id, key: target.key } },
            create: {
                poolId: pool.id,
                key: target.key,
                kind: target.kind,
                owner: target.owner,
                repo: target.repo
            },
            update: { kind: target.kind, owner: target.owner, repo: target.repo }
        });
    }
    if (dropped.length > 0) {
        await prisma.runnerPoolTarget.deleteMany({ where: { id: { in: dropped.map((row) => row.id) } } });
    }
    await prisma.runnerPool.update({ where: { id: pool.id }, data: { targetsResolvedAt: new Date() } });

    const current = await prisma.runnerPoolTarget.findMany({ where: { poolId: pool.id } });
    return { targets: current.map(asView), dropped: dropped.map(asResolved), note: resolution.note };
}

function asView(row: {
    id: string;
    key: string;
    kind: string;
    owner: string;
    repo: string | null;
    queued: number;
    queuedAt: Date | null;
    lastServedAt: Date | null;
    blocked: string | null;
}): SyncedTargets["targets"][number] {
    return {
        id: row.id,
        key: row.key,
        kind: row.kind === "org" ? "org" : "repo",
        owner: row.owner,
        repo: row.repo,
        queued: row.queued,
        queuedAt: row.queuedAt,
        lastServedAt: row.lastServedAt,
        blocked: row.blocked
    };
}

function asResolved(row: { key: string; kind: string; owner: string; repo: string | null }): ResolvedTarget {
    return { key: row.key, kind: row.kind === "org" ? "org" : "repo", owner: row.owner, repo: row.repo };
}
