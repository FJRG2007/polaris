import * as engine from "../src/tasks.js";
import { describe, expect, it } from "vitest";
import * as work from "../src/schemas/tasks.js";
import type { Recurrence, TaskFilter } from "../src/schemas/tasks.js";
import {
    FOLDER_DEPTH_LIMIT,
    strongerRole,
    taskShareEmailSchema,
    taskShareSchema,
    taskSortSchema
} from "../src/schemas/tasks.js";

/** Wednesday, so "this week" has days on both sides of it. */
const NOW = new Date("2026-08-05T12:00:00.000Z");

let counter = 0;

/** A task with everything unset, so each test states only what it is about. */
function task(overrides: Partial<engine.TaskFacts> = {}): engine.TaskFacts {
    counter += 1;
    return {
        id: `task-${counter}`,
        name: `Task ${counter}`,
        listId: "list-1",
        parentId: null,
        statusId: "status-todo",
        statusType: "open",
        priority: "none",
        assigneeIds: [],
        tagIds: [],
        createdById: "user-1",
        startDate: null,
        dueDate: null,
        createdAt: new Date("2026-07-01T09:00:00.000Z"),
        points: null,
        timeEstimate: null,
        archived: false,
        order: 1024,
        ...overrides
    };
}

describe("manual ordering", () => {
    it("puts a task between its neighbours without touching them", () => {
        expect(engine.orderBetween(1000, 2000)).toBe(1500);
        expect(engine.orderBetween(null, 1000)).toBe(1000 - engine.ORDER_STEP);
        expect(engine.orderBetween(1000, null)).toBe(1000 + engine.ORDER_STEP);
        expect(engine.orderBetween(null, null)).toBe(engine.ORDER_STEP);
    });

    it("asks for a rebalance only once the gap stops being splittable", () => {
        expect(engine.needsRebalance(1000, 2000)).toBe(false);
        expect(engine.needsRebalance(1000, 1000.0001)).toBe(true);
        // An open end never needs one: there is always room past the last card.
        expect(engine.needsRebalance(null, 1000)).toBe(false);
    });

    it("re-spaces a group evenly", () => {
        expect(engine.rebalanceOrders(3)).toEqual([1024, 2048, 3072]);
    });
});

describe("keeping the order a screen was showing", () => {
    const screen = ["a", "b", "c", "d"];

    it("puts the task above the row it was dropped on", () => {
        expect(engine.arrangeAround(screen, "d", { beforeId: "a", afterId: "b" })).toEqual(["a", "d", "b", "c"]);
    });

    it("puts it at the end when the drop named only the row above", () => {
        expect(engine.arrangeAround(screen, "a", { beforeId: "d", afterId: null })).toEqual(["b", "c", "d", "a"]);
    });

    it("leaves the rest of the screen exactly as it was", () => {
        const arranged = engine.arrangeAround(screen, "c", { beforeId: null, afterId: "a" });
        expect(arranged).toEqual(["c", "a", "b", "d"]);
        expect(arranged.filter((id) => id !== "c")).toEqual(["a", "b", "d"]);
    });

    it("falls back to the end when the neighbour is not on screen any more", () => {
        expect(engine.arrangeAround(screen, "b", { beforeId: null, afterId: "gone" })).toEqual(["a", "c", "d", "b"]);
    });
});

describe("durations", () => {
    it("reads what a person types into an estimate box", () => {
        expect(engine.parseDurationMinutes("90")).toBe(90);
        expect(engine.parseDurationMinutes("2h 30m")).toBe(150);
        expect(engine.parseDurationMinutes("1.5h")).toBe(90);
        expect(engine.parseDurationMinutes("2d")).toBe(2 * engine.WORKDAY_MINUTES);
        expect(engine.parseDurationMinutes("1w")).toBe(engine.WORKWEEK_MINUTES);
    });

    it("refuses input it cannot fully account for instead of guessing", () => {
        expect(engine.parseDurationMinutes("2h zzz")).toBeNull();
        expect(engine.parseDurationMinutes("soon")).toBeNull();
        expect(engine.parseDurationMinutes("")).toBeNull();
    });

    it("shows an estimate back the way it was entered", () => {
        expect(engine.formatDurationMinutes(150)).toBe("2h 30m");
        expect(engine.formatDurationMinutes(engine.WORKDAY_MINUTES + 30)).toBe("1d 30m");
        expect(engine.formatDurationMinutes(0)).toBe("");
        expect(engine.formatDurationMinutes(null)).toBe("");
    });

    it("formats a running timer and a tracked total differently", () => {
        expect(engine.formatTimer(65)).toBe("1:05");
        expect(engine.formatTimer(3932)).toBe("1:05:32");
        expect(engine.formatTrackedSeconds(22500)).toBe("6h 15m");
        expect(engine.formatTrackedSeconds(0)).toBe("0m");
    });
});

