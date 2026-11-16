/**
 * Ported from backend/internal/lifecycle/reactions.go (`ApplyPRObservation`,
 * `sendOnce`, the merge-conflict re-arm and the CI, review and conflict
 * messages) of Agent Orchestrator (Apache-2.0, commit e4ded08c6f15), and the
 * "Feedback routing flow" in its docs/architecture.md.
 *
 * Feedback routing: when a Code session's pull request facts change
 * (`session-pr-facts.ts`), what the agent can act on - failing checks, review
 * comments a person left, a merge conflict - is queued to that session as a
 * message, through the same queue a message typed mid-turn waits in
 * (`session-prompt-queue.ts`). A session at its prompt gets it now; one mid-turn
 * gets it when the turn ends, before its /goal is judged.
 *
 * The rules kept from the source:
 *   - Each condition is planned on its own, so a failing check never hides the
 *     review comments on the same pull request.
 *   - A fact is reported once: every nudge has a key and a signature, and the
 *     same signature under the same key is never sent again. A comment's nudge
 *     has an attempt budget of its own.
 *   - A conflict cleared (mergeable or unstable) re-arms the conflict nudge, so
 *     a branch that conflicts again after a rebase is told again.
 *   - Nothing reaches a session that has ended.
 * Added here: a per-session switch (on unless somebody turns it off), and a cap
 * on automatic rounds per head commit, so an agent that cannot fix something is
 * not prompted about it forever. A push starts the count again.
 *
 * Not ported: the CI log tail (the check's own summary is sent instead, as the
 * manual "send failing checks" does) and the stacked-pull-request check that
 * skips the conflict nudge for a pull request based on an open parent.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { Prisma } from "@polaris/db";
import type { PullCheck } from "@/lib/github-service";
import * as loop from "@/lib/agents/session-review-loop";
import type { PullNoticeKind } from "@/lib/agents/agent-notices";
import type { PullObservation } from "@/lib/agents/session-pr-facts";

/** Automatic rounds one head commit gets before Polaris stops prompting. */
export const ROUNDS_PER_HEAD = 3;
/** How many times one review comment's nudge may go (the source's reviewMaxNudge). */
export const ATTEMPTS_PER_COMMENT = 3;
/** Bounds on what is read and quoted from GitHub. */
const THREAD_LIMIT = 50;
const THREAD_COMMENT_LIMIT = 10;
const REVIEW_LIMIT = 10;
const QUOTED_THREADS = 20;
const QUOTED_COMMENTS = 5;
const BODY_MAX = 2_000;
const PROMPT_MAX = 19_000;
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// What was already sent (stored on the facts row)
// ---------------------------------------------------------------------------

export interface FeedbackState {
    /** The signature last sent under each nudge key. */
    seen: Record<string, string>;
    /** How many times each key was sent. */
    attempts: Record<string, number>;
    /** The head commit the round count is for. */
    head: string;
    /** Automatic rounds sent for that head commit. */
    rounds: number;
}

const stateSchema = z.object({
    seen: z.record(z.string().max(500), z.string().max(2_000)).catch({}),
    attempts: z.record(z.string().max(500), z.number().int().nonnegative()).catch({}),
    head: z.string().max(100).catch(""),
    rounds: z.number().int().nonnegative().catch(0)
});

