/**
 * Ported from frontend/src/renderer/components/PRTabPane.tsx and PRComments.tsx
 * (what a pull request's tab shows and the order its conversation is read in)
 * and backend/internal/adapters/scm/github/observer_provider.go and
 * pr_comment.go (the details query, review summaries, threads, and the reply
 * to a review thread) of Agent Orchestrator (Apache-2.0, commit e4ded08c6f15).
 *
 * A session's pull request as a person reads it: checks, reviews, comments
 * and commits, oldest first. Read from GitHub when the tab asks, never stored
 * whole - only the facts the status reads (`session-pr-facts.ts`) are kept, and
 * every read here refreshes them as a side effect, since it is the same query
 * with more fields.
 *
 * Reads are bounded (the newest commits, comments, reviews and threads, each
 * capped) and kept for a few seconds per pull request, so a tab opened twice or
 * a burst of re-renders is one call to GitHub.
 */

import { z } from "zod";
import * as facts from "@/lib/agents/session-pr-facts";
import type * as status from "@/lib/agents/session-status";
import { COMMENT_MAX } from "@/lib/agents/pr-reply-quote";

const GRAPHQL_URL = "https://api.github.com/graphql";
const FETCH_TIMEOUT_MS = 10_000;

export const COMMIT_LIMIT = 30;
export const CONVERSATION_LIMIT = 30;
export const REVIEW_LIMIT = 20;
export const THREAD_LIMIT = 30;
export const THREAD_REPLY_LIMIT = 20;
export const BODY_MAX = COMMENT_MAX;
/** How much of one body the page is sent: the link opens the rest. */
const BODY_SHOWN = 8_000;

