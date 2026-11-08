/**
 * The graph of an orchestration run: what may start, what is blocked and why,
 * and what a coordinator may add under the run's bounds.
 */

import { describe, expect, it } from "vitest";
import * as plan from "@/lib/agents/orchestration-plan";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 10, minute));

function task(id: string, overrides: Partial<plan.PlanTask> = {}): plan.PlanTask {
    return {
        id,
        status: "pending",
        blockedBy: null,
        dependsOn: [],
        depth: 0,
        gateQuestion: null,
        gateResolution: null,
        createdAt: at(0),
        ...overrides
    };
}

describe("resolveStatuses", () => {
    it("readies a task that waits on nothing", () => {
        expect(plan.resolveStatuses([task("a")])).toEqual([
            { id: "a", status: "ready", blockedBy: null }
        ]);
    });

    it("keeps a task pending until every dependency has completed", () => {
        const tasks = [
            task("a", { status: "completed" }),
            task("b", { status: "dispatched" }),
            task("c", { dependsOn: ["a", "b"], depth: 1 })
        ];
        expect(plan.resolveStatuses(tasks)).toEqual([]);
        const done = tasks.map((t) => (t.id === "b" ? { ...t, status: "completed" as const } : t));
        expect(plan.resolveStatuses(done)).toEqual([{ id: "c", status: "ready", blockedBy: null }]);
    });

    it("blocks the whole chain below a failed task", () => {
        const tasks = [
            task("a", { status: "failed" }),
            task("b", { dependsOn: ["a"], depth: 1 }),
            task("c", { dependsOn: ["b"], depth: 2 })
        ];
        expect(plan.resolveStatuses(tasks)).toEqual([
            { id: "b", status: "blocked", blockedBy: "dependency" },
            { id: "c", status: "blocked", blockedBy: "dependency" }
        ]);
    });

    it("holds a gated task for a person, then lets an approval through", () => {
        const gated = task("a", { gateQuestion: "Ship the migration?" });
        expect(plan.resolveStatuses([gated])).toEqual([
            { id: "a", status: "blocked", blockedBy: "gate" }
        ]);
        const waiting = { ...gated, status: "blocked" as const, blockedBy: "gate" as const };
        expect(plan.resolveStatuses([waiting])).toEqual([]);
        expect(plan.resolveStatuses([{ ...waiting, gateResolution: "approve" }])).toEqual([
            { id: "a", status: "ready", blockedBy: null }
        ]);
        expect(plan.resolveStatuses([{ ...waiting, gateResolution: plan.GATE_REJECT }])).toEqual([
            { id: "a", status: "failed", blockedBy: null, outcome: "rejected" }
        ]);
    });

    it("does not block what waits behind a gate that is still open", () => {
        const tasks = [
            task("a", { status: "blocked", blockedBy: "gate", gateQuestion: "?" }),
            task("b", { dependsOn: ["a"], depth: 1 })
        ];
        expect(plan.resolveStatuses(tasks)).toEqual([]);
    });

    it("is a no-op the second time", () => {
        const tasks = [task("a"), task("b", { dependsOn: ["a"], depth: 1 })];
        const applied = tasks.map((t) => {
            const change = plan.resolveStatuses(tasks).find((c) => c.id === t.id);
            return change ? { ...t, status: change.status, blockedBy: change.blockedBy } : t;
        });
        expect(plan.resolveStatuses(applied)).toEqual([]);
    });
});

describe("toDispatch", () => {
    it("dispatches the oldest ready tasks within the run's concurrency", () => {
        const tasks = [
            { id: "x", status: "dispatched", createdAt: at(0) },
            { id: "c", status: "ready", createdAt: at(3) },
            { id: "a", status: "ready", createdAt: at(1) },
            { id: "b", status: "ready", createdAt: at(2) }
        ];
        expect(plan.toDispatch(tasks, 3)).toEqual(["a", "b"]);
        expect(plan.toDispatch(tasks, 1)).toEqual([]);
    });
});

describe("placeNewTask", () => {
    const run = { maxTasks: 3, maxDepth: 2 };

    it("puts a task one below its deepest dependency", () => {
        expect(plan.placeNewTask(run, [{ id: "a", depth: 0 }], ["a"])).toEqual({ depth: 1 });
    });

    it("refuses past the run's task count", () => {
        const three = ["a", "b", "c"].map((id) => ({ id, depth: 0 }));
        expect(plan.placeNewTask(run, three, [])).toHaveProperty("error");
    });

    it("refuses past the run's depth", () => {
        expect(plan.placeNewTask(run, [{ id: "a", depth: 1 }], ["a"])).toHaveProperty("error");
    });

    it("refuses a dependency that is not in the run, so the graph cannot hold a cycle", () => {
        expect(plan.placeNewTask(run, [], ["nope"])).toHaveProperty("error");
    });
});

describe("runIsDone", () => {
    it("is done once every task is finished with, and not while a gate waits", () => {
        expect(plan.runIsDone([])).toBe(false);
        expect(
            plan.runIsDone([
                { status: "completed", blockedBy: null },
                { status: "blocked", blockedBy: "dependency" }
            ])
        ).toBe(true);
        expect(plan.runIsDone([{ status: "blocked", blockedBy: "gate" }])).toBe(false);
    });
});
