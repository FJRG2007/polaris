// @vitest-environment jsdom

/**
 * Subtasks on the List and the Board, the way ClickUp draws them.
 *
 * A subtask is part of its parent: it is never a row or a card of its own and
 * never counted in its group, it opens out from a caret on the parent's row or
 * the "N subtasks" footer on the parent's card, and an open parent offers a row
 * to add another one under it. The list also lines its values up under column
 * headings, and the screen around it fills the width it is given.
 */

import { readFileSync } from "node:fs";
import { withMessages } from "../setup/i18n";
import type { TaskGroup } from "@polaris/core";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";

vi.mock("@/app/(app)/tasks/actions", () => ({}));

const { ListView } = await import("@/app/(app)/tasks/views/rows");
const { BoardView } = await import("@/app/(app)/tasks/views/board");
const { nestSubtasks, useOpenParents } = await import("@/app/(app)/tasks/views/subtasks");
const shared = await import("@/app/(app)/tasks/views/shared");
type ViewProps = import("@/app/(app)/tasks/views/shared").ViewProps;
type SubtaskMode = import("@/app/(app)/tasks/views/subtasks").SubtaskMode;

function taskRow(id: string, name: string, overrides: Partial<TaskRow> = {}): TaskRow {
    return {
        id,
        reference: `FJRG-${id}`,
        name,
        description: "",
        spaceId: "s1",
        spaceName: "Space",
        listId: "l1",
        listName: "Inbox",
        folderName: null,
        parentId: null,
        statusId: "st1",
        statusName: "To do",
        statusColor: "#64748b",
        statusType: "open",
        priority: "none",
        assignees: [],
        tags: [],
        createdById: null,
        startDate: null,
        dueDate: null,
        timed: false,
        timeEstimate: null,
        points: null,
        milestone: false,
        archived: false,
        order: 1,
        sprintId: null,
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        subtaskCount: 0,
        commentCount: 0,
        trackedSeconds: 0,
        blocked: false,
        blockedUntil: null,
        blockedNote: "",
        recurring: false,
        customValues: {},
        ...overrides
    };
}

const PARENT = taskRow("t1", "Ship the release", { subtaskCount: 1 });
// In another status from its parent: grouped on its own it would head a
// section of its own, which is exactly what must not happen.
const CHILD = taskRow("t2", "Write the notes", {
    parentId: "t1",
    statusId: "st2",
    statusName: "Done",
    statusType: "done"
});
const LONE = taskRow("t3", "Rotate the logs");

const GROUPS: TaskGroup<TaskRow>[] = [
    { key: "st1", label: "To do", color: "#64748b", tasks: [PARENT, LONE] },
    { key: "st2", label: "Done", color: "#16a34a", tasks: [CHILD] }
];

function context(): SpaceContext {
    return {
        spaceId: "s1",
        statuses: [
            { id: "st1", name: "To do", type: "open", color: "#64748b", order: 0 },
            { id: "st2", name: "Done", type: "done", color: "#16a34a", order: 1 }
        ],
        tags: [],
        fields: [],
        people: [],
        canEdit: true,
        canModerate: false,
        currentUserId: "u1",
        siblings: []
    };
}

/** The screen's part: nest the groups, and keep which parents are open. */
function Screen({
    view,
    mode = "collapsed",
    onQuickCreate = () => undefined
}: {
    view: "list" | "board";
    mode?: SubtaskMode;
    onQuickCreate?: ViewProps["onQuickCreate"];
}) {
    const open = useOpenParents(mode);
    const nested = nestSubtasks(GROUPS, mode, true);
    const props: ViewProps = {
        rows: [PARENT, LONE, CHILD],
        groups: nested.groups,
        subtasks: { mode, children: nested.children, isOpen: open.isOpen, toggle: open.toggle },
        context: context(),
        canEdit: true,
        orderable: true,
        groupBy: "status",
        selection: new Set<string>(),
        selected: [],
        lists: [{ id: "l1", name: "Inbox", spaceId: "s1" }],
        onOpen: () => undefined,
        onSelect: () => undefined,
        onMove: () => undefined,
        onQuickCreate,
        onEdit: () => undefined,
        onApply: () => undefined,
        onDuplicate: () => undefined,
        onDelete: () => undefined
    };
    return view === "list" ? <ListView {...props} /> : <BoardView {...props} />;
}