/** A stored state, tolerant of anything a past build (or nothing) wrote. */
export function readFeedbackState(raw: unknown): FeedbackState {
    const parsed = stateSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : { seen: {}, attempts: {}, head: "", rounds: 0 };
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

/** A review thread somebody left, as it is quoted to the agent. */
export interface ReviewThread {
    id: string;
    path: string;
    line: number;
    side: "new" | "old";
    /** The commented line as the diff shows it. */
    code: string;
    /** Only comments a person wrote; a bot's (the agent's own replies) never count. */
    comments: { id: string; author: string; body: string }[];
}

/** A review that asked for changes, with what it said. */
export interface ChangesReview {
    id: string;
    author: string;
    body: string;
}

export interface FeedbackDetail {
    threads: ReviewThread[];
    reviews: ChangesReview[];
}

export type FeedbackFacts = Pick<
    PullObservation,
    "number" | "url" | "state" | "headSha" | "checks" | "checksFailed" | "mergeable" | "review" | "unresolvedComments"
>;

/** One condition worth telling the agent about. */
export interface Nudge {
    key: string;
    sig: string;
    maxAttempts: number;
}

export type FeedbackKind = "ci" | "review" | "conflict";

export interface FeedbackPlan {
    /** The state with the head and the conflict re-arm applied, before anything is sent. */
    state: FeedbackState;
    ci: Nudge | null;
    conflict: Nudge | null;
    /** Threads and reviews not reported yet, with their nudges. */
    threads: { thread: ReviewThread; nudge: Nudge }[];
    reviews: { review: ChangesReview; nudge: Nudge }[];
}

const ciKey = (number: number) => `ci:${number}`;
const conflictKey = (number: number) => `conflict:${number}`;

/** Whether review detail has to be read from GitHub at all. */
export function needsReviewDetail(facts: FeedbackFacts): boolean {
    return facts.state === "open" && (facts.unresolvedComments > 0 || facts.review === "changes_requested");
}

function due(state: FeedbackState, nudge: Nudge): boolean {
    if (state.seen[nudge.key] === nudge.sig) return false;
    return nudge.maxAttempts === 0 || (state.attempts[nudge.key] ?? 0) < nudge.maxAttempts;
}

/** What to send for one observation, given what was sent before. */
export function planFeedback(
    previous: FeedbackState,
    facts: FeedbackFacts,
    detail: FeedbackDetail | null
): FeedbackPlan {
    const state: FeedbackState = {
        seen: { ...previous.seen },
        attempts: { ...previous.attempts },
        head: previous.head,
        rounds: previous.rounds
    };
    if (facts.headSha && facts.headSha !== state.head) {
        state.head = facts.headSha;
        state.rounds = 0;
    }
    // Re-armed only on a definite clear: an unknown mergeability is GitHub
    // still computing, not the conflict gone.
    if (facts.mergeable === "mergeable" || facts.mergeable === "unstable") {
        delete state.seen[conflictKey(facts.number)];
        delete state.attempts[conflictKey(facts.number)];
    }
    const plan: FeedbackPlan = { state, ci: null, conflict: null, threads: [], reviews: [] };
    if (facts.state !== "open" || state.rounds >= ROUNDS_PER_HEAD) return plan;

    if (facts.checks === "failing") {
        const nudge = { key: ciKey(facts.number), sig: `${facts.headSha}:${facts.checksFailed}`, maxAttempts: 0 };
        if (due(state, nudge)) plan.ci = nudge;
    }
    if (facts.mergeable === "conflicting") {
        const nudge = { key: conflictKey(facts.number), sig: "conflicting", maxAttempts: 0 };
        if (due(state, nudge)) plan.conflict = nudge;
    }
    for (const thread of detail?.threads ?? []) {
        if (thread.comments.length === 0) continue;
        const nudge = {
            key: `thread:${facts.number}:${thread.id}`,
            sig: thread.comments.map((comment) => comment.id).sort().join(","),
            maxAttempts: ATTEMPTS_PER_COMMENT
        };
        if (due(state, nudge)) plan.threads.push({ thread, nudge });
    }
    if (facts.review === "changes_requested") {
        for (const review of detail?.reviews ?? []) {
            const nudge = {
                key: `review:${facts.number}:${review.id}`,
                sig: "changes_requested",
                maxAttempts: ATTEMPTS_PER_COMMENT
            };
            if (due(state, nudge)) plan.reviews.push({ review, nudge });
        }
    }
    return plan;
}

/** The state after the given nudges went: each recorded, and one more round. */
export function recordSent(state: FeedbackState, sent: readonly Nudge[]): FeedbackState {
    if (sent.length === 0) return state;
    const next: FeedbackState = {
        seen: { ...state.seen },
        attempts: { ...state.attempts },
        head: state.head,
        rounds: state.rounds + 1
    };
    for (const nudge of sent) {
        next.seen[nudge.key] = nudge.sig;
        next.attempts[nudge.key] = (next.attempts[nudge.key] ?? 0) + 1;
    }
    return next;
}

// ---------------------------------------------------------------------------
// Prompts (pure)
// ---------------------------------------------------------------------------

/** The session owner's words for the agents namespace. */
export type FeedbackWords = (key: string, values?: Record<string, string | number>) => string;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}...` : text);
const finish = (text: string, url: string) =>
    core.sanitizeAgentPrompt(clip(url ? `${text}\n\n${url}` : text, PROMPT_MAX));

/** The failing checks, worded as the manual "send failing checks" words them. */
export function ciFeedbackPrompt(facts: FeedbackFacts, checks: readonly PullCheck[], t: FeedbackWords): string {
    const text = loop.failingChecksPrompt(checks, {
        intro: t("session.checks.promptIntro", { number: facts.number }),
        noSummary: t("session.checks.promptNoSummary")
    });
    return text ? finish(text, facts.url) : "";
}

/** Review threads and changes-requested reviews as one message. Comment text is
 *  anyone's who can comment on the pull request, so it is cut to size and
 *  stripped of control characters; it is quoted, never obeyed by Polaris. */
export function reviewFeedbackPrompt(
    facts: FeedbackFacts,
    threads: readonly ReviewThread[],
    reviews: readonly ChangesReview[],
    t: FeedbackWords
): string {
    const comments: loop.LineComment[] = [];
    for (const thread of threads.slice(0, QUOTED_THREADS)) {
        const body = thread.comments
            .slice(-QUOTED_COMMENTS)
            .map((comment) => `@${comment.author}: ${clip(comment.body.trim(), BODY_MAX)}`)
            .join("\n");
        comments.push({ path: thread.path, line: thread.line, side: thread.side, code: thread.code, body });
    }
    const parts: string[] = [];
    const quoted = loop.reviewPrompt(comments, {
        intro: t("session.review.promptIntro"),
        line: (line) => t("session.review.promptLine", { line }),
        removedLine: (line) => t("session.review.promptRemoved", { line })
    });
    if (quoted) parts.push(quoted);
    for (const review of reviews.slice(0, REVIEW_LIMIT)) {
        const said = clip(review.body.trim(), BODY_MAX);
        parts.push([t("session.feedback.changesRequested", { author: review.author }), said].filter(Boolean).join("\n"));
    }
    return parts.length ? finish(parts.join("\n\n"), facts.url) : "";
}

export function conflictFeedbackPrompt(facts: FeedbackFacts, t: FeedbackWords): string {
    return finish(t("session.feedback.conflict", { number: facts.number }), facts.url);
}

/** The notices a change in the facts raises. Nothing for a pull request never
 *  stored before: the first read after an update must not announce every old
 *  pull request again. The notices dedupe per pull request (per commit for a
 *  failure), so one the webhook already raised is not raised twice. */
export function pullNoticeKinds(
    previous: { state: string; draft: boolean; checks: string; headSha: string; fetchedAt: Date } | null,
    next: Pick<PullObservation, "state" | "draft" | "checks" | "headSha">
): PullNoticeKind[] {
    if (!previous) return [];
    const known = previous.fetchedAt.getTime() > 0;
    const kinds: PullNoticeKind[] = [];
    if (next.state === "merged" && !(known && previous.state === "merged")) kinds.push("pr_merged");
    if (next.state === "open" && !next.draft && !(known && previous.state === "open" && !previous.draft))
        kinds.push("pr_ready");
    if (
        next.state === "open" &&
        next.checks === "failing" &&
        !(known && previous.checks === "failing" && previous.headSha === next.headSha)
    )
        kinds.push("ci_failed");
    return kinds;
}

// ---------------------------------------------------------------------------
// Reading review detail from GitHub
// ---------------------------------------------------------------------------

const DETAIL_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(last:${THREAD_LIMIT}){ nodes{
        id isResolved path line originalLine diffSide
        comments(last:${THREAD_COMMENT_LIMIT}){ nodes{ id body diffHunk author{ login __typename } } }
      } }
      reviews(last:${REVIEW_LIMIT}, states:[CHANGES_REQUESTED]){ nodes{ id body author{ login __typename } } }
    }
  }
}`;

