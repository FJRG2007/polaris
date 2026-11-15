/**
 * Ported from backend/internal/adapters/scm/github/provider.go (the
 * observation query and its projection) and backend/internal/observe/scm
 * (the refresh cadence) of Agent Orchestrator (Apache-2.0, commit
 * e4ded08c6f15). See docs/scm-observer.md there.
 *
 * The pull request facts a Code session's derived status reads
 * (`session-status.ts`), kept in `SessionPullFacts`.
 *
 * Two ways in, one projection. The GitHub App's webhook says *that* something
 * changed on a pull request; it never carries the aggregates the status needs
 * (GitHub's review decision, the rollup of every check, unresolved threads), so
 * every write re-reads the pull request with one GraphQL query and projects it
 * here. A poll does the same for open pull requests no webhook refreshed lately:
 * an instance without a public address gets no webhooks at all.
 *
 * The invariants kept from the source:
 *   - A failed read writes nothing. A partial answer is never stored as a fact,
 *     so a GitHub hiccup cannot turn an open pull request closed.
 *   - Only the newest run of each check counts: a run a re-run superseded on the
 *     same commit is dropped, as GitHub's own checks list does.
 *   - A cancelled check proves nothing, so with nothing else running it settles
 *     the CI verdict as unknown rather than passing.
 *   - More checks than one page holds can hide a failure, so anything short of
 *     a failure degrades to unknown.
 *
 * Not ported: the REST read the source uses as a tie-breaker while GitHub has
 * not computed `mergeStateStatus` yet (the poll asks again five minutes later
 * instead), and the job-log reading that tells a "failure" caused by a cancelled
 * gate from a real one.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import type * as status from "@/lib/agents/session-status";
import { githubAppInstallationToken } from "@/lib/github-service";

const GRAPHQL_URL = "https://api.github.com/graphql";

/** The most check contexts asked for in one query: GitHub's page maximum. */
const CHECK_CONTEXT_LIMIT = 100;
/** Review threads read per pull request, newest last, as the source does. */
const REVIEW_THREAD_LIMIT = 100;
/** How many comment authors of a thread are read to tell a bot's from a person's. */
const THREAD_COMMENT_LIMIT = 20;

/** The poll's cadence knobs: refreshed when older than this, at most this many
 *  per pass, and only for sessions that ended recently or have not. */
export const POLL_MAX_AGE_MS = 5 * 60_000;
export const POLL_BATCH = 25;
const POLL_ENDED_WITHIN_MS = 14 * 24 * 60 * 60_000;
/** A session that recorded a pull request but has no facts row yet is picked up
 *  by the poll only while it is this recent. */
const POLL_UNSEEN_WITHIN_MS = 30 * 24 * 60 * 60_000;
/** The most refreshes one webhook delivery may start. */
const WEBHOOK_REFRESH_CAP = 10;
const FETCH_TIMEOUT_MS = 10_000;