describe("due buckets", () => {
    it("does not call an all-day task overdue before its day is out", () => {
        const today = task({ dueDate: new Date("2026-08-05T00:00:00.000Z") });
        expect(engine.dueBucket(today, NOW)).toBe("today");
        expect(engine.isOverdue(today, NOW)).toBe(false);
    });

    it("calls a timed task overdue the moment its time passes", () => {
        const missed = task({ dueDate: new Date("2026-08-05T09:00:00.000Z"), timed: true });
        expect(engine.dueBucket(missed, NOW)).toBe("overdue");
    });

    it("never marks finished work overdue", () => {
        const done = task({
            dueDate: new Date("2026-07-20T09:00:00.000Z"),
            timed: true,
            statusType: "done"
        });
        expect(engine.dueBucket(done, NOW)).toBe("later");
        expect(engine.isOverdue(done, NOW)).toBe(false);
    });

    it("separates tomorrow, the rest of the week, and later", () => {
        expect(engine.dueBucket(task({ dueDate: new Date("2026-08-06T10:00:00.000Z") }), NOW)).toBe("tomorrow");
        expect(engine.dueBucket(task({ dueDate: new Date("2026-08-08T10:00:00.000Z") }), NOW)).toBe("thisWeek");
        expect(engine.dueBucket(task({ dueDate: new Date("2026-08-20T10:00:00.000Z") }), NOW)).toBe("later");
        expect(engine.dueBucket(task(), NOW)).toBe("none");
    });
});

describe("a date that holds work up", () => {
    // What the picker stores: the start of the day somebody chose, in their own
    // timezone. UTC-4 is the case that used to break, since local midnight there
    // is four hours into the following UTC day.
    const picked = (day: string, offsetHours: number) =>
        new Date(Date.parse(`${day}T00:00:00.000Z`) - offsetHours * 3600_000);

    it("holds for the whole of the day that was picked, including the day it is set", () => {
        const today = picked("2026-08-05", -4);
        expect(engine.blockHolds(today, new Date("2026-08-05T13:00:00.000Z"))).toBe(true);
        // 23:30 that evening in the timezone it was picked in.
        expect(engine.blockHolds(today, new Date("2026-08-06T03:30:00.000Z"))).toBe(true);
    });

    it("lifts itself once that day is over, which is why a date is set instead of a note", () => {
        const today = picked("2026-08-05", -4);
        // 00:30 the next morning, where it was picked.
        expect(engine.blockHolds(today, new Date("2026-08-06T04:30:00.000Z"))).toBe(false);
    });

    it("does not hold on a day already gone", () => {
        expect(engine.blockHolds(picked("2026-07-30", 0), NOW)).toBe(false);
    });

    it("holds for the same span wherever the day was picked", () => {
        // The same wall-clock day chosen either side of Greenwich lasts a day
        // each: the rule counts forward from the instant rather than reading a
        // calendar day off whichever clock happens to be asking.
        for (const offset of [-4, 0, 2, 13]) {
            const day = picked("2026-08-05", offset);
            const lifts = new Date(day.getTime() + 24 * 3600_000);
            expect(engine.blockHolds(day, new Date(lifts.getTime() - 1))).toBe(true);
            expect(engine.blockHolds(day, lifts)).toBe(false);
        }
    });

    it("is not blocked when no date was set", () => {
        expect(engine.blockHolds(null, NOW)).toBe(false);
    });
});

describe("everything that holds work up, as one answer", () => {
    const clear = { statusType: "open", dependsOnUnfinished: false, blockedUntil: null, blockedNote: "" } as const;

    it("reads each of the four on its own", () => {
        expect(engine.taskIsBlocked(clear, NOW)).toBe(false);
        expect(engine.taskIsBlocked({ ...clear, statusType: "blocked" }, NOW)).toBe(true);
        expect(engine.taskIsBlocked({ ...clear, dependsOnUnfinished: true }, NOW)).toBe(true);
        expect(engine.taskIsBlocked({ ...clear, blockedNote: "Waiting on legal" }, NOW)).toBe(true);
        expect(engine.taskIsBlocked({ ...clear, blockedUntil: new Date("2026-08-06T00:00:00.000Z") }, NOW)).toBe(true);
    });

    it("lets a date that has passed stop holding it, with nothing else in the way", () => {
        const lapsed = { ...clear, blockedUntil: new Date("2026-07-01T00:00:00.000Z") };
        expect(engine.taskIsBlocked(lapsed, NOW)).toBe(false);
        // Anything else still standing keeps it held: the date lifting is not
        // the block lifting.
        expect(engine.taskIsBlocked({ ...lapsed, blockedNote: "Waiting on legal" }, NOW)).toBe(true);
    });

    it("counts a blocker that is not finished, including one sitting on no status", () => {
        expect(engine.blockerHolds("active")).toBe(true);
        expect(engine.blockerHolds(null)).toBe(true);
        expect(engine.blockerHolds(undefined)).toBe(true);
        expect(engine.blockerHolds("done")).toBe(false);
        expect(engine.blockerHolds("closed")).toBe(false);
    });
});