const store = new Map<string, string>();

beforeEach(() => {
    store.clear();
    // This environment has no storage of its own, so the browser's is stood in.
    Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: {
            getItem: (key: string) => store.get(key) ?? null,
            setItem: (key: string, value: string) => void store.set(key, value),
            removeItem: (key: string) => void store.delete(key)
        }
    });
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("nesting subtasks under their parents", () => {
    it("takes a subtask out of every group and hangs it under its parent", () => {
        const nested = nestSubtasks(GROUPS, "collapsed", false);
        expect(nested.groups.map((group) => group.tasks.map((task) => task.id))).toEqual([
            ["t1", "t3"]
        ]);
        expect(nested.children.get("t1")?.map((task) => task.id)).toEqual(["t2"]);
    });

    it("keeps a status column that only held subtasks, empty", () => {
        const nested = nestSubtasks(GROUPS, "collapsed", true);
        expect(nested.groups.map((group) => group.tasks.length)).toEqual([2, 0]);
    });

    it("leaves a subtask whose parent is not on screen where it was", () => {
        const orphan = taskRow("t4", "Answer the ticket", { parentId: "elsewhere" });
        const nested = nestSubtasks(
            [{ key: "st1", label: "To do", tasks: [orphan] }],
            "collapsed",
            true
        );
        expect(nested.groups[0]?.tasks.map((task) => task.id)).toEqual(["t4"]);
    });

    it("lists every task on its own only when asked to", () => {
        const nested = nestSubtasks(GROUPS, "separate", true);
        expect(nested.groups.map((group) => group.tasks.length)).toEqual([2, 1]);
        expect(nested.children.size).toBe(0);
    });
});

