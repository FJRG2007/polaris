/**
 * A pool with fewer slots than repositories is choosing whose jobs wait, every
 * thirty seconds, forever. These cover the choices that are easy to get subtly
 * wrong: one busy repository starving the rest, a runner idling on a repository
 * with nothing to do while another has work, and a budget that stops being a
 * budget the moment somebody set it to "warn".
 */

import { describe, expect, it } from "vitest";
import {
    budgetVerdict,
    NO_RUNNER_LIMITS,
    placeRunners,
    windowStart,
    type TargetState
} from "../src/runner-placement.js";

function target(key: string, state: Partial<TargetState> = {}): TargetState {
    return { key, queued: 0, live: 0, idle: 0, blocked: null, lastServedAt: 0, ...state };
}

describe("placeRunners", () => {
    it("serves queued work before it parks anything", () => {
        const plan = placeRunners({
            free: 1,
            perTargetConcurrent: null,
            targets: [target("acme/idle"), target("acme/busy", { queued: 3 })]
        });
        expect(plan.start).toEqual(["acme/busy"]);
        expect(plan.release).toEqual([]);
    });

    it("shares the slots out rather than letting one repository take them all", () => {
        const plan = placeRunners({
            free: 2,
            perTargetConcurrent: null,
            targets: [target("acme/a", { queued: 8 }), target("acme/b", { queued: 1 })]
        });
        expect([...plan.start].sort()).toEqual(["acme/a", "acme/b"]);
    });

    it("serves whoever has waited longest when everything else is equal", () => {
        const plan = placeRunners({
            free: 1,
            perTargetConcurrent: null,
            targets: [
                target("acme/recent", { queued: 1, lastServedAt: 5_000 }),
                target("acme/stale", { queued: 1, lastServedAt: 1_000 })
            ]
        });
        expect(plan.start).toEqual(["acme/stale"]);
    });

    it("does not stack a second runner on work something is already waiting to take", () => {
        const plan = placeRunners({
            free: 1,
            perTargetConcurrent: null,
            targets: [
                target("acme/covered", { queued: 1, live: 1, idle: 1 }),
                target("acme/uncovered", { queued: 1 })
            ]
        });
        expect(plan.start).toEqual(["acme/uncovered"]);
    });

    it("honours a per-repository ceiling even with slots to spare", () => {
        const plan = placeRunners({
            free: 4,
            perTargetConcurrent: 2,
            targets: [target("acme/greedy", { queued: 9 })]
        });
        expect(plan.start).toEqual(["acme/greedy", "acme/greedy"]);
    });

    it("takes an idle runner off a quiet repository to pay for a busy one", () => {
        const plan = placeRunners({
            free: 0,
            perTargetConcurrent: null,
            targets: [
                target("acme/quiet", { live: 2, idle: 2 }),
                target("acme/waiting", { queued: 1 })
            ]
        });
        expect(plan.release).toEqual(["acme/quiet"]);
        expect(plan.start).toEqual(["acme/waiting"]);
    });

    it("never takes a runner that is running a job", () => {
        const plan = placeRunners({
            free: 0,
            perTargetConcurrent: null,
            targets: [target("acme/working", { live: 2, idle: 0 }), target("acme/waiting", { queued: 1 })]
        });
        expect(plan.release).toEqual([]);
        expect(plan.start).toEqual([]);
    });

    it("leaves a repository that is over its budget alone entirely", () => {
        const plan = placeRunners({
            free: 2,
            perTargetConcurrent: null,
            targets: [target("acme/spent", { queued: 5, blocked: "Used 600 of 600 minutes this month." })]
        });
        expect(plan.start).toEqual([]);
    });

    it("parks spare slots where they are most useful, one repository at a time", () => {
        const plan = placeRunners({
            free: 3,
            perTargetConcurrent: null,
            targets: [target("acme/a"), target("acme/b"), target("acme/c")]
        });
        expect([...plan.start].sort()).toEqual(["acme/a", "acme/b", "acme/c"]);
    });

    it("still gives a single-repository pool every slot it has", () => {
        const plan = placeRunners({ free: 3, perTargetConcurrent: null, targets: [target("acme/only")] });
        expect(plan.start).toEqual(["acme/only", "acme/only", "acme/only"]);
    });

    it("plans nothing for a pool with nothing to serve", () => {
        expect(placeRunners({ free: 4, perTargetConcurrent: null, targets: [] })).toEqual({ start: [], release: [] });
    });
});

describe("budgetVerdict", () => {
    it("allows anything when nothing was limited", () => {
        expect(budgetVerdict({ minutes: 9_999, jobsToday: 500 }, NO_RUNNER_LIMITS)).toEqual({
            allowed: true,
            exceeded: null
        });
    });

    it("stops a repository that spent its minutes", () => {
        const verdict = budgetVerdict(
            { minutes: 601, jobsToday: 0 },
            { ...NO_RUNNER_LIMITS, minutesBudget: 600, minutesWindow: "month" }
        );
        expect(verdict.allowed).toBe(false);
        expect(verdict.exceeded).toContain("600 minutes this month");
    });

    it("stops a repository that ran its jobs for the day", () => {
        const verdict = budgetVerdict({ minutes: 0, jobsToday: 20 }, { ...NO_RUNNER_LIMITS, jobsPerDay: 20 });
        expect(verdict.allowed).toBe(false);
        expect(verdict.exceeded).toContain("20 of 20 jobs");
    });

    it("keeps serving, and still says so, when the pool was told only to warn", () => {
        const verdict = budgetVerdict(
            { minutes: 700, jobsToday: 0 },
            { ...NO_RUNNER_LIMITS, minutesBudget: 600, onExhausted: "warn" }
        );
        expect(verdict.allowed).toBe(true);
        expect(verdict.exceeded).not.toBeNull();
    });
});

describe("windowStart", () => {
    it("uses calendar boundaries in UTC, so the card and the refusal agree", () => {
        const now = new Date("2026-08-17T09:30:00Z");
        expect(windowStart("day", now).toISOString()).toBe("2026-08-17T00:00:00.000Z");
        expect(windowStart("month", now).toISOString()).toBe("2026-08-01T00:00:00.000Z");
    });
});