describe("relative dates", () => {
    it("resolves a token against the moment it is asked, not when it was saved", () => {
        const today = engine.resolveRelativeDate("today", NOW);
        expect(today.from.getDate()).toBe(NOW.getDate());
        expect(today.to.getHours()).toBe(23);
    });

    it("starts weeks on Monday so a working week is not split in two", () => {
        const week = engine.resolveRelativeDate("thisWeek", NOW);
        expect(week.from.getDay()).toBe(1);
        expect(engine.daysBetween(week.from, week.to)).toBe(6);
    });

    it("begins the week where the reader's preference says, not where the engine assumes", () => {
        for (const [weekStartsOn, expected] of [
            [0, 0],
            [1, 1],
            [6, 6]
        ] as const) {
            const week = engine.resolveRelativeDate("thisWeek", NOW, weekStartsOn);
            expect(week.from.getDay()).toBe(expected);
            expect(engine.daysBetween(week.from, week.to)).toBe(6);
            // The week the reader is in, never the one before or after it.
            expect(week.from.getTime()).toBeLessThanOrEqual(NOW.getTime());
            expect(week.to.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
        }
    });

    it("moves the boundary of 'this week' with the chosen first day", () => {
        // NOW is a Wednesday. The Sunday two days before it belongs to this week
        // for a Sunday-first reader and to the last one for a Monday-first reader.
        const sunday = new Date("2026-08-02T10:00:00.000Z");
        expect(engine.startOfWeek(NOW, 0).getTime()).toBe(engine.startOfDay(sunday).getTime());
        expect(engine.startOfWeek(NOW, 1).getTime()).toBeGreaterThan(engine.startOfDay(sunday).getTime());
        expect(engine.dueBucket(task({ dueDate: new Date("2026-08-09T10:00:00.000Z") }), NOW, 1)).toBe("thisWeek");
        expect(engine.dueBucket(task({ dueDate: new Date("2026-08-09T10:00:00.000Z") }), NOW, 0)).toBe("later");
    });

    it("treats overdue as everything up to now", () => {
        const overdue = engine.resolveRelativeDate("overdue", NOW);
        expect(overdue.to.getTime()).toBe(NOW.getTime());
    });
});

describe("filters", () => {
    const filter = (conditions: TaskFilter["conditions"], match: TaskFilter["match"] = "all"): TaskFilter => ({
        match,
        conditions
    });

    it("matches everything when nothing is filtered", () => {
        expect(engine.matchesFilter(task(), { match: "all", conditions: [] }, NOW)).toBe(true);
    });

    it("compares set membership for the id fields", () => {
        const assigned = task({ assigneeIds: ["user-2", "user-3"] });
        expect(
            engine.matchesFilter(
                assigned,
                filter([{ field: "assignee", operator: "anyOf", values: ["user-3"] }]),
                NOW
            )
        ).toBe(true);
        expect(
            engine.matchesFilter(
                assigned,
                filter([{ field: "assignee", operator: "noneOf", values: ["user-3"] }]),
                NOW
            )
        ).toBe(false);
        expect(
            engine.matchesFilter(task(), filter([{ field: "assignee", operator: "isNotSet", values: [] }]), NOW)
        ).toBe(true);
    });

    it("reads a relative date token as the window it covers", () => {
        const dueToday = task({ dueDate: new Date("2026-08-05T15:00:00.000Z") });
        expect(
            engine.matchesFilter(dueToday, filter([{ field: "dueDate", operator: "is", values: ["today"] }]), NOW)
        ).toBe(true);
        expect(
            engine.matchesFilter(
                dueToday,
                filter([{ field: "dueDate", operator: "is", values: ["tomorrow"] }]),
                NOW
            )
        ).toBe(false);
    });

    it("narrows to the work that is held up, and to the work that is not", () => {
        const stuck = task({ blocked: true });
        const held = filter([{ field: "blocked", operator: "is", values: ["true"] }]);
        const clear = filter([{ field: "blocked", operator: "is", values: ["false"] }]);

        expect(engine.matchesFilter(stuck, held, NOW)).toBe(true);
        expect(engine.matchesFilter(stuck, clear, NOW)).toBe(false);
        // A caller that never said is not blocked, the same way it groups.
        expect(engine.matchesFilter(task(), clear, NOW)).toBe(true);
    });

    it("routes an overdue filter through the same rule the home screen uses", () => {
        const missed = task({ dueDate: new Date("2026-08-01T09:00:00.000Z"), timed: true });
        const finished = task({
            dueDate: new Date("2026-08-01T09:00:00.000Z"),
            timed: true,
            statusType: "done"
        });
        const overdue = filter([{ field: "dueDate", operator: "is", values: ["overdue"] }]);
        expect(engine.matchesFilter(missed, overdue, NOW)).toBe(true);
        expect(engine.matchesFilter(finished, overdue, NOW)).toBe(false);
    });

    it("compares numbers on the numeric fields", () => {
        const pointed = task({ points: 8 });
        expect(engine.matchesFilter(pointed, filter([{ field: "points", operator: "gt", values: ["5"] }]), NOW)).toBe(
            true
        );
        expect(engine.matchesFilter(pointed, filter([{ field: "points", operator: "lt", values: ["5"] }]), NOW)).toBe(
            false
        );
    });

    it("reads a custom field by id", () => {
        const withField = task({ customValues: { "field-1": "opt-red" } });
        expect(
            engine.matchesFilter(
                withField,
                filter([{ field: "customField", operator: "is", values: ["opt-red"], fieldId: "field-1" }]),
                NOW
            )
        ).toBe(true);
    });

    it("honours any-of versus all-of at the group level", () => {
        const urgent = task({ priority: "urgent", assigneeIds: [] });
        const conditions: TaskFilter["conditions"] = [
            { field: "priority", operator: "is", values: ["urgent"] },
            { field: "assignee", operator: "isSet", values: [] }
        ];
        expect(engine.matchesFilter(urgent, filter(conditions, "all"), NOW)).toBe(false);
        expect(engine.matchesFilter(urgent, filter(conditions, "any"), NOW)).toBe(true);
    });
});

describe("sorting", () => {
    it("opens on priority when nothing says how the view is sorted", () => {
        expect(taskSortSchema.parse({})).toEqual({ field: "priority", direction: "asc" });
    });

    it("sorts by urgency, not alphabetically, on priority", () => {
        const sorted = engine.sortTasks(
            [task({ priority: "low" }), task({ priority: "urgent" }), task({ priority: "normal" })],
            { field: "priority", direction: "asc" }
        );
        expect(sorted.map((entry) => entry.priority)).toEqual(["urgent", "normal", "low"]);
    });

    it("keeps tasks with no due date at the bottom whichever way the sort points", () => {
        const dated = task({ dueDate: new Date("2026-08-10T00:00:00.000Z") });
        const undated = task();
        expect(engine.sortTasks([undated, dated], { field: "dueDate", direction: "asc" })[0]).toBe(dated);
        expect(engine.sortTasks([undated, dated], { field: "dueDate", direction: "desc" })[0]).toBe(dated);
    });

    it("orders undated work by urgency, since there is no date to go on", () => {
        const sorted = engine.sortTasks(
            [task({ priority: "low" }), task({ priority: "urgent" }), task({ priority: "normal" })],
            { field: "dueDate", direction: "asc" }
        );
        expect(sorted.map((entry) => entry.priority)).toEqual(["urgent", "normal", "low"]);
    });

    it("breaks a shared deadline by urgency, and does not flip it with the direction", () => {
        const due = new Date("2026-08-10T00:00:00.000Z");
        const low = task({ dueDate: due, priority: "low" });
        const urgent = task({ dueDate: due, priority: "urgent" });
        expect(engine.sortTasks([low, urgent], { field: "dueDate", direction: "asc" })[0]).toBe(urgent);
        expect(engine.sortTasks([low, urgent], { field: "dueDate", direction: "desc" })[0]).toBe(urgent);
    });

    it("breaks equal priority by deadline, soonest first", () => {
        const later = task({ priority: "high", dueDate: new Date("2026-08-20T00:00:00.000Z") });
        const sooner = task({ priority: "high", dueDate: new Date("2026-08-10T00:00:00.000Z") });
        const sorted = engine.sortTasks([later, sooner], { field: "priority", direction: "asc" });
        expect(sorted).toEqual([sooner, later]);
    });

    it("breaks an equal priority and deadline by the shorter estimate", () => {
        const due = new Date("2026-08-10T00:00:00.000Z");
        const long = task({ priority: "high", dueDate: due, timeEstimate: 480 });
        const short = task({ priority: "high", dueDate: due, timeEstimate: 30 });
        const sorted = engine.sortTasks([long, short], { field: "priority", direction: "asc" });
        expect(sorted).toEqual([short, long]);
    });

    it("sinks a task with no deadline under one that has a deadline of the same priority", () => {
        const dated = task({ priority: "normal", dueDate: new Date("2026-09-01T00:00:00.000Z") });
        const undated = task({ priority: "normal" });
        expect(engine.sortTasks([undated, dated], { field: "priority", direction: "asc" })[0]).toBe(dated);
    });

    it("sinks a task with no estimate under an estimated one of the same priority and deadline", () => {
        const due = new Date("2026-08-10T00:00:00.000Z");
        const estimated = task({ priority: "normal", dueDate: due, timeEstimate: 120 });
        const open = task({ priority: "normal", dueDate: due });
        expect(engine.sortTasks([open, estimated], { field: "priority", direction: "asc" })[0]).toBe(estimated);
    });

    it("reverses only the priority bands, never the order inside one", () => {
        const due = new Date("2026-08-10T00:00:00.000Z");
        const laterLow = task({ priority: "low", dueDate: new Date("2026-08-20T00:00:00.000Z") });
        const soonerLow = task({ priority: "low", dueDate: due });
        const urgent = task({ priority: "urgent", dueDate: due });
        const sorted = engine.sortTasks([urgent, laterLow, soonerLow], {
            field: "priority",
            direction: "desc"
        });
        // Low before urgent, but the soonest low still leads its own band.
        expect(sorted).toEqual([soonerLow, laterLow, urgent]);
    });

    it("falls back to the manual order once nothing else separates two tasks", () => {
        const due = new Date("2026-08-10T00:00:00.000Z");
        const second = task({ priority: "high", dueDate: due, timeEstimate: 60, order: 2048 });
        const first = task({ priority: "high", dueDate: due, timeEstimate: 60, order: 1024 });
        expect(engine.sortTasks([second, first], { field: "priority", direction: "asc" })).toEqual([
            first,
            second
        ]);
    });
});

describe("grouping", () => {
    const statuses = [
        { id: "status-todo", name: "To do", color: "#64748b" },
        { id: "status-doing", name: "In progress", color: "#3b82f6" }
    ];

    it("keeps a board column that has no cards in it", () => {
        const groups = engine.groupTasks([task({ statusId: "status-todo" })], "status", { statuses }, NOW);
        expect(groups.map((group) => group.label)).toEqual(["To do", "In progress"]);
        expect(groups[1]?.tasks).toEqual([]);
    });

    it("lists a task under every assignee it has", () => {
        const shared = task({ assigneeIds: ["user-1", "user-2"] });
        const groups = engine.groupTasks([shared], "assignee", {
            people: [
                { id: "user-1", name: "Ada" },
                { id: "user-2", name: "Grace" }
            ]
        });
        expect(groups.map((group) => group.label)).toEqual(["Ada", "Grace"]);
    });

    it("gives unassigned work a pile of its own", () => {
        const groups = engine.groupTasks([task()], "assignee", { people: [] });
        expect(groups[0]?.label).toBe("Unassigned");
    });

    it("never drops a task whose group the context did not name", () => {
        const orphan = task({ statusId: "status-deleted" });
        const groups = engine.groupTasks([orphan], "status", { statuses }, NOW);
        expect(groups.flatMap((group) => group.tasks)).toContain(orphan);
    });

    // Everything and a cross-space sprint hand over one status row per space. Drawn
    // literally that is the same board repeated once per space, which is what this
    // stops: a column is what the status is called, not which space defined it.
    describe("across several spaces", () => {
        const shared = [
            { id: "a-todo", name: "To do", color: "#64748b" },
            { id: "a-doing", name: "In progress", color: "#3b82f6" },
            { id: "b-todo", name: "To Do", color: "#94a3b8" },
            { id: "b-doing", name: " in progress ", color: "#60a5fa" },
            { id: "b-blocked", name: "Blocked", color: "#ef4444" }
        ];

        it("draws one column per status name, keeping what only one space has", () => {
            expect(engine.statusColumns(shared).map((column) => column.name)).toEqual([
                "To do",
                "In progress",
                "Blocked"
            ]);
        });

        it("puts every space's row for a name into that one column", () => {
            const groups = engine.groupTasks(
                [task({ id: "one", statusId: "a-todo" }), task({ id: "two", statusId: "b-todo" })],
                "status",
                { statuses: shared },
                NOW
            );
            expect(groups[0]?.label).toBe("To do");
            expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(["one", "two"]);
        });

        it("keeps the order the tasks arrived in inside a merged column", () => {
            const groups = engine.groupTasks(
                [
                    task({ id: "first", statusId: "b-todo" }),
                    task({ id: "second", statusId: "a-todo" }),
                    task({ id: "third", statusId: "b-todo" })
                ],
                "status",
                { statuses: shared },
                NOW
            );
            expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(["first", "second", "third"]);
        });

        it("sorts every row for a name to the same place", () => {
            const order = engine.statusColumnOrder(shared);
            expect(order.get("a-todo")).toBe(order.get("b-todo"));
            expect(order.get("a-doing")).toBe(order.get("b-doing"));
            expect(order.get("b-blocked")).toBe(2);
        });
    });

    describe("the blocked stage and the blocked state", () => {
        it("treats the stage as a kind, so a renamed one still counts", () => {
            // The whole reason this is a kind: a space calling its column
            // "Bloqueado" must read as held up, and one calling a column
            // "Blocked" while meaning something else must not.
            expect(work.isBlockedStatus("blocked")).toBe(true);
            expect(work.isBlockedStatus("open")).toBe(false);
            expect(work.isBlockedStatus("active")).toBe(false);
        });

        it("counts blocked work as unfinished, so it stays on the open lists", () => {
            expect(work.isFinishedStatus("blocked")).toBe(false);
            expect(work.UNFINISHED_STATUS_TYPES).toContain("blocked");
            expect(work.FINISHED_STATUS_TYPES).not.toContain("blocked");
        });

        it("ships the default Blocked stage as that kind", () => {
            // A stage named Blocked that was not of the blocked kind is exactly
            // the disagreement this pairing exists to prevent: the column says
            // held up and the marker, the filter and the grouping say otherwise.
            const stage = work.DEFAULT_TASK_STATUSES.find((entry) => entry.name === "Blocked");
            expect(stage?.type).toBe("blocked");
        });
    });

    describe("by whether the work is held up", () => {
        it("splits the two piles, blocked first", () => {
            const stuck = task({ id: "stuck", blocked: true });
            const moving = task({ id: "moving" });
            const groups = engine.groupTasks([moving, stuck], "blocked");

            expect(groups.map((group) => group.label)).toEqual(["Blocked", "Not blocked"]);
            expect(groups[0]?.tasks.map((entry) => entry.id)).toEqual(["stuck"]);
            expect(groups[1]?.tasks.map((entry) => entry.id)).toEqual(["moving"]);
        });

        it("keeps an empty Blocked column, which is the answer somebody grouped for", () => {
            const groups = engine.groupTasks([task()], "blocked");

            expect(groups.map((group) => group.label)).toEqual(["Blocked", "Not blocked"]);
            expect(groups[0]?.tasks).toEqual([]);
        });

        it("reads a task that never said as not blocked, rather than as its own pile", () => {
            // `blocked` is optional on the facts: a caller that does not know is
            // not a third state, and a stray "Other" column would say it was.
            const groups = engine.groupTasks([task({ blocked: undefined })], "blocked");

            expect(groups).toHaveLength(2);
            expect(groups[1]?.tasks).toHaveLength(1);
        });
    });
});

describe("rollups", () => {
    it("counts closed work as resolved, not outstanding", () => {
        const progress = engine.rollupProgress([
            { statusType: "open" },
            { statusType: "done" },
            { statusType: "closed" },
            { statusType: "active" }
        ]);
        expect(progress).toEqual({ total: 4, done: 2, percent: 50 });
    });

    it("reports how much of the estimate has been used", () => {
        const effort = engine.rollupEffort([
            { timeEstimate: 60, points: 3, trackedSeconds: 1800 },
            { timeEstimate: 60, points: 2, trackedSeconds: 1800 }
        ]);
        expect(effort).toMatchObject({ estimate: 120, tracked: 3600, points: 5, usedPercent: 50 });
    });

    it("has no percentage to report when nothing was estimated", () => {
        expect(engine.rollupEffort([{ timeEstimate: null, points: null }]).usedPercent).toBeNull();
    });
});

describe("subtask trees", () => {
    it("nests children under the parent that is present", () => {
        const parent = task({ id: "parent" });
        const child = task({ id: "child", parentId: "parent" });
        const tree = engine.buildTaskTree([parent, child]);
        expect(tree).toHaveLength(1);
        expect(tree[0]?.children[0]?.task.id).toBe("child");
    });

    it("promotes an orphan rather than hiding it", () => {
        const child = task({ id: "child", parentId: "missing-parent" });
        expect(engine.buildTaskTree([child])).toHaveLength(1);
    });

    it("stops descending at a collapsed parent", () => {
        const parent = task({ id: "parent" });
        const child = task({ id: "child", parentId: "parent" });
        const tree = engine.buildTaskTree([parent, child]);
        expect(engine.flattenTree(tree)).toHaveLength(2);
        expect(engine.flattenTree(tree, new Set(["parent"]))).toHaveLength(1);
    });
});

describe("folder trees", () => {
    /** agency > client > project, plus a second client beside the first. */
    const folders = [
        { id: "agency", parentId: null },
        { id: "client-a", parentId: "agency" },
        { id: "project-1", parentId: "client-a" },
        { id: "client-b", parentId: "agency" }
    ];

    it("nests each folder under its parent", () => {
        const tree = engine.buildFolderTree(folders);
        expect(tree).toHaveLength(1);
        expect(tree[0]?.children).toHaveLength(2);
        expect(tree[0]?.children[0]?.children[0]?.folder.id).toBe("project-1");
        expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2);
    });

    it("treats a folder whose parent is out of reach as a root", () => {
        // What a pruned tree looks like: somebody invited to one client sees
        // that client, and the agency above it is not theirs to see.
        const tree = engine.buildFolderTree(folders.filter((folder) => folder.id !== "agency"));
        expect(tree.map((node) => node.folder.id).sort()).toEqual(["client-a", "client-b"]);
    });

    it("reads the chain from the root down", () => {
        expect(engine.folderAncestors(folders, "project-1").map((folder) => folder.id)).toEqual([
            "agency",
            "client-a",
            "project-1"
        ]);
        expect(engine.folderDepth(folders, "project-1")).toBe(2);
    });

    it("collects a folder and everything under it", () => {
        expect([...engine.folderBranch(folders, "client-a")].sort()).toEqual(["client-a", "project-1"]);
        expect(engine.folderBranch(folders, "project-1").size).toBe(1);
    });

    it("refuses a move into itself or its own branch", () => {
        expect(engine.folderMoveRefusal(folders, "client-a", "client-a")).toMatch(/into itself/);
        expect(engine.folderMoveRefusal(folders, "client-a", "project-1")).toMatch(/own subfolders/);
        expect(engine.folderMoveRefusal(folders, "client-a", "client-b")).toBeNull();
        expect(engine.folderMoveRefusal(folders, "client-a", null)).toBeNull();
    });

    it("refuses a move that would push a branch past the depth limit", () => {
        // A chain exactly as deep as the limit allows, plus a two-level branch
        // beside it: dropping the branch on the deepest link overflows.
        const deep = Array.from({ length: FOLDER_DEPTH_LIMIT }, (_, index) => ({
            id: `deep-${index}`,
            parentId: index === 0 ? null : `deep-${index - 1}`
        }));
        const withBranch = [...deep, { id: "top", parentId: null }, { id: "under-top", parentId: "top" }];
        expect(engine.folderMoveRefusal(withBranch, "top", "deep-0")).toBeNull();
        expect(engine.folderMoveRefusal(withBranch, "top", `deep-${FOLDER_DEPTH_LIMIT - 2}`)).toMatch(/deep/);
    });

    it("stops building past the depth limit rather than recursing forever", () => {
        const chain = Array.from({ length: FOLDER_DEPTH_LIMIT + 4 }, (_, index) => ({
            id: `f-${index}`,
            parentId: index === 0 ? null : `f-${index - 1}`
        }));
        let depth = 0;
        let node = engine.buildFolderTree(chain)[0];
        while (node?.children[0]) {
            depth += 1;
            node = node.children[0];
        }
        expect(depth).toBe(FOLDER_DEPTH_LIMIT - 1);
    });
});

