/**
 * The derived session status: the precedence, the pull request pipeline, the
 * stack rule and the mapping from a stored session. Cases ported from
 * backend/pkg/contract/status_test.go of Agent Orchestrator (Apache-2.0), plus
 * the Polaris additions (merge_conflict, the session row mapping).
 */

import { describe, expect, it } from "vitest";
import { AGENT_SESSION_STATES, type AgentSessionState } from "@polaris/core";
import * as status from "@/lib/agents/session-status";

const now = new Date("2026-06-10T12:00:00Z");

function session(activity: status.ActivityState, extra: Partial<status.SessionFacts> = {}): status.SessionFacts {
    return {
        activity,
        lastActivityAt: now,
        hasSignal: true,
        signalExpected: true,
        isTerminated: false,
        ...extra
    };
}

const terminated: status.SessionFacts = session("idle", { isTerminated: true });

function pr(extra: Partial<status.PullFacts> = {}): status.PullFacts {
    return {
        url: "https://github.com/acme/app/pull/1",
        draft: false,
        merged: false,
        closed: false,
        ci: "unknown",
        review: "none",
        mergeability: "unknown",
        reviewComments: false,
        sourceBranch: "",
        targetBranch: "",
        ...extra
    };
}

describe("status.deriveSessionStatus precedence", () => {
    it.each<[string, status.SessionFacts, status.PullFacts[], status.SessionStatus]>([
        ["terminated", terminated, [], "terminated"],
        ["terminated merged", terminated, [pr({ merged: true })], "merged"],
        ["terminated closed only", terminated, [pr({ closed: true })], "terminated"],
        ["terminated merged with open pr", terminated, [pr({ merged: true }), pr()], "terminated"],
        ["terminated all merged", terminated, [pr({ merged: true }), pr({ merged: true })], "merged"],
        ["terminated wins over waiting", session("waiting_input", { isTerminated: true }), [], "terminated"],
        ["active before PR", session("active"), [pr({ ci: "failing" })], "working"],
        ["exited before PR", session("exited"), [pr({ mergeability: "mergeable" })], "exited"],
        ["waiting before PR", session("waiting_input"), [pr({ ci: "failing" })], "needs_input"],
        ["blocked before PR", session("blocked"), [pr({ ci: "failing" })], "needs_input"],
        ["PR before idle", session("idle"), [pr({ ci: "failing" })], "ci_failed"],
        ["merged PR on a live session", session("idle"), [pr({ merged: true })], "merged"],
        ["closed PR on a live session", session("idle"), [pr({ closed: true })], "idle"],
        ["idle", session("idle"), [], "idle"]
    ])("%s", (_name, facts, prs, want) => {
        expect(status.deriveSessionStatus(facts, prs, now, 90_000)).toBe(want);
    });

    it("uses the 90 second grace by default", () => {
        expect(status.NO_SIGNAL_GRACE_MS).toBe(90_000);
        const silent = session("idle", {
            hasSignal: false,
            lastActivityAt: new Date(now.getTime() - 91_000)
        });
        expect(status.deriveSessionStatus(silent, [], now)).toBe("no_signal");
    });
});

describe("status.deriveSessionStatus no-signal rules", () => {
    const grace = 90_000;
    const silent = session("idle", {
        hasSignal: false,
        lastActivityAt: new Date(now.getTime() - 2 * grace)
    });

    it.each<[string, status.SessionFacts, Date, status.SessionStatus]>([
        ["past grace", silent, now, "no_signal"],
        ["signal not expected", { ...silent, signalExpected: false }, now, "idle"],
        ["signal received", { ...silent, hasSignal: true }, now, "idle"],
        ["at boundary", silent, new Date(silent.lastActivityAt.getTime() + grace), "idle"],
        ["just past boundary", silent, new Date(silent.lastActivityAt.getTime() + grace + 1), "no_signal"]
    ])("%s", (_name, facts, at, want) => {
        expect(status.deriveSessionStatus(facts, [], at, grace)).toBe(want);
    });

    it("lets a PR speak before silence does", () => {
        expect(status.deriveSessionStatus(silent, [pr({ draft: true })], now, grace)).toBe("draft");
    });
});

