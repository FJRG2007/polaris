/**
 * Checklists, their steps and a task's dependencies are arranged the way tasks
 * are: the screen shows the drop the moment it is released, a drop that leaves
 * everything where it was writes nothing, and the up and down buttons name the
 * same neighbours a drag one place over would.
 */

import { describe, expect, it } from "vitest";
import * as order from "@/app/(app)/tasks/subwork-order";
import type { ChecklistView, DependencyView } from "@/lib/tasks/task-service";

const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
const ids = (list: readonly { id: string }[]) => list.map((row) => row.id);

const step = (id: string) => ({ id, name: id, done: false, assigneeId: null });
const checklists: ChecklistView[] = [
    { id: "design", name: "Design", items: [step("s1"), step("s2"), step("s3")] },
    { id: "build", name: "Build", items: [step("s4")] }
];

const edge = (id: string, direction: "blocking" | "waitingOn"): DependencyView => ({
    id,
    type: "blocks",
    direction,
    taskId: `task-${id}`,
    reference: id.toUpperCase(),
    name: id,
    statusName: "Open",
    statusColor: "#64748b",
    finished: false
});

describe("placing a row", () => {
    it("puts it between the neighbours the drop named", () => {
        expect(ids(order.placeRow(rows, "a", { beforeId: "c", afterId: "d" }))).toEqual([
            "b",
            "c",
            "a",
            "d"
        ]);
        expect(ids(order.placeRow(rows, "d", { beforeId: null, afterId: "a" }))).toEqual([
            "d",
            "a",
            "b",
            "c"
        ]);
    });

    it("keeps every row exactly once", () => {
        const placed = order.placeRow(rows, "b", { beforeId: "d", afterId: null });
        expect(ids(placed).sort()).toEqual(["a", "b", "c", "d"]);
    });

    it("knows a drop back on its own place is no move", () => {
        const next = order.placeRow(rows, "b", { beforeId: "a", afterId: "c" });
        expect(order.samePlace(rows, next)).toBe(true);
        expect(order.samePlace(rows, order.placeRow(rows, "b", { beforeId: "c", afterId: "d" }))).toBe(
            false
        );
    });
});

describe("moving one place with the buttons", () => {
    it("names the neighbours a drag one row over would", () => {
        expect(order.shiftPosition(rows, "c", -1)).toEqual({ beforeId: "a", afterId: "b" });
        expect(order.shiftPosition(rows, "b", 1)).toEqual({ beforeId: "c", afterId: "d" });
        expect(ids(order.placeRow(rows, "c", order.shiftPosition(rows, "c", -1)!))).toEqual([
            "a",
            "c",
            "b",
            "d"
        ]);
    });

    it("goes nowhere past either end", () => {
        expect(order.shiftPosition(rows, "a", -1)).toBeNull();
        expect(order.shiftPosition(rows, "d", 1)).toBeNull();
        expect(order.shiftPosition(rows, "missing", 1)).toBeNull();
    });
});

describe("placing a step", () => {
    it("reorders it inside its own checklist", () => {
        const next = order.placeStep(checklists, "s3", "design", { beforeId: null, afterId: "s1" });
        expect(ids(next[0]!.items)).toEqual(["s3", "s1", "s2"]);
        expect(ids(next[1]!.items)).toEqual(["s4"]);
    });

    it("carries it into another checklist on the task", () => {
        const next = order.placeStep(checklists, "s2", "build", { beforeId: "s4", afterId: null });
        expect(ids(next[0]!.items)).toEqual(["s1", "s3"]);
        expect(ids(next[1]!.items)).toEqual(["s4", "s2"]);
    });

    it("changes nothing for a step or checklist that is not there", () => {
        expect(order.placeStep(checklists, "gone", "build", { beforeId: null, afterId: null })).toEqual(
            checklists
        );
        expect(order.placeStep(checklists, "s1", "gone", { beforeId: null, afterId: null })).toEqual(
            checklists
        );
    });
});

describe("placing a dependency", () => {
    const dependencies = [
        edge("w1", "waitingOn"),
        edge("w2", "waitingOn"),
        edge("b1", "blocking"),
        edge("b2", "blocking")
    ];

    it("reorders only the list it was moved in", () => {
        const next = order.placeDependency(dependencies, "w2", "waitingOn", {
            beforeId: null,
            afterId: "w1"
        });
        expect(ids(next.filter((one) => one.direction === "waitingOn"))).toEqual(["w2", "w1"]);
        expect(ids(next.filter((one) => one.direction === "blocking"))).toEqual(["b1", "b2"]);
    });

    it("cannot pull a link across into the other list", () => {
        const next = order.placeDependency(dependencies, "b1", "waitingOn", {
            beforeId: "w1",
            afterId: "w2"
        });
        expect(ids(next.filter((one) => one.direction === "waitingOn"))).toEqual(["w1", "w2"]);
        expect(next).toHaveLength(4);
    });
});