describe("space roles", () => {
    it("takes the stronger of two grants", () => {
        expect(strongerRole("guest", "member")).toBe("member");
        expect(strongerRole("admin", "member")).toBe("admin");
        expect(strongerRole("guest", "guest")).toBe("guest");
    });
});

describe("dependencies", () => {
    const edges = [
        { blockerId: "a", blockedId: "b" },
        { blockerId: "b", blockedId: "c" }
    ];

    it("refuses an edge that would close a loop", () => {
        expect(engine.wouldCycle(edges, "c", "a")).toBe(true);
        expect(engine.wouldCycle(edges, "a", "a")).toBe(true);
        expect(engine.wouldCycle(edges, "c", "d")).toBe(false);
    });

    it("marks a task blocked only while its blocker is unfinished", () => {
        const open = new Map<string, engine.TaskFacts["statusType"]>([
            ["a", "active"],
            ["b", "open"]
        ]);
        expect([...engine.blockedTaskIds(edges, open)]).toEqual(["b", "c"]);
        const resolved = new Map<string, engine.TaskFacts["statusType"]>([
            ["a", "done"],
            ["b", "done"]
        ]);
        expect([...engine.blockedTaskIds(edges, resolved)]).toEqual([]);
    });
});

describe("recurrence", () => {
    const base = (overrides: Partial<Recurrence>): Recurrence => ({
        mode: "daily",
        interval: 1,
        weekdays: [],
        basis: "schedule",
        ...overrides
    });

    it("repeats daily and keeps the time of day", () => {
        const next = engine.nextOccurrence(base({ interval: 3 }), new Date("2026-08-05T09:30:00.000Z"));
        expect(next?.getDate()).toBe(8);
        expect(next?.getHours()).toBe(new Date("2026-08-05T09:30:00.000Z").getHours());
    });

    it("moves to the next chosen weekday inside the same week", () => {
        // Wednesday, wanting Monday and Friday: Friday is still to come.
        const next = engine.nextOccurrence(
            base({ mode: "weekly", weekdays: [1, 5] }),
            new Date("2026-08-05T09:00:00.000Z")
        );
        expect(next?.getDay()).toBe(5);
    });

    it("clamps a monthly rule to the length of a short month", () => {
        const next = engine.nextOccurrence(
            base({ mode: "monthly", dayOfMonth: 31 }),
            new Date("2026-01-31T09:00:00.000Z")
        );
        expect(next?.getMonth()).toBe(1);
        expect(next?.getDate()).toBe(28);
    });

    it("stops once the rule has run out", () => {
        expect(engine.nextOccurrence(base({ endsAfter: 2 }), NOW, 2)).toBeNull();
        expect(
            engine.nextOccurrence(base({ endsOn: "2026-08-05T00:00:00.000Z" }), new Date("2026-08-05T09:00:00.000Z"))
        ).toBeNull();
    });
});