const PULL_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      number
      url
      state
      isDraft
      merged
      closed
      mergeable
      mergeStateStatus
      reviewDecision
      headRefOid
      headRefName
      baseRefName
      commits(last:1){ nodes{ commit{
        statusCheckRollup{
          state
          contexts(first:${CHECK_CONTEXT_LIMIT}){
            nodes{
              __typename
              ... on CheckRun { name status conclusion databaseId checkSuite{ workflowRun{ event workflow{ name } } } }
              ... on StatusContext { context state }
            }
            pageInfo{ hasNextPage }
          }
        }
      } } }
      reviewThreads(last:${REVIEW_THREAD_LIMIT}){ nodes{
        isResolved
        comments(first:${THREAD_COMMENT_LIMIT}){ nodes{ author{ login __typename } } }
      } }
    }
  }
}`;

// ---------------------------------------------------------------------------
// The GraphQL answer, validated
// ---------------------------------------------------------------------------

const str = z.string().max(2_000);
const optStr = str.nullish();

const contextNode = z.object({
    __typename: str,
    name: optStr,
    status: optStr,
    conclusion: optStr,
    databaseId: z.number().nullish(),
    checkSuite: z
        .object({
            workflowRun: z
                .object({ event: optStr, workflow: z.object({ name: optStr }).nullish() })
                .nullish()
        })
        .nullish(),
    context: optStr,
    state: optStr
});
export type ContextNode = z.infer<typeof contextNode>;

const pullNode = z.object({
    number: z.number().int().positive(),
    url: str,
    state: str,
    isDraft: z.boolean(),
    merged: z.boolean(),
    closed: z.boolean(),
    mergeable: optStr,
    mergeStateStatus: optStr,
    reviewDecision: optStr,
    headRefOid: optStr,
    headRefName: optStr,
    baseRefName: optStr,
    commits: z
        .object({
            nodes: z
                .array(
                    z
                        .object({
                            commit: z.object({
                                statusCheckRollup: z
                                    .object({
                                        state: optStr,
                                        contexts: z
                                            .object({
                                                nodes: z.array(contextNode.nullable()).max(CHECK_CONTEXT_LIMIT),
                                                pageInfo: z.object({ hasNextPage: z.boolean() }).nullish()
                                            })
                                            .nullish()
                                    })
                                    .nullish()
                            })
                        })
                        .nullable()
                )
                .max(1)
        })
        .nullish(),
    reviewThreads: z
        .object({
            nodes: z
                .array(
                    z
                        .object({
                            isResolved: z.boolean(),
                            comments: z
                                .object({
                                    nodes: z
                                        .array(
                                            z
                                                .object({
                                                    author: z
                                                        .object({ login: optStr, __typename: optStr })
                                                        .nullish()
                                                })
                                                .nullable()
                                        )
                                        .max(THREAD_COMMENT_LIMIT)
                                })
                                .nullish()
                        })
                        .nullable()
                )
                .max(REVIEW_THREAD_LIMIT)
        })
        .nullish()
});
export type PullNode = z.infer<typeof pullNode>;

const graphqlAnswer = z.object({
    data: z
        .object({
            repository: z.object({ pullRequest: pullNode.nullable() }).nullable()
        })
        .nullish(),
    errors: z.array(z.object({ type: optStr, message: optStr })).max(50).nullish()
});

// ---------------------------------------------------------------------------
// Projection (pure)
// ---------------------------------------------------------------------------

/** One pull request as the store keeps it. */
export interface PullObservation {
    number: number;
    url: string;
    state: "open" | "closed" | "merged";
    draft: boolean;
    mergeable: status.Mergeability;
    checks: status.CiState;
    checksTotal: number;
    checksFailed: number;
    checksPending: number;
    review: status.ReviewDecision;
    unresolvedComments: number;
    headSha: string;
    sourceBranch: string;
    targetBranch: string;
}

type CheckVerdict = "passed" | "failed" | "cancelled" | "skipped" | "queued" | "running" | "unknown";

const upper = (value: string | null | undefined): string => (value ?? "").trim().toUpperCase();

/** One check context's verdict. A failure-class conclusion always wins over a
 *  status that still reads pending. */
export function checkVerdict(node: ContextNode): CheckVerdict {
    if (node.__typename === "StatusContext") {
        switch (upper(node.state)) {
            case "SUCCESS":
                return "passed";
            case "FAILURE":
            case "ERROR":
                return "failed";
            case "PENDING":
            case "EXPECTED":
                return "running";
            default:
                return "unknown";
        }
    }
    switch (upper(node.conclusion)) {
        case "SUCCESS":
        case "NEUTRAL":
            return "passed";
        case "FAILURE":
        case "TIMED_OUT":
        case "ACTION_REQUIRED":
        case "STARTUP_FAILURE":
            return "failed";
        case "CANCELLED":
            return "cancelled";
        case "SKIPPED":
        case "STALE":
            return "skipped";
    }
    switch (upper(node.status)) {
        case "QUEUED":
        case "PENDING":
        case "REQUESTED":
        case "WAITING":
            return "queued";
        case "IN_PROGRESS":
            return "running";
        default:
            // Completed without a conclusion is reachable and proves nothing.
            return "unknown";
    }
}

function checkRunKey(node: ContextNode): string | null {
    if (node.__typename !== "CheckRun") return null;
    const run = node.checkSuite?.workflowRun;
    if (!run?.workflow) return null;
    return [run.workflow.name ?? "", run.event ?? "", node.name ?? ""].join("\u0000");
}

/** Drops check runs a newer run of the same check superseded on this commit.
 *  Run ids grow, so the highest is the newest. A run whose workflow cannot be
 *  read (another app's) is always kept: it cannot be matched to its re-runs. */
export function latestCheckRuns(nodes: readonly ContextNode[]): ContextNode[] {
    const newest = new Map<string, number>();
    for (const node of nodes) {
        const key = checkRunKey(node);
        if (key !== null) newest.set(key, Math.max(newest.get(key) ?? 0, node.databaseId ?? 0));
    }
    return nodes.filter((node) => {
        const key = checkRunKey(node);
        return key === null || (node.databaseId ?? 0) >= (newest.get(key) ?? 0);
    });
}

function rollupState(value: string | null | undefined): status.CiState {
    switch (upper(value)) {
        case "SUCCESS":
            return "passing";
        case "FAILURE":
        case "ERROR":
            return "failing";
        case "PENDING":
        case "EXPECTED":
            return "pending";
        default:
            return "unknown";
    }
}

/** The CI verdict and counts of the head commit's checks. */
export function ciSummary(pull: PullNode): Pick<
    PullObservation,
    "checks" | "checksTotal" | "checksFailed" | "checksPending"
> {
    const rollup = pull.commits?.nodes[0]?.commit.statusCheckRollup;
    if (!rollup) return { checks: "unknown", checksTotal: 0, checksFailed: 0, checksPending: 0 };
    const nodes = latestCheckRuns(
        (rollup.contexts?.nodes ?? []).filter((node): node is ContextNode => node !== null)
    );
    if (nodes.length === 0) {
        // GitHub still gives the rollup's own state when the list is empty.
        return { checks: rollupState(rollup.state), checksTotal: 0, checksFailed: 0, checksPending: 0 };
    }
    let failed = 0;
    let pending = 0;
    let passing = false;
    let cancelled = false;
    for (const node of nodes) {
        const verdict = checkVerdict(node);
        if (verdict === "failed") failed++;
        else if (verdict === "queued" || verdict === "running") pending++;
        else if (verdict === "passed") passing = true;
        else if (verdict === "cancelled") cancelled = true;
    }
    const counts = { checksTotal: nodes.length, checksFailed: failed, checksPending: pending };
    // A failure never un-fails on the next page; anything else might be hiding one.
    if (failed > 0) return { checks: "failing", ...counts };
    if (rollup.contexts?.pageInfo?.hasNextPage) return { checks: "unknown", ...counts };
    if (pending > 0) return { checks: "pending", ...counts };
    if (cancelled) return { checks: "unknown", ...counts };
    if (passing) return { checks: "passing", ...counts };
    return { checks: "unknown", ...counts };
}

export function reviewDecision(value: string | null | undefined): status.ReviewDecision {
    switch (upper(value)) {
        case "APPROVED":
            return "approved";
        case "CHANGES_REQUESTED":
            return "changes_requested";
        case "REVIEW_REQUIRED":
            return "review_required";
        default:
            return "none";
    }
}

/** Whether the pull request can be merged, first matching rule wins. */
export function mergeability(
    pull: Pick<PullNode, "mergeStateStatus" | "mergeable" | "isDraft">,
    ci: status.CiState,
    review: status.ReviewDecision
): status.Mergeability {
    const state = upper(pull.mergeStateStatus);
    const raw = upper(pull.mergeable);
    if (state === "DIRTY") return "conflicting";
    if (state === "BLOCKED") return "blocked";
    if (state === "UNSTABLE") return "unstable";
    if (raw === "CONFLICTING") return "conflicting";
    if (pull.isDraft) return "blocked";
    if (review === "changes_requested" || review === "review_required") return "blocked";
    if (ci === "failing") return "blocked";
    if (raw === "MERGEABLE" && state === "CLEAN") return "mergeable";
    return "unknown";
}

/** Unresolved threads with at least one comment a person (not a bot) wrote. */
export function unresolvedThreads(pull: PullNode): number {
    let count = 0;
    for (const thread of pull.reviewThreads?.nodes ?? []) {
        if (!thread || thread.isResolved) continue;
        const human = (thread.comments?.nodes ?? []).some(
            (comment) => comment?.author && comment.author.__typename !== "Bot"
        );
        if (human) count++;
    }
    return count;
}

/** The whole projection of one GraphQL pull request node. */
export function observationFrom(pull: PullNode): PullObservation {
    const ci = ciSummary(pull);
    const review = reviewDecision(pull.reviewDecision);
    const merged = pull.merged || upper(pull.state) === "MERGED";
    const closed = !merged && (pull.closed || upper(pull.state) === "CLOSED");
    return {
        number: pull.number,
        url: pull.url,
        state: merged ? "merged" : closed ? "closed" : "open",
        draft: pull.isDraft,
        mergeable: mergeability(pull, ci.checks, review),
        ...ci,
        review,
        unresolvedComments: unresolvedThreads(pull),
        headSha: pull.headRefOid ?? "",
        sourceBranch: pull.headRefName ?? "",
        targetBranch: pull.baseRefName ?? ""
    };
}

/** The columns of a stored row the status reads. */
export interface PullFactsRow {
    url: string;
    state: string;
    draft: boolean;
    mergeable: string;
    checks: string;
    review: string;
    unresolvedComments: number;
    sourceBranch: string;
    targetBranch: string;
}

const pick = <T extends string>(options: readonly T[], value: string, fallback: T): T =>
    (options as readonly string[]).includes(value) ? (value as T) : fallback;

const CI_STATES = ["unknown", "pending", "passing", "failing"] as const;
const REVIEW_DECISIONS = ["none", "approved", "changes_requested", "review_required"] as const;
const MERGEABILITIES = ["unknown", "mergeable", "conflicting", "blocked", "unstable"] as const;

/** A stored row as the facts `deriveSessionStatus` takes. An unknown stored
 *  word reads as the neutral value rather than throwing: rows outlive builds. */
export function pullFactsOf(row: PullFactsRow): status.PullFacts {
    return {
        url: row.url,
        draft: row.draft,
        merged: row.state === "merged",
        closed: row.state === "closed",
        ci: pick(CI_STATES, row.checks, "unknown"),
        review: pick(REVIEW_DECISIONS, row.review, "none"),
        mergeability: pick(MERGEABILITIES, row.mergeable, "unknown"),
        reviewComments: row.unresolvedComments > 0,
        sourceBranch: row.sourceBranch,
        targetBranch: row.targetBranch
    };
}

export const PULL_FACTS_SELECT = {
    sessionId: true,
    url: true,
    state: true,
    draft: true,
    mergeable: true,
    checks: true,
    review: true,
    unresolvedComments: true,
    sourceBranch: true,
    targetBranch: true
} as const;

/** The most sessions one read asks facts for: a page of a board or a list. */
const READ_CAP = 200;

/** The pull request facts of a page of sessions, keyed by session id. */
export async function readSessionPullFacts(
    sessionIds: readonly string[]
): Promise<Map<string, status.PullFacts[]>> {
    const ids = [...new Set(sessionIds)].slice(0, READ_CAP);
    const out = new Map<string, status.PullFacts[]>();
    if (ids.length === 0) return out;
    const rows = await prisma.sessionPullFacts.findMany({
        where: { sessionId: { in: ids } },
        select: PULL_FACTS_SELECT,
        // Bounded by the ids: a session has a handful of pull requests at most,
        // and the cap keeps a pathological one from filling the page.
        take: ids.length * 10
    });
    for (const row of rows) {
        const list = out.get(row.sessionId) ?? [];
        list.push(pullFactsOf(row));
        out.set(row.sessionId, list);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Reading GitHub
// ---------------------------------------------------------------------------

export type FetchOutcome =
    | { kind: "ok"; observation: PullObservation }
    /** GitHub has no such pull request, or the token cannot see it. */
    | { kind: "missing" }
    /** Out of quota: the caller stops asking for this pass. */
    | { kind: "limited" }
    /** Anything else. Nothing is written. */
    | { kind: "failed" };

/** Reads one pull request. Never throws. */
export async function fetchPullObservation(
    owner: string,
    repo: string,
    number: number,
    token: string,
    fetchImpl: typeof fetch = fetch
): Promise<FetchOutcome> {
    let res: Response;
    try {
        res = await fetchImpl(GRAPHQL_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": "polaris"
            },
            body: JSON.stringify({ query: PULL_QUERY, variables: { owner, repo, number } }),
            cache: "no-store",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
    } catch {
        return { kind: "failed" };
    }
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0"))
        return { kind: "limited" };
    if (!res.ok) return { kind: "failed" };
    let body: unknown;
    try {
        body = await res.json();
    } catch {
        return { kind: "failed" };
    }
    const parsed = graphqlAnswer.safeParse(body);
    if (!parsed.success) return { kind: "failed" };
    const errors = parsed.data.errors ?? [];
    if (errors.some((error) => error.type === "RATE_LIMITED")) return { kind: "limited" };
    const pull = parsed.data.data?.repository?.pullRequest;
    if (errors.some((error) => error.type === "NOT_FOUND")) return { kind: "missing" };
    // Any other error means a partial answer, which is never stored as a fact.
    if (errors.length > 0) return { kind: "failed" };
    if (!pull) return { kind: "missing" };
    return { kind: "ok", observation: observationFrom(pull) };
}

/** Stores one observation for a session. */
export async function writePullFacts(
    sessionId: string,
    repoFullName: string,
    observation: PullObservation,
    now: Date = new Date()
): Promise<void> {
    const data = {
        repoFullName,
        url: observation.url,
        state: observation.state,
        draft: observation.draft,
        mergeable: observation.mergeable,
        checks: observation.checks,
        checksTotal: observation.checksTotal,
        checksFailed: observation.checksFailed,
        checksPending: observation.checksPending,
        review: observation.review,
        unresolvedComments: observation.unresolvedComments,
        headSha: observation.headSha,
        sourceBranch: observation.sourceBranch,
        targetBranch: observation.targetBranch,
        fetchedAt: now
    };
    await prisma.sessionPullFacts.upsert({
        where: { sessionId_number: { sessionId, number: observation.number } },
        create: { sessionId, number: observation.number, ...data },
        update: data
    });
}

export interface RefreshTarget {
    sessionId: string;
    repoFullName: string;
    number: number;
}

export interface RefreshDeps {
    token: (owner: string) => Promise<string | null>;
    fetch: (owner: string, repo: string, number: number, token: string) => Promise<FetchOutcome>;
    write: (target: RefreshTarget, observation: PullObservation) => Promise<void>;
}

const defaultRefreshDeps: RefreshDeps = {
    token: (owner) => githubAppInstallationToken(owner).catch(() => null),
    fetch: (owner, repo, number, token) => fetchPullObservation(owner, repo, number, token),
    write: (target, observation) => writePullFacts(target.sessionId, target.repoFullName, observation)
};

/** Refreshes targets one at a time, one token per owner, stopping at the first
 *  sign of an exhausted quota. Returns how many were written. */
export async function refreshPullFacts(
    targets: readonly RefreshTarget[],
    deps: RefreshDeps = defaultRefreshDeps
): Promise<{ written: number; limited: boolean }> {
    const tokens = new Map<string, string | null>();
    let written = 0;
    for (const target of targets) {
        const [owner, repo] = target.repoFullName.split("/");
        if (!owner || !repo) continue;
        if (!tokens.has(owner)) tokens.set(owner, await deps.token(owner));
        const token = tokens.get(owner);
        if (!token) continue;
        const outcome = await deps.fetch(owner, repo, target.number, token);
        if (outcome.kind === "limited") return { written, limited: true };
        if (outcome.kind !== "ok") continue;
        // The number asked for is the one stored, whatever the answer says.
        if (outcome.observation.number !== target.number) continue;
        try {
            await deps.write(target, outcome.observation);
            written++;
        } catch (error) {
            console.error("polaris: pull request facts could not be stored:", error);
        }
    }
    return { written, limited: false };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

const repoFullName = z.string().regex(/^[\w.-]{1,100}\/[\w.-]{1,100}$/);
const branchName = z.string().min(1).max(255);
const prNumber = z.number().int().positive();
const pullRefs = z.array(z.object({ number: prNumber })).max(50);

const pullRequestShaped = z.object({
    repository: z.object({ full_name: repoFullName }),
    pull_request: z.object({ number: prNumber, head: z.object({ ref: branchName }) })
});

/** The events that change a pull request's facts, each with the one shape it
 *  is read through. Named rather than inferred, like the Agents app's own. */
const WEBHOOK_SHAPES = {
    pull_request: pullRequestShaped,
    pull_request_review: pullRequestShaped,
    pull_request_review_comment: pullRequestShaped,
    pull_request_review_thread: pullRequestShaped,
    check_suite: z.object({
        repository: z.object({ full_name: repoFullName }),
        check_suite: z.object({ head_branch: branchName.nullish(), pull_requests: pullRefs.nullish() })
    }),
    check_run: z.object({
        repository: z.object({ full_name: repoFullName }),
        check_run: z.object({
            check_suite: z.object({ head_branch: branchName.nullish() }).nullish(),
            pull_requests: pullRefs.nullish()
        })
    })
} as const;

export type PullFactEvent = keyof typeof WEBHOOK_SHAPES;

export function isPullFactEvent(event: string): event is PullFactEvent {
    return Object.hasOwn(WEBHOOK_SHAPES, event);
}

/** What a delivery names: a repository, pull request numbers, head branches. */
export interface WebhookSubject {
    repoFullName: string;
    numbers: number[];
    branches: string[];
}

/** Reads a delivery through its event's shape, or null when it does not fit. */
export function webhookSubject(event: PullFactEvent, payload: unknown): WebhookSubject | null {
    if (event === "check_suite") {
        const parsed = WEBHOOK_SHAPES.check_suite.safeParse(payload);
        if (!parsed.success) return null;
        const suite = parsed.data.check_suite;
        return {
            repoFullName: parsed.data.repository.full_name,
            numbers: (suite.pull_requests ?? []).map((ref) => ref.number),
            branches: suite.head_branch ? [suite.head_branch] : []
        };
    }
    if (event === "check_run") {
        const parsed = WEBHOOK_SHAPES.check_run.safeParse(payload);
        if (!parsed.success) return null;
        const run = parsed.data.check_run;
        const branch = run.check_suite?.head_branch;
        return {
            repoFullName: parsed.data.repository.full_name,
            numbers: (run.pull_requests ?? []).map((ref) => ref.number),
            branches: branch ? [branch] : []
        };
    }
    const parsed = WEBHOOK_SHAPES[event].safeParse(payload);
    if (!parsed.success) return null;
    return {
        repoFullName: parsed.data.repository.full_name,
        numbers: [parsed.data.pull_request.number],
        branches: [parsed.data.pull_request.head.ref]
    };
}

/** The sessions a delivery concerns and the pull request of each, as a
 *  session row would match it. A pull request opened from a session's own
 *  branch is that session's even when somebody opened it on GitHub. */
export function targetsFor(
    subject: WebhookSubject,
    sessions: ReadonlyArray<{ id: string; prNumber: number | null; branch: string }>
): RefreshTarget[] {
    const seen = new Set<string>();
    const out: RefreshTarget[] = [];
    const add = (sessionId: string, number: number) => {
        const key = `${sessionId}:${number}`;
        if (seen.has(key) || out.length >= WEBHOOK_REFRESH_CAP) return;
        seen.add(key);
        out.push({ sessionId, repoFullName: subject.repoFullName, number });
    };
    for (const session of sessions) {
        const byBranch = subject.branches.includes(session.branch);
        if (session.prNumber !== null && subject.numbers.includes(session.prNumber)) {
            add(session.id, session.prNumber);
        } else if (byBranch && subject.numbers.length === 1) {
            add(session.id, subject.numbers[0]!);
        } else if (byBranch && session.prNumber !== null) {
            // A check on the branch with no pull request named (GitHub leaves the
            // list empty for some suites): the session's own pull request.
            add(session.id, session.prNumber);
        }
    }
    return out;
}

/** Refreshes in flight, so a burst of deliveries about one pull request (a
 *  review fires a review event and one per comment) becomes one read, plus one
 *  more after it if something arrived while it ran. */
const inFlight = new Map<string, { again: boolean }>();

async function refreshCoalesced(target: RefreshTarget, deps: RefreshDeps): Promise<void> {
    const key = `${target.sessionId}:${target.number}`;
    const running = inFlight.get(key);
    if (running) {
        running.again = true;
        return;
    }
    const entry = { again: false };
    inFlight.set(key, entry);
    try {
        do {
            entry.again = false;
            const { limited } = await refreshPullFacts([target], deps);
            if (limited) break;
        } while (entry.again);
    } finally {
        inFlight.delete(key);
    }
}

/**
 * The webhook's part: find the sessions a delivery concerns and refresh their
 * pull request facts. Returns how many refreshes it started; the refreshes
 * themselves are not awaited by the route, which has ten seconds to answer.
 */
export async function onPullFactWebhook(
    event: PullFactEvent,
    payload: unknown,
    deps: RefreshDeps = defaultRefreshDeps
): Promise<Promise<void>[]> {
    const subject = webhookSubject(event, payload);
    if (!subject || (subject.numbers.length === 0 && subject.branches.length === 0)) return [];
    const or = [
        ...(subject.numbers.length ? [{ prNumber: { in: subject.numbers } }] : []),
        ...(subject.branches.length ? [{ branch: { in: subject.branches } }] : [])
    ];
    const sessions = await prisma.agentSession.findMany({
        where: { repo: { repoFullName: subject.repoFullName }, OR: or },
        select: { id: true, prNumber: true, branch: true },
        orderBy: { createdAt: "desc" },
        take: WEBHOOK_REFRESH_CAP
    });
    const targets = targetsFor(subject, sessions);
    // A pull request opened from a session's branch on GitHub becomes the one
    // the session links, the same as one opened from the session itself.
    if (event === "pull_request") {
        for (const target of targets) {
            const session = sessions.find((one) => one.id === target.sessionId);
            if (session && session.prNumber === null) {
                await prisma.agentSession.updateMany({
                    where: { id: session.id, prNumber: null },
                    data: {
                        prNumber: target.number,
                        prUrl: `https://github.com/${subject.repoFullName}/pull/${target.number}`
                    }
                });
            }
        }
    }
    return targets.map((target) => refreshCoalesced(target, deps));
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