const TIMELINE_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){${facts.PULL_FIELDS}
      title
      commitList: commits(last:${COMMIT_LIMIT}){ totalCount nodes{ commit{ oid messageHeadline committedDate url author{ name user{ login } } } } }
      conversation: comments(last:${CONVERSATION_LIMIT}){ totalCount nodes{ id body url createdAt author{ login __typename } } }
      reviewSummaries: reviews(last:${REVIEW_LIMIT}, states:[APPROVED,CHANGES_REQUESTED,COMMENTED,DISMISSED]){ nodes{ id state url submittedAt body author{ login __typename } } }
      threads: reviewThreads(last:${THREAD_LIMIT}){ nodes{ id isResolved path line comments(first:${THREAD_REPLY_LIMIT}){ totalCount nodes{ id body url createdAt author{ login __typename } } } } }
    }
  }
}`;

// ---------------------------------------------------------------------------
// The answer, validated
// ---------------------------------------------------------------------------

const short = z.string().max(2_000);
const optShort = short.nullish();
const body = z.string().max(BODY_MAX).nullish();
const author = z.object({ login: optShort, __typename: optShort }).nullish();

const commentNode = z.object({
    id: short,
    body,
    url: optShort,
    createdAt: optShort,
    author
});

const timelineNode = facts.pullNode.extend({
    title: z.string().max(1_000).nullish(),
    commitList: z
        .object({
            totalCount: z.number().int().nonnegative().nullish(),
            nodes: z
                .array(
                    z
                        .object({
                            commit: z.object({
                                oid: short,
                                messageHeadline: optShort,
                                committedDate: optShort,
                                url: optShort,
                                author: z
                                    .object({
                                        name: optShort,
                                        user: z.object({ login: optShort }).nullish()
                                    })
                                    .nullish()
                            })
                        })
                        .nullable()
                )
                .max(COMMIT_LIMIT)
        })
        .nullish(),
    conversation: z
        .object({
            totalCount: z.number().int().nonnegative().nullish(),
            nodes: z.array(commentNode.nullable()).max(CONVERSATION_LIMIT)
        })
        .nullish(),
    reviewSummaries: z
        .object({
            nodes: z
                .array(
                    z
                        .object({
                            id: short,
                            state: optShort,
                            url: optShort,
                            submittedAt: optShort,
                            body,
                            author
                        })
                        .nullable()
                )
                .max(REVIEW_LIMIT)
        })
        .nullish(),
    threads: z
        .object({
            nodes: z
                .array(
                    z
                        .object({
                            id: short,
                            isResolved: z.boolean(),
                            path: optShort,
                            line: z.number().int().nullish(),
                            comments: z
                                .object({
                                    totalCount: z.number().int().nonnegative().nullish(),
                                    nodes: z.array(commentNode.nullable()).max(THREAD_REPLY_LIMIT)
                                })
                                .nullish()
                        })
                        .nullable()
                )
                .max(THREAD_LIMIT)
        })
        .nullish()
});
export type TimelineNode = z.infer<typeof timelineNode>;

const timelineAnswer = z.object({
    data: z
        .object({ repository: z.object({ pullRequest: timelineNode.nullable() }).nullable() })
        .nullish(),
    errors: z.array(z.object({ type: optShort, message: optShort })).max(50).nullish()
});

// ---------------------------------------------------------------------------
// Projection (pure)
// ---------------------------------------------------------------------------

export interface TimelineAuthor {
    login: string;
    bot: boolean;
}

export interface TimelineComment {
    id: string;
    at: string;
    author: TimelineAuthor;
    body: string;
    url: string | null;
}

export type ReviewState = "approved" | "changes_requested" | "commented" | "dismissed";

export type TimelineEntry =
    | { kind: "commit"; id: string; at: string; sha: string; headline: string; author: string; url: string | null }
    | ({ kind: "review"; state: ReviewState } & TimelineComment)
    | ({ kind: "comment" } & TimelineComment)
    | {
          kind: "thread";
          id: string;
          at: string;
          resolved: boolean;
          path: string;
          line: number | null;
          comments: TimelineComment[];
          /** Replies GitHub has beyond the ones read. */
          more: number;
      };

export type CheckState = "passed" | "failed" | "pending" | "skipped" | "unknown";

export interface TimelineCheck {
    name: string;
    state: CheckState;
    url: string | null;
}

export interface PullTimeline {
    number: number;
    url: string;
    title: string;
    state: "open" | "closed" | "merged";
    draft: boolean;
    headSha: string;
    sourceBranch: string;
    targetBranch: string;
    review: status.ReviewDecision;
    mergeable: status.Mergeability;
    /** GitHub's own merge state, upper case (`CLEAN`, `BLOCKED`, ...), or "". */
    mergeState: string;
    checks: {
        verdict: status.CiState;
        passed: number;
        failed: number;
        pending: number;
        list: TimelineCheck[];
    };
    /** Oldest first. */
    entries: TimelineEntry[];
    commitsTotal: number;
    commentsTotal: number;
}

const loginOf = (value: { login?: string | null; __typename?: string | null } | null | undefined) => ({
    // A deleted account reads as GitHub's own placeholder.
    login: value?.login?.trim() || "ghost",
    bot: value?.__typename === "Bot" || /\[bot\]$/.test(value?.login ?? "")
});

/** Only http(s) links reach the page; anything else is dropped. */
export function safeUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
        return null;
    }
}

const clip = (value: string | null | undefined) => (value ?? "").slice(0, BODY_SHOWN);

function commentOf(node: z.infer<typeof commentNode>): TimelineComment {
    return {
        id: node.id,
        at: node.createdAt ?? "",
        author: loginOf(node.author),
        body: clip(node.body),
        url: safeUrl(node.url)
    };
}

function reviewState(value: string | null | undefined): ReviewState | null {
    switch ((value ?? "").toUpperCase()) {
        case "APPROVED":
            return "approved";
        case "CHANGES_REQUESTED":
            return "changes_requested";
        case "COMMENTED":
            return "commented";
        case "DISMISSED":
            return "dismissed";
        default:
            return null;
    }
}

function checkState(node: facts.ContextNode): CheckState {
    switch (facts.checkVerdict(node)) {
        case "passed":
            return "passed";
        case "failed":
            return "failed";
        case "queued":
        case "running":
            return "pending";
        case "skipped":
        case "cancelled":
            return "skipped";
        default:
            return "unknown";
    }
}

/** Orders by time, keeping GitHub's order for entries with the same or no time. */
function byTime(entries: TimelineEntry[]): TimelineEntry[] {
    return entries
        .map((entry, index) => ({ entry, index, at: Date.parse(entry.at) }))
        .sort((a, b) => {
            const left = Number.isNaN(a.at) ? 0 : a.at;
            const right = Number.isNaN(b.at) ? 0 : b.at;
            return left - right || a.index - b.index;
        })
        .map(({ entry }) => entry);
}

/** The whole timeline of one GraphQL pull request node. */
export function timelineFrom(pull: TimelineNode): PullTimeline {
    const observation = facts.observationFrom(pull);
    const rollup = pull.commits?.nodes[0]?.commit.statusCheckRollup;
    const contexts = facts.latestCheckRuns(
        (rollup?.contexts?.nodes ?? []).filter((node): node is facts.ContextNode => node !== null)
    );
    const list: TimelineCheck[] = contexts.map((node) => ({
        name: (node.__typename === "StatusContext" ? node.context : node.name) || "?",
        state: checkState(node),
        url: safeUrl(node.__typename === "StatusContext" ? node.targetUrl : node.detailsUrl)
    }));
    const passed = list.filter((check) => check.state === "passed").length;

    const entries: TimelineEntry[] = [];
    for (const node of pull.commitList?.nodes ?? []) {
        if (!node) continue;
        const commit = node.commit;
        entries.push({
            kind: "commit",
            id: commit.oid,
            at: commit.committedDate ?? "",
            sha: commit.oid,
            headline: commit.messageHeadline ?? "",
            author: commit.author?.user?.login || commit.author?.name || "",
            url: safeUrl(commit.url)
        });
    }
    for (const node of pull.reviewSummaries?.nodes ?? []) {
        if (!node) continue;
        const state = reviewState(node.state);
        // A comment-only review with no words of its own is the envelope of its
        // threads, which are shown as threads.
        if (!state || (state === "commented" && !node.body?.trim())) continue;
        entries.push({
            kind: "review",
            state,
            ...commentOf({ id: node.id, body: node.body, url: node.url, createdAt: node.submittedAt, author: node.author })
        });
    }
    for (const node of pull.conversation?.nodes ?? []) {
        if (node) entries.push({ kind: "comment", ...commentOf(node) });
    }
    for (const node of pull.threads?.nodes ?? []) {
        if (!node) continue;
        const comments = (node.comments?.nodes ?? [])
            .filter((comment): comment is z.infer<typeof commentNode> => comment !== null)
            .map(commentOf);
        if (comments.length === 0) continue;
        entries.push({
            kind: "thread",
            id: node.id,
            at: comments[0]!.at,
            resolved: node.isResolved,
            path: node.path ?? "",
            line: node.line ?? null,
            comments,
            more: Math.max(0, (node.comments?.totalCount ?? comments.length) - comments.length)
        });
    }

    return {
        number: observation.number,
        url: safeUrl(observation.url) ?? "",
        title: pull.title ?? "",
        state: observation.state,
        draft: observation.draft,
        headSha: observation.headSha,
        sourceBranch: observation.sourceBranch,
        targetBranch: observation.targetBranch,
        review: observation.review,
        mergeable: observation.mergeable,
        mergeState: (pull.mergeStateStatus ?? "").trim().toUpperCase(),
        checks: {
            verdict: observation.checks,
            passed,
            failed: observation.checksFailed,
            pending: observation.checksPending,
            list
        },
        entries: byTime(entries),
        commitsTotal: pull.commitList?.totalCount ?? 0,
        commentsTotal: pull.conversation?.totalCount ?? 0
    };
}

// ---------------------------------------------------------------------------
// Reading GitHub
// ---------------------------------------------------------------------------

export type TimelineOutcome =
    | { kind: "ok"; timeline: PullTimeline; observation: facts.PullObservation }
    | { kind: "missing" }
    | { kind: "limited" }
    | { kind: "failed" };

async function graphql(
    token: string,
    query: string,
    variables: Record<string, unknown>,
    fetchImpl: typeof fetch
): Promise<{ status: number; limited: boolean; body: unknown } | null> {
    try {
        const res = await fetchImpl(GRAPHQL_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                "User-Agent": "polaris"
            },
            body: JSON.stringify({ query, variables }),
            cache: "no-store",
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        const limited =
            res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
        const answer = await res.json().catch(() => null);
        return { status: res.status, limited, body: answer };
    } catch {
        return null;
    }
}

/** Reads one pull request's timeline. Never throws. */
export async function fetchPullTimeline(
    owner: string,
    repo: string,
    number: number,
    token: string,
    fetchImpl: typeof fetch = fetch
): Promise<TimelineOutcome> {
    const res = await graphql(token, TIMELINE_QUERY, { owner, repo, number }, fetchImpl);
    if (!res) return { kind: "failed" };
    if (res.limited) return { kind: "limited" };
    if (res.status < 200 || res.status >= 300) return { kind: "failed" };
    const parsed = timelineAnswer.safeParse(res.body);
    if (!parsed.success) return { kind: "failed" };
    const errors = parsed.data.errors ?? [];
    if (errors.some((error) => error.type === "RATE_LIMITED")) return { kind: "limited" };
    if (errors.some((error) => error.type === "NOT_FOUND")) return { kind: "missing" };
    if (errors.length > 0) return { kind: "failed" };
    const pull = parsed.data.data?.repository?.pullRequest;
    if (!pull) return { kind: "missing" };
    return { kind: "ok", timeline: timelineFrom(pull), observation: facts.observationFrom(pull) };
}

const replyAnswer = z.object({
    data: z
        .object({
            addPullRequestReviewThreadReply: z
                .object({ comment: z.object({ id: short }).nullish() })
                .nullish()
        })
        .nullish(),
    errors: z.array(z.object({ type: optShort, message: optShort })).max(50).nullish()
});

export type ReplyOutcome =
    | { ok: true }
    | { ok: false; reason: "notAllowed" | "limited" | "failed"; message: string };

/** Replies in a review thread, as AO's `replyToReviewThread`. Never throws. */
export async function replyToReviewThread(
    threadId: string,
    text: string,
    token: string,
    fetchImpl: typeof fetch = fetch
): Promise<ReplyOutcome> {
    const res = await graphql(
        token,
        `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){ comment{ id } }
}`,
        { threadId, body: text },
        fetchImpl
    );
    if (!res) return { ok: false, reason: "failed", message: "" };
    if (res.limited) return { ok: false, reason: "limited", message: "" };
    const parsed = replyAnswer.safeParse(res.body);
    const errors = parsed.success ? (parsed.data.errors ?? []) : [];
    const message = (errors[0]?.message ?? "").slice(0, 500);
    if (res.status === 401 || res.status === 403 || errors.some((error) => error.type === "FORBIDDEN"))
        return { ok: false, reason: "notAllowed", message };
    if (!parsed.success || errors.length > 0 || res.status < 200 || res.status >= 300)
        return { ok: false, reason: "failed", message };
    if (!parsed.data.data?.addPullRequestReviewThreadReply?.comment?.id)
        return { ok: false, reason: "failed", message };
    return { ok: true };
}

// ---------------------------------------------------------------------------
// The short-lived cache
// ---------------------------------------------------------------------------

/** How long one read answers for the same pull request. */
export const TIMELINE_TTL_MS = 15_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; timeline: PullTimeline }>();

const cacheKey = (sessionId: string, number: number) => `${sessionId}:${number}`;

export function cachedTimeline(sessionId: string, number: number, now = Date.now()): PullTimeline | null {
    const hit = cache.get(cacheKey(sessionId, number));
    if (!hit || now - hit.at > TIMELINE_TTL_MS) return null;
    return hit.timeline;
}

export function rememberTimeline(sessionId: string, timeline: PullTimeline, now = Date.now()): void {
    const key = cacheKey(sessionId, timeline.number);
    cache.delete(key);
    cache.set(key, { at: now, timeline });
    // Oldest first in a Map's order: drop from the front.
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/** After a write from here (a reply, a merge, a claim) the next read asks GitHub. */
export function forgetTimeline(sessionId: string): void {
    for (const key of cache.keys()) if (key.startsWith(`${sessionId}:`)) cache.delete(key);
}