describe("automations", () => {
    const rule = (overrides: Partial<engine.AutomationRule> = {}): engine.AutomationRule => ({
        id: "rule-1",
        trigger: "task.statusChanged",
        conditions: { match: "all", conditions: [] },
        enabled: true,
        listId: null,
        ...overrides
    });

    it("selects only enabled rules for this trigger whose conditions the task meets", () => {
        const event: engine.AutomationEvent = { trigger: "task.statusChanged", task: task({ priority: "urgent" }) };
        const rules = [
            rule({ id: "match" }),
            rule({ id: "disabled", enabled: false }),
            rule({ id: "other-trigger", trigger: "task.created" }),
            rule({
                id: "unmet",
                conditions: { match: "all", conditions: [{ field: "priority", operator: "is", values: ["low"] }] }
            })
        ];
        expect(engine.selectAutomations(rules, event, NOW).map((entry) => entry.id)).toEqual(["match"]);
    });

    it("keeps a list-scoped rule out of another list", () => {
        const event: engine.AutomationEvent = { trigger: "task.statusChanged", task: task({ listId: "list-1" }) };
        expect(engine.selectAutomations([rule({ listId: "list-2" })], event, NOW)).toEqual([]);
        expect(engine.selectAutomations([rule({ listId: "list-1" })], event, NOW)).toHaveLength(1);
    });
});