/**
 * The fallback for what no webhook refreshed: open pull requests whose facts
 * are older than five minutes, then sessions that recorded a pull request and
 * have no facts yet. At most `POLL_BATCH` reads a pass, stalest first, and a
 * pass stops at the first sign GitHub's quota is spent - the next pass, five
 * minutes on, starts with the same stalest rows. A pull request a webhook keeps
 * fresh is never polled.
 */
export async function pollPullFacts(
    now: Date = new Date(),
    deps: RefreshDeps = defaultRefreshDeps
): Promise<{ asked: number; written: number; limited: boolean }> {
    const stale = await prisma.sessionPullFacts.findMany({
        where: {
            state: "open",
            fetchedAt: { lt: new Date(now.getTime() - POLL_MAX_AGE_MS) },
            session: {
                OR: [
                    { finishedAt: null },
                    { finishedAt: { gt: new Date(now.getTime() - POLL_ENDED_WITHIN_MS) } }
                ]
            }
        },
        select: { sessionId: true, repoFullName: true, number: true },
        orderBy: { fetchedAt: "asc" },
        take: POLL_BATCH
    });
    const targets: RefreshTarget[] = [...stale];
    if (targets.length < POLL_BATCH) {
        const unseen = await prisma.agentSession.findMany({
            where: {
                prNumber: { not: null },
                repoId: { not: null },
                createdAt: { gt: new Date(now.getTime() - POLL_UNSEEN_WITHIN_MS) },
                pullFacts: { none: {} }
            },
            select: { id: true, prNumber: true, repo: { select: { repoFullName: true } } },
            orderBy: { createdAt: "desc" },
            take: POLL_BATCH - targets.length
        });
        for (const session of unseen) {
            if (session.prNumber === null || !session.repo) continue;
            targets.push({
                sessionId: session.id,
                repoFullName: session.repo.repoFullName,
                number: session.prNumber
            });
        }
    }
    const { written, limited } = await refreshPullFacts(targets, deps);
    return { asked: targets.length, written, limited };
}