describe("the List view", () => {
    it("heads each group with its columns and a way to choose them", () => {
        const view = render(withMessages(<Screen view="list" />));
        const section = view.getAllByRole("heading", { name: "To do" })[0]?.closest("section");
        if (!section) throw new Error("No To do section");
        const scope = within(section);
        for (const label of ["Name", "Assignee", "Due date", "Priority"])
            expect(scope.getByText(label)).toBeTruthy();
        expect(scope.getByRole("button", { name: "Columns" })).toBeTruthy();
    });

    it("never draws a subtask at the top, nor counts it there", () => {
        const view = render(withMessages(<Screen view="list" />));
        expect(view.queryByText("Write the notes")).toBeNull();
        const done = view.getByRole("heading", { name: "Done" }).closest("header");
        expect(done?.textContent).toContain("0");
        const todo = view.getByRole("heading", { name: "To do" }).closest("header");
        expect(todo?.textContent).toContain("2");
    });

    it("opens a parent onto its subtasks from the caret, and closes it again", () => {
        const view = render(withMessages(<Screen view="list" />));
        const caret = view.getByRole("button", { name: "Show subtasks of Ship the release" });
        expect(view.getByRole("button", { name: "1 subtask" })).toBeTruthy();
        fireEvent.click(caret);
        const child = view.getByText("Write the notes").closest("li");
        expect(child?.getAttribute("style")).toContain("padding-left: 2rem");
        expect(store.get("polaris.tasks.subtasks.open")).toBe('{"t1":true}');
        fireEvent.click(view.getByRole("button", { name: "Hide subtasks of Ship the release" }));
        expect(view.queryByText("Write the notes")).toBeNull();
    });

    it("remembers an open parent from the last visit", () => {
        store.set("polaris.tasks.subtasks.open", '{"t1":true}');
        const view = render(withMessages(<Screen view="list" />));
        expect(view.getByText("Write the notes")).toBeTruthy();
    });

    it("adds a subtask from the row under an open parent", () => {
        const onQuickCreate = vi.fn();
        const view = render(
            withMessages(<Screen view="list" mode="expanded" onQuickCreate={onQuickCreate} />)
        );
        fireEvent.click(view.getByRole("button", { name: "Add a subtask to Ship the release" }));
        const input = view.getByRole("textbox", { name: "Add a subtask to Ship the release" });
        fireEvent.change(input, { target: { value: "Tag the build" } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onQuickCreate).toHaveBeenCalledWith("st1", "Tag the build", {
            parent: { id: "t1", listId: "l1" }
        });
    });

    it("adds a task to a group from the composer at its foot", () => {
        const onQuickCreate = vi.fn();
        const view = render(withMessages(<Screen view="list" onQuickCreate={onQuickCreate} />));
        // The header's "+" and the row at the foot of the group both open it.
        const [, foot] = view.getAllByRole("button", { name: "Add a task to To do" });
        if (!foot) throw new Error("No add row");
        fireEvent.click(foot);
        const input = view.getByRole("textbox", { name: "Add a task to To do" });
        fireEvent.change(input, { target: { value: "Plan the sprint" } });
        fireEvent.click(view.getByRole("button", { name: "Save" }));
        expect(onQuickCreate).toHaveBeenCalledWith("st1", "Plan the sprint", {});
        fireEvent.click(view.getByRole("button", { name: "Cancel" }));
        expect(view.queryByRole("textbox", { name: "Add a task to To do" })).toBeNull();
    });

    it("lists a subtask as a task of its own only in that mode", () => {
        const view = render(withMessages(<Screen view="list" mode="separate" />));
        expect(view.getByText("Write the notes")).toBeTruthy();
        expect(
            view.queryByRole("button", { name: "Show subtasks of Ship the release" })
        ).toBeNull();
    });
});

describe("the Board view", () => {
    it("keeps a subtask off the columns until its parent's footer opens it", () => {
        const view = render(withMessages(<Screen view="board" />));
        expect(view.queryByText("Write the notes")).toBeNull();
        const footer = view.getByText("1 subtask").closest("button");
        if (!footer) throw new Error("No subtask footer");
        expect(footer.getAttribute("aria-expanded")).toBe("false");
        fireEvent.click(footer);
        const child = view.getByText("Write the notes");
        // Under its parent, in the parent's column - not in "Done".
        const column = view.getByText("Ship the release").closest("section");
        expect(column?.contains(child)).toBe(true);
        expect(child.closest("li")?.getAttribute("style")).toContain("margin-left: 0.75rem");
        fireEvent.click(footer);
        expect(view.queryByText("Write the notes")).toBeNull();
    });
});

describe("the List screen", () => {
    it("fills the row it shares with the space tree, like every other Tasks screen", () => {
        const source = readFileSync("src/app/(app)/tasks/list-view.tsx", "utf8");
        expect(source).toContain('cn("flex min-w-0 flex-1 flex-col gap-4"');
    });
});

describe("where a composer's task goes", () => {
    const { quickCreatePlacement } = shared;

    it("starts a task typed into a status group in that status", () => {
        expect(quickCreatePlacement("st2", "status", {}, "l1")).toEqual({
            listId: "l1",
            statusId: "st2",
            dueDate: null,
            parentId: null
        });
    });

    it("starts a subtask in the space default, in its parent's list, whatever group the parent is in", () => {
        const placement = quickCreatePlacement(
            "st-closed",
            "status",
            { parent: { id: "p1", listId: "l2" } },
            "l1"
        );
        expect(placement).toEqual({ listId: "l2", statusId: null, dueDate: null, parentId: "p1" });
    });

    it("finds the parent's list on a screen that spans lists", () => {
        expect(
            quickCreatePlacement("st2", "status", { parent: { id: "p1", listId: "l2" } }, null)
                .listId
        ).toBe("l2");
        expect(quickCreatePlacement("st2", "status", {}, null).listId).toBeNull();
    });

    it("reads a calendar day as a due date, never as a status", () => {
        expect(quickCreatePlacement("date:2026-10-26", "status", {}, "l1")).toMatchObject({
            statusId: null,
            dueDate: "2026-10-26"
        });
    });

    it("keeps a due date chosen in the composer over the group's", () => {
        expect(
            quickCreatePlacement("date:2026-10-26", "status", { dueDate: "2026-11-01" }, "l1")
                .dueDate
        ).toBe("2026-11-01");
    });

    it("sets no status when the groups are not statuses", () => {
        expect(quickCreatePlacement("high", "priority", {}, "l1").statusId).toBeNull();
    });
});
