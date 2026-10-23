/**
 * "Wait for CI": a push to a service that has it on is deployed only once every
 * GitHub check on that commit has finished successfully.
 *
 * Modelled on Railway's setting of the same name (docs.railway.com, "GitHub
 * autodeploys - Wait for CI"): the push is held while checks run, skipped while
 * one has failed, and deployed when they are all green. What is read is the
 * commit's check runs, latest run per name, so a re-run that turns green
 * replaces the failure it re-ran, and its commit statuses, latest per context,
 * which is how CI outside GitHub Actions (Jenkins, Buildkite, CircleCI) reports.
 * Polaris's own rows on the commit (the deploy line it writes there) are left
 * out, or it would wait for itself.
 *
 * The push waiting is a row (`DeployCiWait`, one per service), so a restart does
 * not lose it. It is settled by GitHub's check_suite / workflow_run / check_run
 * webhooks when they arrive, and by the auto-deploy poller every minute when they
 * do not, until the timeout - and a check event for that commit can still deploy
 * it after that, which is how a re-run hours later gets through.
 *
 * A commit with no checks deploys once GitHub has had a minute to register any:
 * the push event arrives before the CI it starts has reported anything at all.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as activity from "@/lib/activity/activity";
import { githubAppHandle } from "../github-service";
import { deployPushedCommit } from "./pushed-commit";
import { githubTokenForOwner } from "../github-access";

/** How long a push may wait for its checks before Polaris gives up on it. */
export const CI_WAIT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** How long after a push a commit with no checks at all is taken to have none. */
export const NO_CHECKS_GRACE_MS = 60 * 1000;
/** How often the poller re-reads a commit whose checks have not settled. */
const RECHECK_MS = 55 * 1000;
/** A deploy that was claimed and never reported back, after a crash. */
const STUCK_DEPLOYING_MS = 10 * 60 * 1000;
/** Rows settled per poll, so a backlog cannot spend the API's rate limit at once. */
const POLL_BATCH = 25;
/** Pages of check runs read per commit (100 each). */
const MAX_PAGES = 5;

const API = "https://api.github.com";

/** What `failedCheck` holds when the checks could not be read at all. */
export const UNREADABLE = "polaris:unreadable";

const SETTLEABLE = ["waiting", "failed"];

/** The part of GitHub's check-runs answer this reads. */
const checkRunsResponse = z.object({
    total_count: z.number().int().nonnegative(),
    check_runs: z.array(
        z.object({
            name: z.string().max(500),
            status: z.string(),
            conclusion: z.string().nullable().optional(),
            app: z.object({ slug: z.string().nullable().optional() }).nullable().optional()
        })
    )
});

export type CheckRun = z.infer<typeof checkRunsResponse>["check_runs"][number];

/** The part of GitHub's combined-status answer this reads. */
const combinedStatusResponse = z.object({
    statuses: z.array(
        z.object({
            context: z.string().max(500),
            state: z.string(),
            creator: z.object({ login: z.string().nullable().optional() }).nullable().optional()
        })
    )
});

export type CommitStatus = z.infer<typeof combinedStatusResponse>["statuses"][number];

/** A conclusion that passes. GitHub's own branch protection counts these. */
const PASSING = new Set(["success", "neutral", "skipped"]);

export type CiVerdict =
    | { readonly state: "green" }
    | { readonly state: "pending" }
    | { readonly state: "failed"; readonly check: string }
    | { readonly state: "unreadable" };

/**
 * What the checks on a commit say, from one read of them.
 *
 * `status` is the HTTP answer: a refusal is "unreadable" (the App or token
 * cannot read checks), any other failure "pending" so a blink retries.
 */
export function judgeChecks(input: {
    status: number;
    runs: readonly CheckRun[];
    /** The commit statuses, latest per context. */
    statuses?: readonly CommitStatus[];
    /** The App Polaris signs in as, whose own rows are not CI. */
    ownSlug: string | null;
    /** How long ago the push arrived. */
    ageMs: number;
}): CiVerdict {
    if (input.status === 401 || input.status === 403 || input.status === 404) {
        return { state: "unreadable" };
    }
    if (input.status !== 200) return { state: "pending" };
    const own = input.ownSlug?.toLowerCase() ?? null;
    const runs = input.runs.filter((run) => !own || run.app?.slug?.toLowerCase() !== own);
    const statuses = (input.statuses ?? []).filter(
        (status) => !own || status.creator?.login?.toLowerCase() !== `${own}[bot]`
    );
    const failed = runs.find(
        (run) => run.status === "completed" && !PASSING.has(run.conclusion ?? "")
    );
    if (failed) return { state: "failed", check: failed.name };
    const failedStatus = statuses.find((status) => status.state === "failure" || status.state === "error");
    if (failedStatus) return { state: "failed", check: failedStatus.context };
    if (runs.some((run) => run.status !== "completed")) return { state: "pending" };
    if (statuses.some((status) => status.state !== "success")) return { state: "pending" };
    if (runs.length === 0 && statuses.length === 0) {
        return input.ageMs >= NO_CHECKS_GRACE_MS ? { state: "green" } : { state: "pending" };
    }
    return { state: "green" };
}

