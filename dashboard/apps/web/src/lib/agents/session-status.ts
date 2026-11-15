/**
 * Ported from backend/pkg/contract/status.go and
 * backend/internal/service/session/status.go of Agent Orchestrator
 * (Apache-2.0, commit e4ded08c6f15).
 *
 * The status a session is shown under, derived from what is stored about it and
 * never stored itself. The stored facts are the agent's own last report (the
 * session `state` the hooks keep) and the pull request facts the webhook and the
 * poll keep (`AgentSessionPullFacts`); everything a board, a list, a Tasks item
 * or a push notice says about a session is this function of them, so two
 * screens can never disagree about the same session.
 *
 * Pure: no clock is read and nothing is fetched, so every precedence rule below
 * is asserted in a test without a database.
 *
 * One addition to the source: a pull request GitHub reports as conflicting is
 * `merge_conflict` (the source's own architecture document lists it, its code
 * folds it into `pr_open`). It ranks with the other states somebody has to act
 * on, after review comments and before a draft.
 */

import type { AgentSessionState } from "@polaris/core";

/** What the agent last reported, in the source's vocabulary. */
export const ACTIVITY_STATES = ["active", "idle", "waiting_input", "blocked", "exited"] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** Every status a session can be shown under. */
export const SESSION_STATUSES = [
    "working",
    "pr_open",
    "draft",
    "ci_failed",
    "review_pending",
    "changes_requested",
    "commented",
    "merge_conflict",
    "approved",
    "mergeable",
    "merged",
    "needs_input",
    "exited",
    "idle",
    "terminated",
    "no_signal"
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** The aggregate of every check on the pull request's head commit. */
export const CI_STATES = ["unknown", "pending", "passing", "failing"] as const;
export type CiState = (typeof CI_STATES)[number];

/** The aggregate human review verdict, as GitHub's `reviewDecision` gives it. */
export const REVIEW_DECISIONS = ["none", "approved", "changes_requested", "review_required"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** Whether the pull request can be merged now. */
export const MERGEABILITIES = ["unknown", "mergeable", "conflicting", "blocked", "unstable"] as const;
export type Mergeability = (typeof MERGEABILITIES)[number];

/** The facts about the session itself that the status reads. */
export interface SessionFacts {
    activity: ActivityState;
    /** When the session last reported, or when it started if it never has. */
    lastActivityAt: Date;
    /** Whether a hook has ever reported anything. */
    hasSignal: boolean;
    /** Whether hooks are expected to report at all: false for a session still
     *  queued, whose agent has not been started. */
    signalExpected: boolean;
    isTerminated: boolean;
}

/** The facts about one pull request the status reads. */
export interface PullFacts {
    url: string;
    draft: boolean;
    merged: boolean;
    closed: boolean;
    ci: CiState;
    review: ReviewDecision;
    mergeability: Mergeability;
    /** An unresolved review thread somebody other than a bot opened. */
    reviewComments: boolean;
    sourceBranch: string;
    targetBranch: string;
}

/** Where a pull request stands in a stack of them. */
export interface StackPosition {
    blocked: boolean;
    bottomOfStack: boolean;
}

/** How long a started session may stay silent before its idle reading turns
 *  into `no_signal`: the agent's boot plus the gap to its first hook. Past it a
 *  silent session cannot be told from one whose hooks are broken, and the screen
 *  must not claim a confident "idle". */
export const NO_SIGNAL_GRACE_MS = 90_000;

/** The status a session is shown under. Highest precedence first: over, then
 *  the agent's own report, then the pull request pipeline, then silence. */
export function deriveSessionStatus(
    session: SessionFacts,
    prs: readonly PullFacts[],
    now: Date,
    noSignalGraceMs: number = NO_SIGNAL_GRACE_MS
): SessionStatus {
    if (session.isTerminated) {
        if (openPulls(prs).length === 0 && anyMerged(prs)) return "merged";
        return "terminated";
    }

    switch (session.activity) {
        case "active":
            return "working";
        case "exited":
            return "exited";
        case "waiting_input":
        case "blocked":
            return "needs_input";
        case "idle":
            break;
    }

    const scm = deriveScmStatus(prs);
    if (scm) return scm;

    if (silentPastGrace(session, now, noSignalGraceMs)) return "no_signal";
    return "idle";
}

function silentPastGrace(session: SessionFacts, now: Date, graceMs: number): boolean {
    return (
        session.signalExpected &&
        !session.hasSignal &&
        now.getTime() - session.lastActivityAt.getTime() > graceMs
    );
}

/** The pull request side of the status alone, or null when the session has no
 *  pull request that says anything. */
export function deriveScmStatus(prs: readonly PullFacts[]): SessionStatus | null {
    const open = openPulls(prs);
    if (open.length > 0) return aggregatePullStatus(open);
    if (anyMerged(prs)) return "merged";
    return null;
}

/** Which open pull requests sit on top of another open one: a pull request
 *  whose target branch is another's source is blocked until that one merges. */
export function buildStacks(prs: readonly PullFacts[]): Map<string, StackPosition> {
    const openSources = new Set<string>();
    for (const pr of prs) {
        if (!pr.merged && !pr.closed && pr.sourceBranch) openSources.add(pr.sourceBranch);
    }
    const positions = new Map<string, StackPosition>();
    for (const pr of prs) {
        const blocked = pr.targetBranch !== "" && openSources.has(pr.targetBranch);
        positions.set(pr.url, { blocked, bottomOfStack: !blocked });
    }
    return positions;
}

function openPulls(prs: readonly PullFacts[]): PullFacts[] {
    return prs.filter((pr) => !pr.merged && !pr.closed);
}

function anyMerged(prs: readonly PullFacts[]): boolean {
    return prs.some((pr) => pr.merged);
}

/** The worst status among the open pull requests. One stacked on another only
 *  counts when it carries something its own author has to act on; the rest wait
 *  for the one below them. */
function aggregatePullStatus(open: readonly PullFacts[]): SessionStatus {
    const stacks = buildStacks(open);
    let candidates = open
        .filter((pr) => !stacks.get(pr.url)?.blocked || isActionableChildSignal(pullPipelineStatus(pr)))
        .map(pullPipelineStatus);
    if (candidates.length === 0) candidates = open.map(pullPipelineStatus);

    let worst = candidates[0]!;
    for (const status of candidates.slice(1)) {
        if (statusSeverity(status) < statusSeverity(worst)) worst = status;
    }
    return worst;
}

function isActionableChildSignal(status: SessionStatus): boolean {
    return (
        status === "ci_failed" ||
        status === "draft" ||
        status === "changes_requested" ||
        status === "commented" ||
        status === "merge_conflict"
    );
}

/** Lower is worse. */
const SEVERITY: Partial<Record<SessionStatus, number>> = {
    ci_failed: 0,
    changes_requested: 1,
    commented: 2,
    merge_conflict: 3,
    draft: 4,
    review_pending: 5,
    pr_open: 6,
    approved: 7,
    mergeable: 8
};

function statusSeverity(status: SessionStatus): number {
    return SEVERITY[status] ?? 9;
}

/** The status one open pull request stands at. */
export function pullPipelineStatus(pr: PullFacts): SessionStatus {
    if (pr.ci === "failing") return "ci_failed";
    if (pr.draft) return "draft";
    // Reserved for the provider's own formal decision: an unresolved thread from
    // a review that only commented is real feedback but not a blocking review.
    if (pr.review === "changes_requested") return "changes_requested";
    if (pr.reviewComments) return "commented";
    if (pr.mergeability === "conflicting") return "merge_conflict";
    if (pr.mergeability === "mergeable") return "mergeable";
    if (pr.review === "review_required") return "review_pending";
    if (pr.mergeability === "blocked") return "pr_open";
    if (pr.review === "approved") return "approved";
    return "pr_open";
}

/** The columns of a session row the facts are read from. */
export interface SessionRowFacts {
    state: AgentSessionState;
    lastEventAt: Date | null;
    startedAt: Date | null;
    createdAt: Date;
}

/**
 * A stored session as the facts above.
 *
 * Polaris keeps one `state` the hooks drive rather than the source's separate
 * activity and termination columns: `working` is active, `waiting` (a
 * permission prompt or a question) is waiting on a person, `stopped` and
 * `failed` are over. `queued` and `starting` have not reported yet; only a
 * started one is expected to, so a queue that holds a session for an hour
 * never reads as silent.
 */
export function sessionFactsFrom(row: SessionRowFacts): SessionFacts {
    const isTerminated = row.state === "stopped" || row.state === "failed";
    const activity: ActivityState =
        row.state === "working" ? "active" : row.state === "waiting" ? "waiting_input" : "idle";
    return {
        activity,
        lastActivityAt: row.lastEventAt ?? row.startedAt ?? row.createdAt,
        hasSignal: row.lastEventAt !== null,
        signalExpected: row.state !== "queued",
        isTerminated
    };
}
