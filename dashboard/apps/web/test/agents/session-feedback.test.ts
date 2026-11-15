/**
 * Feedback routing: a pull request's failing checks, review comments and merge
 * conflicts reach the owning session once per fact, never after it ended or
 * with its switch off, at most a few rounds per head commit, and the notices a
 * change raises are raised once - not for every old pull request the first
 * read after an update finds.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

import * as feedback from "@/lib/agents/session-feedback";
import type { PullObservation } from "@/lib/agents/session-pr-facts";

const empty = (): feedback.FeedbackState => ({ seen: {}, attempts: {}, head: "", rounds: 0 });

function observation(over: Partial<PullObservation> = {}): PullObservation {
    return {
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        state: "open",
        draft: false,
        mergeable: "unknown",
        checks: "passing",
        checksTotal: 3,
        checksFailed: 0,
        checksPending: 0,
        review: "none",
        unresolvedComments: 0,
        headSha: "aaa111",
        sourceBranch: "polaris/fix",
        targetBranch: "main",
        ...over
    };
}

const thread = (id: string, commentIds: string[] = ["c1"]): feedback.ReviewThread => ({
    id,
    path: "src/app.ts",
    line: 12,
    side: "new",
    code: "const x = 1;",
    comments: commentIds.map((cid) => ({ id: cid, author: "reviewer", body: `fix ${cid}` }))
});

const words = (key: string, values?: Record<string, string | number>) =>
    values ? `${key} ${JSON.stringify(values)}` : key;

describe("planFeedback", () => {
    it("plans each condition on its own, so a failure never hides a conflict or a comment", () => {
        const plan = feedback.planFeedback(
            empty(),
            observation({ checks: "failing", checksFailed: 2, mergeable: "conflicting", unresolvedComments: 1 }),
            { threads: [thread("t1")], reviews: [] }
        );
        expect(plan.ci?.key).toBe("ci:7");
        expect(plan.conflict?.key).toBe("conflict:7");
        expect(plan.threads.map((one) => one.nudge.key)).toEqual(["thread:7:t1"]);
    });

    it("reports a fact once: the same signature under the same key is not planned again", () => {
        const facts = observation({ checks: "failing", checksFailed: 1 });
        const first = feedback.planFeedback(empty(), facts, null);
        const after = feedback.recordSent(first.state, [first.ci!]);
        expect(feedback.planFeedback(after, facts, null).ci).toBeNull();
        // A second check failing on the same commit is a new fact.
        expect(feedback.planFeedback(after, observation({ checks: "failing", checksFailed: 2 }), null).ci).not.toBeNull();
    });

    it("a new comment on a thread already reported is new feedback", () => {
        const first = feedback.planFeedback(empty(), observation({ unresolvedComments: 1 }), { threads: [thread("t1")], reviews: [] });
        const after = feedback.recordSent(first.state, first.threads.map((one) => one.nudge));
        const again = feedback.planFeedback(after, observation({ unresolvedComments: 1 }), { threads: [thread("t1")], reviews: [] });
        expect(again.threads).toHaveLength(0);
        const more = feedback.planFeedback(after, observation({ unresolvedComments: 1 }), {
            threads: [thread("t1", ["c1", "c2"])],
            reviews: []
        });
        expect(more.threads).toHaveLength(1);
    });

    it("stops after the rounds a head commit gets, and starts again after a push", () => {
        let state = empty();
        for (let round = 0; round < feedback.ROUNDS_PER_HEAD; round++) {
            const plan = feedback.planFeedback(state, observation({ checks: "failing", checksFailed: round + 1 }), null);
            expect(plan.ci).not.toBeNull();
            state = feedback.recordSent(plan.state, [plan.ci!]);
        }
        expect(feedback.planFeedback(state, observation({ checks: "failing", checksFailed: 9 }), null).ci).toBeNull();
        const pushed = feedback.planFeedback(state, observation({ checks: "failing", checksFailed: 1, headSha: "bbb222" }), null);
        expect(pushed.ci).not.toBeNull();
        expect(pushed.state.rounds).toBe(0);
    });

    it("gives one comment its own attempt budget", () => {
        let state = empty();
        for (let attempt = 0; attempt < feedback.ATTEMPTS_PER_COMMENT; attempt++) {
            // A different head each time, so the round cap is not what stops it.
            const plan = feedback.planFeedback(state, observation({ unresolvedComments: 1, headSha: `h${attempt}` }), {
                threads: [thread("t1", [`c${attempt}`])],
                reviews: []
            });
            expect(plan.threads).toHaveLength(1);
            state = feedback.recordSent(plan.state, [plan.threads[0]!.nudge]);
        }
        const spent = feedback.planFeedback(state, observation({ unresolvedComments: 1, headSha: "h9" }), {
            threads: [thread("t1", ["c9"])],
            reviews: []
        });
        expect(spent.threads).toHaveLength(0);
    });

    it("re-arms the conflict nudge only when the conflict definitely cleared", () => {
        const conflicting = observation({ mergeable: "conflicting" });
        const first = feedback.planFeedback(empty(), conflicting, null);
        const sent = feedback.recordSent(first.state, [first.conflict!]);
        // Unknown is GitHub still computing: the conflict is not known gone.
        const unknown = feedback.planFeedback(sent, observation({ mergeable: "unknown" }), null);
        expect(feedback.planFeedback(unknown.state, conflicting, null).conflict).toBeNull();
        const cleared = feedback.planFeedback(sent, observation({ mergeable: "mergeable" }), null);
        expect(feedback.planFeedback(cleared.state, conflicting, null).conflict).not.toBeNull();
    });

    it("plans nothing for a pull request that is no longer open", () => {
        const plan = feedback.planFeedback(empty(), observation({ state: "merged", checks: "failing", checksFailed: 1 }), null);
        expect(plan.ci).toBeNull();
    });

    it("reads a stored state that is missing or malformed as nothing sent", () => {
        expect(feedback.readFeedbackState(null)).toEqual(empty());
        expect(feedback.readFeedbackState({ seen: "nope", rounds: -1 })).toEqual(empty());
    });
});

describe("pullNoticeKinds", () => {
    const prev = (over: Partial<feedback.PreviousFacts> = {}) => ({
        state: "open",
        draft: false,
        checks: "passing",
        headSha: "aaa111",
        fetchedAt: new Date("2026-11-15T10:00:00Z"),
        feedback: {},
        ...over
    });

    it("raises nothing for a pull request never stored before", () => {
        expect(feedback.pullNoticeKinds(null, observation({ checks: "failing" }))).toEqual([]);
    });

    it("raises a failure once per commit", () => {
        expect(feedback.pullNoticeKinds(prev(), observation({ checks: "failing" }))).toEqual(["ci_failed"]);
        expect(feedback.pullNoticeKinds(prev({ checks: "failing" }), observation({ checks: "failing" }))).toEqual([]);
        expect(
            feedback.pullNoticeKinds(prev({ checks: "failing" }), observation({ checks: "failing", headSha: "bbb222" }))
        ).toEqual(["ci_failed"]);
    });

    it("raises ready when a draft becomes ready, and merged when it merges", () => {
        expect(feedback.pullNoticeKinds(prev({ draft: true }), observation())).toEqual(["pr_ready"]);
        expect(feedback.pullNoticeKinds(prev(), observation({ state: "merged" }))).toEqual(["pr_merged"]);
        expect(feedback.pullNoticeKinds(prev({ state: "merged" }), observation({ state: "merged" }))).toEqual([]);
    });

    it("treats a row seeded but never read as knowing nothing yet", () => {
        expect(feedback.pullNoticeKinds(prev({ fetchedAt: new Date(0) }), observation())).toEqual(["pr_ready"]);
    });
});

describe("prompts", () => {
    it("cuts a long comment and strips control characters", () => {
        const long = { ...thread("t1"), comments: [{ id: "c1", author: "r", body: `${"a".repeat(5_000)}\u001b[2J` }] };
        const text = feedback.reviewFeedbackPrompt(observation(), [long], [], words);
        expect(text.length).toBeLessThan(3_000);
        expect(text).not.toContain("\u001b");
        expect(text).toContain("https://github.com/acme/app/pull/7");
    });

    it("quotes a changes-requested review with its author", () => {
        const text = feedback.reviewFeedbackPrompt(observation(), [], [{ id: "r1", author: "lead", body: "Split this up." }], words);
        expect(text).toContain('session.feedback.changesRequested {"author":"lead"}');
        expect(text).toContain("Split this up.");
    });
});

describe("detailFrom", () => {
    it("keeps unresolved threads a person commented on, and drops a bot's words", () => {
        const detail = feedback.detailFrom({
            data: {
                repository: {
                    pullRequest: {
                        reviewThreads: {
                            nodes: [
                                {
                                    id: "T1",
                                    isResolved: false,
                                    path: "a.ts",
                                    line: null,
                                    originalLine: 4,
                                    diffSide: "LEFT",
                                    comments: {
                                        nodes: [
                                            { id: "C1", body: "why?", diffHunk: "@@ -1 +1 @@\n-old line", author: { login: "ann", __typename: "User" } },
                                            { id: "C2", body: "Fixed", diffHunk: null, author: { login: "polaris[bot]", __typename: "Bot" } }
                                        ]
                                    }
                                },
                                {
                                    id: "T2",
                                    isResolved: true,
                                    path: "b.ts",
                                    line: 1,
                                    originalLine: 1,
                                    diffSide: "RIGHT",
                                    comments: { nodes: [{ id: "C3", body: "ok", diffHunk: "", author: { login: "ann", __typename: "User" } }] }
                                },
                                {
                                    id: "T3",
                                    isResolved: false,
                                    path: "c.ts",
                                    line: 2,
                                    originalLine: 2,
                                    diffSide: "RIGHT",
                                    comments: { nodes: [{ id: "C4", body: "lint", diffHunk: "", author: { login: "bot", __typename: "Bot" } }] }
                                }
                            ]
                        },
                        reviews: { nodes: [{ id: "R1", body: "Please change", author: { login: "lead", __typename: "User" } }] }
                    }
                }
            }
        });
        expect(detail?.threads).toEqual([
            {
                id: "T1",
                path: "a.ts",
                line: 4,
                side: "old",
                code: "old line",
                comments: [{ id: "C1", author: "ann", body: "why?" }]
            }
        ]);
        expect(detail?.reviews).toEqual([{ id: "R1", author: "lead", body: "Please change" }]);
    });

    it("stores nothing from an answer with errors", () => {
        expect(feedback.detailFrom({ data: null, errors: [{ message: "x" }] })).toBeNull();
    });
});

describe("reactToPullFacts", () => {
    function deps(over: Partial<feedback.FeedbackDeps> = {}) {
        const queued: { key: string; text: string }[] = [];
        const notices: string[] = [];
        const saved: feedback.FeedbackState[] = [];
        let delivered = 0;
        const value: feedback.FeedbackDeps = {
            session: async () => ({ state: "idle", autoFeedback: true, ownerId: "owner" }),
            notice: async (_id, kind) => void notices.push(kind),
            words: async () => words,
            token: async () => "token",
            checks: async () => [{ name: "test", status: "completed", conclusion: "failure", url: null, summary: "boom" }],
            detail: async () => ({ threads: [thread("t1")], reviews: [] }),
            enqueue: async (_id, _owner, key, text) => {
                queued.push({ key, text });
                return true;
            },
            saveState: async (_id, _number, state) => void saved.push(state),
            deliver: async () => void delivered++,
            ...over
        };
        return { value, queued, notices, saved, delivered: () => delivered };
    }
    const previous: feedback.PreviousFacts = {
        state: "open",
        draft: false,
        checks: "pending",
        headSha: "aaa111",
        fetchedAt: new Date("2026-11-15T10:00:00Z"),
        feedback: {}
    };
    const input = (over: Partial<PullObservation> = {}, prev: feedback.PreviousFacts | null = previous) => ({
        sessionId: "s1",
        repoFullName: "acme/app",
        observation: observation(over),
        previous: prev
    });

    it("queues one message per kind, records them, and delivers to a session at its prompt", async () => {
        const d = deps();
        await feedback.reactToPullFacts(input({ checks: "failing", checksFailed: 1, unresolvedComments: 1 }), d.value);
        expect(d.queued.map((one) => one.key)).toEqual(["ci:7", "review:7"]);
        expect(d.queued[0]!.text).toContain("boom");
        expect(d.notices).toEqual(["ci_failed"]);
        expect(d.saved.at(-1)?.rounds).toBe(1);
        expect(d.delivered()).toBe(1);
    });

    it("leaves a session mid-turn to get it when the turn ends", async () => {
        const d = deps({ session: async () => ({ state: "working", autoFeedback: true, ownerId: "owner" }) });
        await feedback.reactToPullFacts(input({ checks: "failing", checksFailed: 1 }), d.value);
        expect(d.queued).toHaveLength(1);
        expect(d.delivered()).toBe(0);
    });

    it("sends nothing with the switch off or after the session ended, but still notifies", async () => {
        for (const session of [
            { state: "idle", autoFeedback: false, ownerId: "owner" },
            { state: "stopped", autoFeedback: true, ownerId: "owner" }
        ]) {
            const d = deps({ session: async () => session });
            await feedback.reactToPullFacts(input({ checks: "failing", checksFailed: 1 }), d.value);
            expect(d.queued).toEqual([]);
            expect(d.notices).toEqual(["ci_failed"]);
        }
    });

    it("does not record a fact the queue had no room for, so it goes later", async () => {
        const d = deps({ enqueue: async () => false });
        await feedback.reactToPullFacts(input({ checks: "failing", checksFailed: 1 }), d.value);
        expect(d.saved.at(-1)?.seen ?? {}).toEqual({});
        expect(d.delivered()).toBe(0);
    });

    it("does not read review detail when nothing asks for it", async () => {
        const detail = vi.fn(async () => null);
        const d = deps({ detail });
        await feedback.reactToPullFacts(input({ checks: "passing" }), d.value);
        expect(detail).not.toHaveBeenCalled();
        expect(d.queued).toEqual([]);
    });

    it("never throws, whatever a dependency does", async () => {
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const d = deps({
            session: async () => {
                throw new Error("db down");
            }
        });
        await expect(feedback.reactToPullFacts(input({ checks: "failing", checksFailed: 1 }), d.value)).resolves.toBeUndefined();
        quiet.mockRestore();
    });
});