const text = (max: number) => z.string().max(max);
const author = z.object({ login: text(200), __typename: text(50) }).nullish();
const detailAnswer = z.object({
    data: z
        .object({
            repository: z
                .object({
                    pullRequest: z
                        .object({
                            reviewThreads: z.object({
                                nodes: z
                                    .array(
                                        z
                                            .object({
                                                id: text(200),
                                                isResolved: z.boolean(),
                                                path: text(1_024),
                                                line: z.number().int().nullish(),
                                                originalLine: z.number().int().nullish(),
                                                diffSide: text(10).nullish(),
                                                comments: z.object({
                                                    nodes: z
                                                        .array(
                                                            z
                                                                .object({
                                                                    id: text(200),
                                                                    body: text(65_536),
                                                                    diffHunk: text(65_536).nullish(),
                                                                    author
                                                                })
                                                                .nullable()
                                                        )
                                                        .max(THREAD_COMMENT_LIMIT)
                                                })
                                            })
                                            .nullable()
                                    )
                                    .max(THREAD_LIMIT)
                            }),
                            reviews: z.object({
                                nodes: z
                                    .array(z.object({ id: text(200), body: text(65_536), author }).nullable())
                                    .max(REVIEW_LIMIT)
                            })
                        })
                        .nullable()
                })
                .nullable()
        })
        .nullish(),
    errors: z.array(z.unknown()).max(50).nullish()
});