describe("status.deriveScmStatus pipeline and worst-wins", () => {
    it.each<[string, status.PullFacts[], status.SessionStatus | null]>([
        ["no PRs", [], null],
        ["closed ignored", [pr({ closed: true })], null],
        ["merged", [pr({ merged: true })], "merged"],
        ["open", [pr()], "pr_open"],
        ["review pending", [pr({ review: "review_required" })], "review_pending"],
        [
            "review pending with provider merge blocker",
            [pr({ review: "review_required", mergeability: "blocked" })],
            "review_pending"
        ],
        ["approved", [pr({ review: "approved" })], "approved"],
        ["mergeable", [pr({ mergeability: "mergeable" })], "mergeable"],
        ["unstable reads as open", [pr({ mergeability: "unstable" })], "pr_open"],
        ["merge blocked", [pr({ mergeability: "blocked" })], "pr_open"],
        [
            "merge blocked with approved review",
            [pr({ mergeability: "blocked", review: "approved" })],
            "pr_open"
        ],
        ["conflict", [pr({ mergeability: "conflicting" })], "merge_conflict"],
        [
            "conflict over approved",
            [pr({ mergeability: "conflicting", review: "approved" })],
            "merge_conflict"
        ],
        ["changes requested", [pr({ review: "changes_requested" })], "changes_requested"],
        [
            "review required with unresolved comments",
            [pr({ review: "review_required", reviewComments: true })],
            "commented"
        ],
        ["unresolved comments alone", [pr({ reviewComments: true })], "commented"],
        [
            "comments over conflict",
            [pr({ reviewComments: true, mergeability: "conflicting" })],
            "commented"
        ],
        ["draft", [pr({ draft: true })], "draft"],
        ["draft over changes requested", [pr({ draft: true, review: "changes_requested" })], "draft"],
        ["CI failed", [pr({ ci: "failing" })], "ci_failed"],
        ["CI failed over draft", [pr({ ci: "failing", draft: true })], "ci_failed"],
        ["CI pending is still open", [pr({ ci: "pending" })], "pr_open"],
        [
            "worst wins",
            [
                pr({ url: "a", sourceBranch: "a", targetBranch: "main", mergeability: "mergeable" }),
                pr({ url: "b", sourceBranch: "b", targetBranch: "main", ci: "failing" })
            ],
            "ci_failed"
        ],
        [
            "open beats merged sibling",
            [pr({ url: "a", merged: true }), pr({ url: "b", review: "approved" })],
            "approved"
        ]
    ])("%s", (_name, prs, want) => {
        expect(status.deriveScmStatus(prs)).toBe(want);
    });

    it("orders every pipeline status by severity, worst first", () => {
        const ordered: status.PullFacts[] = [
            pr({ ci: "failing" }),
            pr({ review: "changes_requested" }),
            pr({ reviewComments: true }),
            pr({ mergeability: "conflicting" }),
            pr({ draft: true }),
            pr({ review: "review_required" }),
            pr(),
            pr({ review: "approved" }),
            pr({ mergeability: "mergeable" })
        ].map((facts, index) => ({ ...facts, url: `u${index}` }));
        for (let worse = 0; worse < ordered.length; worse++) {
            for (let better = worse + 1; better < ordered.length; better++) {
                const want = status.pullPipelineStatus(ordered[worse]!);
                expect(status.deriveScmStatus([ordered[better]!, ordered[worse]!])).toBe(want);
                expect(status.deriveScmStatus([ordered[worse]!, ordered[better]!])).toBe(want);
            }
        }
    });
});

describe("stacks", () => {
    const parent = pr({
        url: "parent",
        sourceBranch: "feature",
        targetBranch: "main",
        mergeability: "mergeable"
    });
    const child = pr({ url: "child", sourceBranch: "feature/child", targetBranch: "feature" });

    it("marks the child as blocked by its open parent", () => {
        const positions = status.buildStacks([parent, child]);
        expect(positions.get("parent")).toEqual({ blocked: false, bottomOfStack: true });
        expect(positions.get("child")).toEqual({ blocked: true, bottomOfStack: false });
    });

    it("suppresses a blocked child's readiness", () => {
        expect(status.deriveScmStatus([parent, child])).toBe("mergeable");
    });

    it.each<[string, Partial<status.PullFacts>, status.SessionStatus]>([
        ["CI failure", { ci: "failing" }, "ci_failed"],
        ["draft", { draft: true }, "draft"],
        ["changes requested", { review: "changes_requested" }, "changes_requested"],
        ["comments", { reviewComments: true }, "commented"],
        ["conflict", { mergeability: "conflicting" }, "merge_conflict"]
    ])("keeps a blocked child's %s", (_name, extra, want) => {
        expect(status.deriveScmStatus([parent, { ...child, ...extra }])).toBe(want);
    });

    it("falls back to every open PR when all of them are blocked", () => {
        const a = pr({ url: "a", sourceBranch: "a", targetBranch: "b", review: "approved" });
        const b = pr({ url: "b", sourceBranch: "b", targetBranch: "a", mergeability: "mergeable" });
        expect(status.deriveScmStatus([a, b])).toBe("approved");
    });

    it("stops blocking once the parent merged", () => {
        const positions = status.buildStacks([{ ...parent, merged: true }, child]);
        expect(positions.get("child")?.blocked).toBe(false);
    });
});