/**
 * Every check run on a commit, latest per name, and its commit statuses, or the
 * status that refused the check runs. Statuses GitHub will not show are taken as
 * none, the way a repository without that kind of CI reads.
 */
export async function readCommitChecks(
    owner: string,
    repo: string,
    sha: string,
    token: string | null
): Promise<{ status: number; runs: CheckRun[]; statuses: CommitStatus[] }> {
    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "polaris"
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const checks = await readCheckRuns(owner, repo, sha, headers);
    if (checks.status !== 200) return { ...checks, statuses: [] };
    const statuses = await readCommitStatuses(owner, repo, sha, headers);
    if (statuses.status === 401 || statuses.status === 403 || statuses.status === 404) {
        return { ...checks, statuses: [] };
    }
    if (statuses.status !== 200) return { status: statuses.status, runs: [], statuses: [] };
    return { ...checks, statuses: statuses.statuses };
}

function commitUrl(owner: string, repo: string, sha: string): string {
    return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`;
}

async function readCheckRuns(
    owner: string,
    repo: string,
    sha: string,
    headers: Record<string, string>
): Promise<{ status: number; runs: CheckRun[] }> {
    const runs: CheckRun[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `${commitUrl(owner, repo, sha)}/check-runs?filter=latest&per_page=100&page=${page}`;
        let res: Response;
        try {
            res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(10_000) });
        } catch {
            return { status: 0, runs: [] };
        }
        if (res.status !== 200) return { status: res.status, runs: [] };
        const parsed = checkRunsResponse.safeParse(await res.json().catch(() => null));
        if (!parsed.success) return { status: 0, runs: [] };
        runs.push(...parsed.data.check_runs);
        if (runs.length >= parsed.data.total_count || parsed.data.check_runs.length < 100) break;
    }
    return { status: 200, runs };
}

async function readCommitStatuses(
    owner: string,
    repo: string,
    sha: string,
    headers: Record<string, string>
): Promise<{ status: number; statuses: CommitStatus[] }> {
    let res: Response;
    try {
        res = await fetch(`${commitUrl(owner, repo, sha)}/status?per_page=100`, {
            headers,
            cache: "no-store",
            signal: AbortSignal.timeout(10_000)
        });
    } catch {
        return { status: 0, statuses: [] };
    }
    if (res.status !== 200) return { status: res.status, statuses: [] };
    const parsed = combinedStatusResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) return { status: 0, statuses: [] };
    return { status: 200, statuses: parsed.data.statuses };
}

/** The service and push a hold is for. */
interface HeldApp {
    readonly id: string;
    readonly lastDeployedSha: string | null;
    readonly waitForCi?: boolean;
}

export interface PushedCommit {
    commitSha: string;
    commitMessage: string;
    authorName?: string;
    authorAvatarUrl?: string;
    /** "owner/repo". */
    repoFullName: string;
    branch: string;
}

/**
 * Hold a push until its checks pass. Idempotent: the same commit held twice is
 * one hold, and whatever state it reached is kept; a different commit replaces
 * the one waiting - a newer push to the branch supersedes it.
 */
export async function holdForCi(app: HeldApp, commit: PushedCommit): Promise<void> {
    if (!commit.commitSha) return;
    const repoFullName = commit.repoFullName.toLowerCase();
    const fresh = {
        repoFullName,
        branch: commit.branch,
        commitSha: commit.commitSha,
        commitMessage: commit.commitMessage.slice(0, 2000),
        authorName: commit.authorName ?? null,
        authorAvatarUrl: commit.authorAvatarUrl ?? null,
        status: "waiting",
        failedCheck: null,
        createdAt: new Date(),
        checkedAt: new Date()
    };
    const before = await prisma.deployCiWait.findUnique({
        where: { applicationId: app.id },
        select: { commitSha: true }
    });
    if (before?.commitSha === commit.commitSha) return;
    // One statement each, both safe to repeat: the row exists, then it holds this
    // commit unless it already did.
    await prisma.deployCiWait.upsert({
        where: { applicationId: app.id },
        create: { applicationId: app.id, ...fresh },
        update: {}
    });
    const replaced = await prisma.deployCiWait.updateMany({
        where: { applicationId: app.id, commitSha: { not: commit.commitSha } },
        data: fresh
    });
    if (before && replaced.count === 0) return;
    await activity.record({
        subjectType: "app",
        subjectId: app.id,
        action: "ci-waiting",
        fromValue: before?.commitSha ?? null,
        toValue: commit.commitSha
    });
}

/**
 * A push that reached a service: deployed now, or held for CI when the service
 * waits for it. Answers whether a deploy started.
 */
export async function deployOrHold(
    app: HeldApp,
    ownerId: string,
    commit: PushedCommit
): Promise<boolean> {
    if (!app.waitForCi) {
        return deployPushedCommit(app, ownerId, {
            commitSha: commit.commitSha,
            commitMessage: commit.commitMessage,
            ...(commit.authorName ? { authorName: commit.authorName } : {}),
            ...(commit.authorAvatarUrl ? { authorAvatarUrl: commit.authorAvatarUrl } : {})
        });
    }
    // A commit this service already runs is not waited on.
    if (app.lastDeployedSha === commit.commitSha) return false;
    await holdForCi(app, commit);
    return false;
}

const waitSelect = {
    id: true,
    applicationId: true,
    repoFullName: true,
    commitSha: true,
    commitMessage: true,
    authorName: true,
    authorAvatarUrl: true,
    status: true,
    failedCheck: true,
    createdAt: true,
    application: {
        select: {
            id: true,
            lastDeployedSha: true,
            autoDeploy: true,
            waitForCi: true,
            environment: { select: { project: { select: { ownerId: true } } } }
        }
    }
} as const;

type WaitRow = NonNullable<Awaited<ReturnType<typeof loadWait>>>;

function loadWait(id: string) {
    return prisma.deployCiWait.findUnique({ where: { id }, select: waitSelect });
}

async function note(row: WaitRow, action: string, toValue: string | null): Promise<void> {
    await activity.record({
        subjectType: "app",
        subjectId: row.applicationId,
        action,
        fromValue: row.commitSha,
        toValue
    });
}

/** Move a row on only from the state it was read in, so two settlers never both act. */
async function move(row: WaitRow, from: readonly string[], data: Record<string, unknown>): Promise<boolean> {
    const moved = await prisma.deployCiWait.updateMany({
        where: { id: row.id, commitSha: row.commitSha, status: { in: [...from] } },
        data
    });
    return moved.count > 0;
}

/** Deploy the held commit, at most once. */
async function release(row: WaitRow): Promise<boolean> {
    if (!(await move(row, [row.status], { status: "deploying", checkedAt: new Date() }))) return false;
    const app = row.application;
    try {
        const started = await deployPushedCommit(app, app.environment.project.ownerId, {
            commitSha: row.commitSha,
            commitMessage: row.commitMessage,
            ...(row.authorName ? { authorName: row.authorName } : {}),
            ...(row.authorAvatarUrl ? { authorAvatarUrl: row.authorAvatarUrl } : {})
        });
        await move(row, ["deploying"], { status: "deployed", checkedAt: new Date() });
        return started;
    } catch (error) {
        // Handed back by deployPushedCommit; the next poll tries again.
        await move(row, ["deploying"], { status: "waiting", checkedAt: new Date() });
        console.error("polaris: a deploy held for CI could not start:", error);
        return false;
    }
}

/**
 * Read the checks of one held push and act on them. `fromEvent` is GitHub saying
 * a check on this commit finished, which is allowed to revive a hold that timed
 * out. Answers whether a deploy started.
 */
export async function settleCiWait(id: string, options: { fromEvent?: boolean } = {}): Promise<boolean> {
    const row = await loadWait(id);
    if (!row) return false;
    const settleable = options.fromEvent ? [...SETTLEABLE, "expired"] : SETTLEABLE;
    if (!settleable.includes(row.status)) return false;
    const app = row.application;
    // Auto-deploy turned off while it waited: nothing to deploy any more.
    if (!app.autoDeploy) return move(row, [row.status], { status: "expired" }).then(() => false);
    // Already running this commit, or the source moved on.
    if (app.lastDeployedSha === row.commitSha) {
        await move(row, [row.status], { status: "deployed" });
        return false;
    }
    // Wait for CI turned off while it waited: it deploys the way a push would.
    if (!app.waitForCi) return release(row);

    const [owner, repo] = row.repoFullName.split("/");
    if (!owner || !repo) return false;
    const ownerId = app.environment.project.ownerId;
    const token = await githubTokenForOwner(ownerId, owner);
    const read = await readCommitChecks(owner, repo, row.commitSha, token);
    const ageMs = Date.now() - row.createdAt.getTime();
    const verdict = judgeChecks({ ...read, ownSlug: await githubAppHandle().catch(() => null), ageMs });

    if (verdict.state === "green") return release(row);
    const expired = !options.fromEvent && ageMs >= CI_WAIT_TIMEOUT_MS;
    if (expired) {
        if (await move(row, [row.status], { status: "expired", checkedAt: new Date() })) {
            await note(row, "ci-timeout", verdict.state === "failed" ? verdict.check : null);
        }
        return false;
    }
    if (verdict.state === "failed" || verdict.state === "unreadable") {
        const failedCheck = verdict.state === "failed" ? verdict.check : UNREADABLE;
        // Said once per failure, not once per poll.
        if (row.failedCheck === failedCheck && row.status !== "expired") {
            await move(row, [row.status], { checkedAt: new Date() });
            return false;
        }
        if (await move(row, [row.status], { status: "failed", failedCheck, checkedAt: new Date() })) {
            await note(row, verdict.state === "failed" ? "ci-failed" : "ci-unreadable", verdict.state === "failed" ? verdict.check : null);
        }
        return false;
    }
    await move(row, [row.status], { checkedAt: new Date() });
    return false;
}

/** A check finishing, in whichever of GitHub's three shapes it came: the commit it
 *  ran on and the repository. Only `completed` settles anything. */
const SHA = z.string().regex(/^[0-9a-f]{40}$/i);
const checkFinished = z.discriminatedUnion("event", [
    z.object({
        event: z.literal("check_suite"),
        action: z.literal("completed"),
        repository: z.object({ full_name: z.string().min(3).max(200) }),
        check_suite: z.object({ head_sha: SHA })
    }),
    z.object({
        event: z.literal("check_run"),
        action: z.literal("completed"),
        repository: z.object({ full_name: z.string().min(3).max(200) }),
        check_run: z.object({ head_sha: SHA })
    }),
    z.object({
        event: z.literal("workflow_run"),
        action: z.literal("completed"),
        repository: z.object({ full_name: z.string().min(3).max(200) }),
        workflow_run: z.object({ head_sha: SHA })
    })
]);

/** The commit a finished check ran on, or null for anything else. */
export function finishedCheckOf(
    event: string,
    payload: unknown
): { repoFullName: string; sha: string } | null {
    const parsed = checkFinished.safeParse({ ...((payload ?? {}) as object), event });
    if (!parsed.success) return null;
    const data = parsed.data;
    const sha =
        data.event === "check_suite"
            ? data.check_suite.head_sha
            : data.event === "check_run"
              ? data.check_run.head_sha
              : data.workflow_run.head_sha;
    return { repoFullName: data.repository.full_name, sha };
}

/** GitHub says a check on `sha` finished: settle every push held on it. */
export async function onChecksFinished(repoFullName: string, sha: string): Promise<number> {
    const rows = await prisma.deployCiWait.findMany({
        where: {
            repoFullName: repoFullName.toLowerCase(),
            commitSha: sha,
            status: { in: [...SETTLEABLE, "expired"] }
        },
        select: { id: true },
        take: 50
    });
    let started = 0;
    for (const row of rows) {
        try {
            if (await settleCiWait(row.id, { fromEvent: true })) started += 1;
        } catch (error) {
            console.error("polaris: a push held for CI could not be settled:", error);
        }
    }
    return started;
}

/** The poller's pass, for every webhook that never arrived. Bounded per tick. */
export async function pollCiWaits(): Promise<void> {
    const now = Date.now();
    // A claimed deploy the process died in the middle of: it either went out
    // (the service records the commit) or goes back to waiting.
    const stuck = await prisma.deployCiWait.findMany({
        where: { status: "deploying", checkedAt: { lt: new Date(now - STUCK_DEPLOYING_MS) } },
        select: { id: true, commitSha: true, application: { select: { lastDeployedSha: true } } },
        take: POLL_BATCH
    });
    for (const row of stuck) {
        await prisma.deployCiWait.updateMany({
            where: { id: row.id, status: "deploying" },
            data: {
                status: row.application.lastDeployedSha === row.commitSha ? "deployed" : "waiting",
                checkedAt: new Date()
            }
        });
    }
    const due = await prisma.deployCiWait.findMany({
        where: { status: { in: SETTLEABLE }, checkedAt: { lt: new Date(now - RECHECK_MS) } },
        orderBy: { checkedAt: "asc" },
        select: { id: true },
        take: POLL_BATCH
    });
    for (const row of due) {
        try {
            await settleCiWait(row.id);
        } catch (error) {
            console.error("polaris: a push held for CI could not be settled:", error);
        }
    }
}

/** Forget whatever a service was holding, when its source changes or goes. */
export async function dropCiWait(applicationId: string): Promise<void> {
    await prisma.deployCiWait.deleteMany({ where: { applicationId } });
}