/** The detail of one GraphQL answer, projected. Pure. */
export function detailFrom(body: unknown): FeedbackDetail | null {
    const parsed = detailAnswer.safeParse(body);
    if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) return null;
    const pull = parsed.data.data?.repository?.pullRequest;
    if (!pull) return null;
    const human = (who: z.infer<typeof author>) => !!who && who.__typename !== "Bot";
    const threads: ReviewThread[] = [];
    for (const node of pull.reviewThreads.nodes) {
        if (!node || node.isResolved) continue;
        const said = node.comments.nodes.filter((comment) => comment && human(comment.author));
        if (said.length === 0) continue;
        const hunk = node.comments.nodes.find((comment) => comment?.diffHunk)?.diffHunk ?? "";
        threads.push({
            id: node.id,
            path: node.path,
            line: Math.max(1, node.line ?? node.originalLine ?? 1),
            side: node.diffSide === "LEFT" ? "old" : "new",
            code: (hunk.split("\n").pop() ?? "").replace(/^[-+ ]/, ""),
            comments: said.map((comment) => ({
                id: comment!.id,
                author: comment!.author!.login,
                body: comment!.body
            }))
        });
    }
    const reviews: ChangesReview[] = pull.reviews.nodes
        .filter((review) => review && human(review.author))
        .map((review) => ({ id: review!.id, author: review!.author!.login, body: review!.body }));
    return { threads, reviews };
}