describe("every status is reachable", () => {
    it("produces each listed status from some facts", () => {
        const silent = session("idle", { hasSignal: false, lastActivityAt: new Date(0) });
        const reached = new Set<status.SessionStatus>([
            status.deriveSessionStatus(session("active"), [], now),
            status.deriveSessionStatus(session("exited"), [], now),
            status.deriveSessionStatus(session("blocked"), [], now),
            status.deriveSessionStatus(session("idle"), [], now),
            status.deriveSessionStatus(silent, [], now),
            status.deriveSessionStatus(terminated, [], now),
            status.deriveSessionStatus(terminated, [pr({ merged: true })], now),
            ...[
                pr(),
                pr({ draft: true }),
                pr({ ci: "failing" }),
                pr({ review: "review_required" }),
                pr({ review: "changes_requested" }),
                pr({ reviewComments: true }),
                pr({ mergeability: "conflicting" }),
                pr({ review: "approved" }),
                pr({ mergeability: "mergeable" })
            ].map((facts) => status.deriveSessionStatus(session("idle"), [facts], now))
        ]);
        expect([...reached].sort()).toEqual([...status.SESSION_STATUSES].sort());
    });
});

describe("status.sessionFactsFrom", () => {
    const created = new Date("2026-06-10T11:00:00Z");
    const started = new Date("2026-06-10T11:01:00Z");
    const event = new Date("2026-06-10T11:30:00Z");

    const expected: Record<AgentSessionState, Pick<status.SessionFacts, "activity" | "isTerminated" | "signalExpected">> = {
        queued: { activity: "idle", isTerminated: false, signalExpected: false },
        starting: { activity: "idle", isTerminated: false, signalExpected: true },
        working: { activity: "active", isTerminated: false, signalExpected: true },
        waiting: { activity: "waiting_input", isTerminated: false, signalExpected: true },
        idle: { activity: "idle", isTerminated: false, signalExpected: true },
        stopped: { activity: "idle", isTerminated: true, signalExpected: true },
        failed: { activity: "idle", isTerminated: true, signalExpected: true }
    };

    it.each([...AGENT_SESSION_STATES])("maps %s", (state) => {
        const facts = status.sessionFactsFrom({ state, lastEventAt: event, startedAt: started, createdAt: created });
        expect(facts).toMatchObject(expected[state]);
        expect(facts.hasSignal).toBe(true);
        expect(facts.lastActivityAt).toBe(event);
    });

    it("falls back to the start, then the creation, for a silent session", () => {
        expect(
            status.sessionFactsFrom({ state: "starting", lastEventAt: null, startedAt: started, createdAt: created })
        ).toMatchObject({ hasSignal: false, lastActivityAt: started });
        expect(
            status.sessionFactsFrom({ state: "starting", lastEventAt: null, startedAt: null, createdAt: created })
        ).toMatchObject({ hasSignal: false, lastActivityAt: created });
    });

    it("reads a queued session as idle however long it waits", () => {
        const facts = status.sessionFactsFrom({ state: "queued", lastEventAt: null, startedAt: null, createdAt: new Date(0) });
        expect(status.deriveSessionStatus(facts, [], now)).toBe("idle");
    });

    it("reads a started session that never reported as no_signal past the grace", () => {
        const facts = status.sessionFactsFrom({ state: "starting", lastEventAt: null, startedAt: new Date(0), createdAt: new Date(0) });
        expect(status.deriveSessionStatus(facts, [], now)).toBe("no_signal");
    });
});
