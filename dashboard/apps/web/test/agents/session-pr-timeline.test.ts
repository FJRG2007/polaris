/**
 * The pull request tab: the timeline projection and reads (ported from Agent
 * Orchestrator's PR tab and GitHub adapter), the reply mutation, the short
 * cache, when merge is offered, and claiming an existing pull request.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/github-service", () => ({
    githubAppInstallationToken: vi.fn(async () => "token"),
    readPullRequest: vi.fn(),
    commentOnIssue: vi.fn(async () => true)
}));
vi.mock("@/lib/github-access", () => ({ githubTokenForUser: vi.fn(async () => null) }));
vi.mock("@/lib/agents/session-runtime", () => ({ runInSession: vi.fn() }));
vi.mock("@/lib/agents/session-work", () => ({ saveSessionWork: vi.fn() }));

import * as review from "@/lib/agents/session-review";
import { replyQuote } from "@/lib/agents/pr-reply-quote";
import * as timelines from "@/lib/agents/session-pr-timeline";

const SHA = "a".repeat(40);

function pull(extra: Record<string, unknown> = {}) {
    return {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        title: "Add the thing",
        state: "OPEN",
        isDraft: false,
        merged: false,
        closed: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        reviewDecision: "REVIEW_REQUIRED",
        headRefOid: SHA,
        headRefName: "agent/x",
        baseRefName: "main",
        commits: {
            nodes: [
                {
                    commit: {
                        statusCheckRollup: {
                            state: "FAILURE",
                            contexts: {
                                nodes: [
                                    {
                                        __typename: "CheckRun",
                                        name: "test",
                                        status: "COMPLETED",
                                        conclusion: "FAILURE",
                                        databaseId: 2,
                                        detailsUrl: "https://github.com/o/r/runs/2",
                                        checkSuite: { workflowRun: { event: "push", workflow: { name: "ci" } } }
                                    },
                                    {
                                        __typename: "CheckRun",
                                        name: "test",
                                        status: "COMPLETED",
                                        conclusion: "SUCCESS",
                                        databaseId: 1,
                                        checkSuite: { workflowRun: { event: "push", workflow: { name: "ci" } } }
                                    },
                                    { __typename: "StatusContext", context: "deploy", state: "PENDING", targetUrl: "javascript:alert(1)" }
                                ],
                                pageInfo: { hasNextPage: false }
                            }
                        }
                    }
                }
            ]
        },
        reviewThreads: { nodes: [] },
        commitList: {
            totalCount: 1,
            nodes: [
                {
                    commit: {
                        oid: SHA,
                        messageHeadline: "first",
                        committedDate: "2026-11-01T10:00:00Z",
                        url: "https://github.com/o/r/commit/a",
                        author: { name: "Ann", user: { login: "ann" } }
                    }
                }
            ]
        },
        conversation: {
            totalCount: 1,
            nodes: [
                {
                    id: "IC_1",
                    body: "Looks close",
                    url: "https://github.com/o/r/pull/7#c1",
                    createdAt: "2026-11-01T12:00:00Z",
                    author: { login: "bob", __typename: "User" }
                }
            ]
        },
        reviewSummaries: {
            nodes: [
                { id: "R_1", state: "COMMENTED", body: "", submittedAt: "2026-11-01T11:00:00Z", author: { login: "bob" } },
                {
                    id: "R_2",
                    state: "CHANGES_REQUESTED",
                    body: "Fix it",
                    submittedAt: "2026-11-01T11:30:00Z",
                    author: { login: "ci[bot]", __typename: "Bot" }
                }
            ]
        },
        threads: {
            nodes: [
                {
                    id: "PRRT_1",
                    isResolved: false,
                    path: "src/a.ts",
                    line: 3,
                    comments: {
                        totalCount: 3,
                        nodes: [
                            { id: "C_1", body: "why?", createdAt: "2026-11-01T10:30:00Z", author: { login: "bob" } },
                            null
                        ]
                    }
                }
            ]
        },
        ...extra
    };
}

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

describe("timelineFrom", () => {
    it("orders the entries oldest first and drops comment-only review envelopes", () => {
        const timeline = timelines.timelineFrom(pull() as never);
        expect(timeline.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
            `commit:${SHA}`,
            "thread:PRRT_1",
            "review:R_2",
            "comment:IC_1"
        ]);
        const thread = timeline.entries[1];
        expect(thread).toMatchObject({ kind: "thread", path: "src/a.ts", line: 3, more: 2 });
        const reviewEntry = timeline.entries[2];
        expect(reviewEntry).toMatchObject({ state: "changes_requested", author: { login: "ci[bot]", bot: true } });
    });

    it("keeps only the newest run of a check and only http links", () => {
        const { checks } = timelines.timelineFrom(pull() as never);
        expect(checks.list).toEqual([
            { name: "test", state: "failed", url: "https://github.com/o/r/runs/2" },
            { name: "deploy", state: "pending", url: null }
        ]);
        expect(checks).toMatchObject({ verdict: "failing", failed: 1, pending: 1, passed: 0 });
    });

    it("carries the merge state and head commit the merge is guarded by", () => {
        const timeline = timelines.timelineFrom(pull() as never);
        expect(timeline).toMatchObject({ mergeState: "BLOCKED", headSha: SHA, state: "open", review: "review_required" });
    });
});

describe("fetchPullTimeline", () => {
    it("reads a pull request", async () => {
        const outcome = await timelines.fetchPullTimeline(
            "o",
            "r",
            7,
            "t",
            answer({ data: { repository: { pullRequest: pull() } } })
        );
        expect(outcome.kind).toBe("ok");
    });

    it("never takes a partial answer", async () => {
        const outcome = await timelines.fetchPullTimeline(
            "o",
            "r",
            7,
            "t",
            answer({ data: { repository: { pullRequest: pull() } }, errors: [{ type: "SOMETHING", message: "x" }] })
        );
        expect(outcome.kind).toBe("failed");
    });

    it("tells a missing pull request and a spent quota apart", async () => {
        expect(
            (await timelines.fetchPullTimeline("o", "r", 7, "t", answer({ errors: [{ type: "NOT_FOUND" }] }))).kind
        ).toBe("missing");
        expect(
            (await timelines.fetchPullTimeline("o", "r", 7, "t", answer({}, 403, { "x-ratelimit-remaining": "0" }))).kind
        ).toBe("limited");
    });
});

describe("replyToReviewThread", () => {
    it("posts the reply through GraphQL", async () => {
        const fetchImpl = answer({ data: { addPullRequestReviewThreadReply: { comment: { id: "C_9" } } } });
        expect(await timelines.replyToReviewThread("PRRT_1", "ok", "t", fetchImpl)).toEqual({ ok: true });
        const body = JSON.parse((fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1].body as string);
        expect(body.variables).toEqual({ threadId: "PRRT_1", body: "ok" });
    });

    it("passes GitHub's refusal on", async () => {
        const result = await timelines.replyToReviewThread(
            "PRRT_1",
            "ok",
            "t",
            answer({ errors: [{ type: "FORBIDDEN", message: "no" }] })
        );
        expect(result).toEqual({ ok: false, reason: "notAllowed", message: "no" });
    });
});

describe("timeline cache", () => {
    it("answers for a few seconds, then asks again, and forgets after a write", () => {
        const timeline = timelines.timelineFrom(pull() as never);
        timelines.rememberTimeline("s1", timeline, 1_000);
        expect(timelines.cachedTimeline("s1", 7, 1_000 + timelines.TIMELINE_TTL_MS)).toBe(timeline);
        expect(timelines.cachedTimeline("s1", 7, 2_000 + timelines.TIMELINE_TTL_MS)).toBeNull();
        timelines.rememberTimeline("s1", timeline, Date.now());
        timelines.forgetTimeline("s1");
        expect(timelines.cachedTimeline("s1", 7)).toBeNull();
    });
});

describe("replyQuote", () => {
    it("quotes the first paragraph and mentions the author", () => {
        expect(replyQuote("bob", "line one\nline two\n\nrest")).toBe("> line one\n> line two\n\n@bob ");
        expect(replyQuote("bob", "")).toBe("@bob ");
    });
});

describe("mergeBlock", () => {
    const base = { state: "open" as const, draft: false, mergeState: "CLEAN", push: null };
    it("offers merge unless GitHub reports it blocked", () => {
        expect(review.mergeBlock(base)).toBeNull();
        expect(review.mergeBlock({ ...base, mergeState: "unstable" })).toBeNull();
        expect(review.mergeBlock({ ...base, mergeState: "UNKNOWN" })).toBeNull();
        expect(review.mergeBlock({ ...base, mergeState: "blocked" })).toBe("protected");
        expect(review.mergeBlock({ ...base, mergeState: "DIRTY" })).toBe("conflicts");
        expect(review.mergeBlock({ ...base, mergeState: "behind" })).toBe("behind");
        expect(review.mergeBlock({ ...base, draft: true })).toBe("draft");
        expect(review.mergeBlock({ ...base, push: "disabled" })).toBe("readOnly");
        expect(review.mergeBlock({ ...base, state: "merged" })).toBe("notOpen");
    });
});

describe("parsePullRef", () => {
    it("reads a number, #number or a GitHub link", () => {
        expect(review.parsePullRef("12")).toEqual({ number: 12, repoFullName: null });
        expect(review.parsePullRef(" #12 ")).toEqual({ number: 12, repoFullName: null });
        expect(review.parsePullRef("https://github.com/O/r/pull/12/files")).toEqual({ number: 12, repoFullName: "O/r" });
        expect(review.parsePullRef("0")).toBeNull();
        expect(review.parsePullRef("http://github.com/o/r/pull/1")).toBeNull();
        expect(review.parsePullRef("https://evil.example/o/r/pull/1")).toBeNull();
        expect(review.parsePullRef("https://github.com/o/r/issues/1")).toBeNull();
    });
});

describe("claimSessionPullRequest", () => {
    const open = { number: 12, url: "https://github.com/o/r/pull/12", title: "", state: "open" as const, draft: true };
    let recorded: unknown[];
    let deps: review.ClaimDeps;
    const session = { id: "s1", repoFullName: "o/r", state: "running", pullRequest: null };

    beforeEach(() => {
        recorded = [];
        deps = {
            token: vi.fn(async () => "t"),
            read: vi.fn(async () => open),
            holders: vi.fn(async () => []),
            record: vi.fn(async (...args) => {
                recorded.push(args);
            })
        };
    });

    it("links an open pull request, a draft included", async () => {
        const result = await review.claimSessionPullRequest(session as never, "#12", { takeover: false }, deps);
        expect(result).toEqual({ kind: "claimed", pull: open, takenFrom: [] });
        expect(recorded).toHaveLength(1);
    });

    it("refuses another repository, a closed one, and an ended session", async () => {
        expect(
            await review.claimSessionPullRequest(session as never, "https://github.com/x/r/pull/12", { takeover: false }, deps)
        ).toEqual({ kind: "refused", reason: "otherRepo" });
        deps.read = vi.fn(async () => ({ ...open, state: "merged" as const }));
        expect(await review.claimSessionPullRequest(session as never, "12", { takeover: false }, deps)).toEqual({
            kind: "refused",
            reason: "notOpen"
        });
        expect(
            await review.claimSessionPullRequest({ ...session, state: "stopped" } as never, "12", { takeover: false }, deps)
        ).toEqual({ kind: "refused", reason: "ended" });
        expect(recorded).toHaveLength(0);
    });

    it("never takes one from another live session without takeover", async () => {
        deps.holders = vi.fn(async () => ["s2"]);
        expect(await review.claimSessionPullRequest(session as never, "12", { takeover: false }, deps)).toEqual({
            kind: "refused",
            reason: "taken"
        });
        const moved = await review.claimSessionPullRequest(session as never, "12", { takeover: true }, deps);
        expect(moved).toMatchObject({ kind: "claimed", takenFrom: ["s2"] });
        expect(recorded[0]).toEqual([session, open, ["s2"]]);
    });

    it("refuses without GitHub access or when GitHub has no such pull request", async () => {
        deps.token = vi.fn(async () => null);
        expect(await review.claimSessionPullRequest(session as never, "12", { takeover: false }, deps)).toEqual({
            kind: "refused",
            reason: "noAuth"
        });
        deps.token = vi.fn(async () => "t");
        deps.read = vi.fn(async () => null);
        expect(await review.claimSessionPullRequest(session as never, "12", { takeover: false }, deps)).toEqual({
            kind: "refused",
            reason: "missing"
        });
    });
});

describe("replyOnSessionPull", () => {
    it("refuses a thread that is not on this pull request", async () => {
        const timeline = timelines.timelineFrom(pull() as never);
        timelines.rememberTimeline("s9", timeline);
        const session = { id: "s9", repoFullName: "o/r", pullRequest: { number: 7, url: "" } };
        expect(await review.replyOnSessionPull(session, "u", { body: "hi", threadId: "PRRT_other" })).toEqual({
            ok: false,
            reason: "unknownThread"
        });
    });

    it("posts a conversation comment", async () => {
        const session = { id: "s9", repoFullName: "o/r", pullRequest: { number: 7, url: "" } };
        expect(await review.replyOnSessionPull(session, "u", { body: "hi" })).toEqual({ ok: true });
    });
});