async function fetchReviewDetail(
    owner: string,
    repo: string,
    number: number,
    token: string
): Promise<FeedbackDetail | null> {
    try {
        const res = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": "polaris"
            },
            body: JSON.stringify({ query: DETAIL_QUERY, variables: { owner, repo, number } }),
            cache: "no-store",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (!res.ok) return null;
        return detailFrom(await res.json());
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// The reaction
// ---------------------------------------------------------------------------

/** The stored row as it was before this write, or null when there was none. */
export interface PreviousFacts {
    state: string;
    draft: boolean;
    checks: string;
    headSha: string;
    fetchedAt: Date;
    feedback: unknown;
}

export interface FeedbackDeps {
    session(sessionId: string): Promise<{ state: string; autoFeedback: boolean; ownerId: string | null } | null>;
    notice(sessionId: string, kind: PullNoticeKind, detail: { prNumber: number; headSha: string | null }): Promise<void>;
    words(ownerId: string): Promise<FeedbackWords>;
    token(owner: string): Promise<string | null>;
    checks(owner: string, repo: string, number: number, token: string): Promise<readonly PullCheck[] | null>;
    detail(owner: string, repo: string, number: number, token: string): Promise<FeedbackDetail | null>;
    enqueue(sessionId: string, ownerId: string, key: string, text: string): Promise<boolean>;
    saveState(sessionId: string, number: number, state: FeedbackState): Promise<void>;
    deliver(sessionId: string): Promise<void>;
    /** Starts the repository's reviewer on this head when one is due
     *  (`session-reviewer-service.ts`). Optional: absent starts none. */
    review?(sessionId: string, number: number): void;
}

const DEFAULT_DEPS: FeedbackDeps = {
    session: async (sessionId) => {
        const row = await prisma.agentSession.findUnique({
            where: { id: sessionId },
            select: { state: true, autoFeedback: true, startedById: true, repo: { select: { ownerId: true } } }
        });
        if (!row) return null;
        return { state: row.state, autoFeedback: row.autoFeedback, ownerId: row.startedById ?? row.repo?.ownerId ?? null };
    },
    notice: async (sessionId, kind, detail) => {
        const notices = await import("@/lib/agents/agent-notices");
        await notices.noticeSessionPull(sessionId, kind, detail);
    },
    words: async (ownerId) => {
        const { wordsFor } = await import("@/lib/notifications/notice-words");
        return (await wordsFor(ownerId, "agents")) as unknown as FeedbackWords;
    },
    token: async (owner) => {
        const github = await import("@/lib/github-service");
        return github.githubAppInstallationToken(owner).catch(() => null);
    },
    checks: async (owner, repo, number, token) => {
        const github = await import("@/lib/github-service");
        return (await github.pullRequestChecks(owner, repo, number, token))?.checks ?? null;
    },
    detail: fetchReviewDetail,
    enqueue: async (sessionId, ownerId, key, body) => {
        const queue = await import("@/lib/agents/session-prompt-queue");
        return queue.queueFeedback(sessionId, ownerId, key, body);
    },
    saveState: async (sessionId, number, state) => {
        await prisma.sessionPullFacts.updateMany({
            where: { sessionId, number },
            data: { feedback: state as unknown as Prisma.InputJsonValue }
        });
    },
    deliver: async (sessionId) => {
        const queue = await import("@/lib/agents/session-prompt-queue");
        await queue.deliverNextQueued(sessionId);
    },
    // Not awaited: a container coming up (an image pull) must not hold the
    // webhook or the poll that stored the facts. It catches its own failures.
    review: (sessionId, number) => {
        void import("@/lib/agents/session-reviewer-service")
            .then((service) => service.requestReview({ sessionId, number, trigger: "auto" }))
            .catch((error) => console.error(`[agent-session] ${sessionId}: the reviewer could not be asked`, error));
    }
};

/**
 * Reacts to one stored observation: the notices its change raises, then the
 * feedback it routes to the session. Never throws: it runs after the facts
 * were stored and must not fail the poll or the webhook that stored them.
 */
export async function reactToPullFacts(
    input: { sessionId: string; repoFullName: string; observation: PullObservation; previous: PreviousFacts | null },
    deps: FeedbackDeps = DEFAULT_DEPS
): Promise<void> {
    const { sessionId, observation: facts } = input;
    try {
        for (const kind of pullNoticeKinds(input.previous, facts))
            await deps.notice(sessionId, kind, { prNumber: facts.number, headSha: facts.headSha || null });
        await routeFeedback(input, deps);
        if (facts.state === "open" && facts.headSha) deps.review?.(sessionId, facts.number);
    } catch (error) {
        console.error(`[agent-session] ${sessionId}: pull request feedback could not be routed`, error);
    }
}

async function routeFeedback(
    input: { sessionId: string; repoFullName: string; observation: PullObservation; previous: PreviousFacts | null },
    deps: FeedbackDeps
): Promise<void> {
    const { sessionId, observation: facts } = input;
    const session = await deps.session(sessionId);
    if (!session?.ownerId || !session.autoFeedback) return;
    if (core.isSessionOver(session.state as core.AgentSessionState)) return;
    const [owner, repo] = input.repoFullName.split("/");
    if (!owner || !repo) return;

    const previous = readFeedbackState(input.previous?.feedback);
    let plan = planFeedback(previous, facts, null);
    const reviewWanted = needsReviewDetail(facts) && plan.state.rounds < ROUNDS_PER_HEAD;
    if (!plan.ci && !plan.conflict && !reviewWanted) {
        if (JSON.stringify(plan.state) !== JSON.stringify(previous))
            await deps.saveState(sessionId, facts.number, plan.state);
        return;
    }
    const token = await deps.token(owner);
    if (!token) return;
    if (reviewWanted) {
        const detail = await deps.detail(owner, repo, facts.number, token);
        if (detail) plan = planFeedback(previous, facts, detail);
    }

    const t = await deps.words(session.ownerId);
    const sent: Nudge[] = [];
    const queue = async (kind: FeedbackKind, body: string, nudges: Nudge[]) => {
        if (!body || nudges.length === 0) return;
        if (await deps.enqueue(sessionId, session.ownerId!, `${kind}:${facts.number}`, body)) sent.push(...nudges);
    };
    if (plan.ci) {
        const checks = await deps.checks(owner, repo, facts.number, token);
        // Unreadable now: left unsent, so the next refresh tries again.
        if (checks) await queue("ci", ciFeedbackPrompt(facts, checks, t), [plan.ci]);
    }
    if (plan.threads.length || plan.reviews.length) {
        await queue(
            "review",
            reviewFeedbackPrompt(
                facts,
                plan.threads.map((one) => one.thread),
                plan.reviews.map((one) => one.review),
                t
            ),
            [...plan.threads.map((one) => one.nudge), ...plan.reviews.map((one) => one.nudge)]
        );
    }
    if (plan.conflict) await queue("conflict", conflictFeedbackPrompt(facts, t), [plan.conflict]);

    const next = recordSent(plan.state, sent);
    if (JSON.stringify(next) !== JSON.stringify(previous)) await deps.saveState(sessionId, facts.number, next);
    if (sent.length && core.isSessionListening(session.state as core.AgentSessionState)) await deps.deliver(sessionId);
}