describe("gantt", () => {
    it("covers at least a fortnight so one task still draws a chart", () => {
        const range = engine.ganttRange([task({ dueDate: new Date("2026-08-05T00:00:00.000Z") })], NOW);
        expect(engine.daysBetween(range.from, range.to)).toBeGreaterThanOrEqual(14);
    });

    it("places a bar inside the window and never past its edge", () => {
        const dated = task({
            id: "bar",
            startDate: new Date("2026-08-05T00:00:00.000Z"),
            dueDate: new Date("2026-08-07T00:00:00.000Z")
        });
        const range = engine.ganttRange([dated], NOW);
        const [bar] = engine.ganttBars([dated], range);
        expect(bar?.taskId).toBe("bar");
        expect(bar!.offsetPercent).toBeGreaterThanOrEqual(0);
        expect(bar!.offsetPercent + bar!.widthPercent).toBeLessThanOrEqual(100.001);
    });

    it("leaves out a task with no dates rather than inventing a position", () => {
        expect(engine.ganttBars([task()], engine.ganttRange([], NOW))).toEqual([]);
    });
});

describe("burndown", () => {
    it("draws no actual line into the future", () => {
        const points = engine.burndown(
            {
                start: new Date("2026-08-03T00:00:00.000Z"),
                end: new Date("2026-08-14T00:00:00.000Z"),
                tasks: [
                    { points: 5, statusType: "done", completedAt: new Date("2026-08-04T10:00:00.000Z") },
                    { points: 3, statusType: "open", completedAt: null }
                ]
            },
            NOW
        );
        expect(points[0]?.remaining).toBe(8);
        expect(points.at(-1)?.remaining).toBeNull();
        const afterCompletion = points.find((point) => point.date > new Date("2026-08-04T23:00:00.000Z"));
        expect(afterCompletion?.remaining).toBe(3);
    });

    it("falls back to counting tasks when nothing is pointed", () => {
        const points = engine.burndown(
            {
                start: new Date("2026-08-03T00:00:00.000Z"),
                end: new Date("2026-08-05T00:00:00.000Z"),
                tasks: [
                    { points: null, statusType: "open", completedAt: null },
                    { points: null, statusType: "open", completedAt: null }
                ]
            },
            NOW
        );
        expect(points[0]?.remaining).toBe(2);
    });
});

describe("references", () => {
    it("derives a short prefix people can quote", () => {
        expect(engine.deriveSpacePrefix("Engineering")).toBe("ENGI");
        expect(engine.deriveSpacePrefix("Product Design")).toBe("PD");
        expect(engine.deriveSpacePrefix("")).toBe("TASK");
        expect(engine.taskReference("PD", 42)).toBe("PD-42");
    });
});

describe("sharing a task", () => {
    const TASK_ID = "0197f3a0-0000-7000-8000-000000000001";

    it("refuses a send with nobody on it", () => {
        expect(taskShareEmailSchema.safeParse({ taskId: TASK_ID }).success).toBe(false);
    });

    it("normalizes addresses so the same person is not two recipients", () => {
        const parsed = taskShareEmailSchema.parse({ taskId: TASK_ID, emails: [" Ana@Example.COM "] });
        expect(parsed.emails).toEqual(["ana@example.com"]);
    });

    it("defaults the public link to hiding the discussion", () => {
        expect(taskShareSchema.parse({ taskId: TASK_ID, enabled: true }).showComments).toBe(false);
    });
});
