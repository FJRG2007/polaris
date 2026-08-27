// @vitest-environment jsdom

/**
 * A row dragged somewhere is there when you let go, not after a reload.
 *
 * The screen holds its arrangement so that raising a priority does not tear the
 * row out from under the pointer of whoever is triaging. A drag is the one
 * gesture that has to go straight through that hold: the reader has just said,
 * in as many words, where the row goes.
 *
 * It did not. The write landed and the server had the new order, but the held
 * arrangement went on pinning the row exactly where it had been - so nothing
 * moved until a full page reload built a fresh hook with no held order. A drag
 * that appears to do nothing is indistinguishable from one that was refused.
 *
 * Driven through the real screen, with the router's refresh stubbed to nothing,
 * because "it only works if you reload" is precisely the bug: a test that lets
 * anything reload cannot see it.
 */

import type { SavedView } from "@/lib/tasks/view-service";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import { cleanup, fireEvent, render } from "@testing-library/react";

const refreshed = vi.fn();

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: refreshed, push() {} }),
    usePathname: () => "/tasks/l/l1"
}));
vi.mock("@/app/(app)/tasks/actions", () => ({
    moveTaskAction: async () => ({}),
    arrangeTasksAction: async () => ({}),
    createViewAction: async () => ({}),
    updateViewAction: async () => ({})
}));
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));

const { ListScreen } = await import("@/app/(app)/tasks/list-view");

function taskRow(id: string, name: string, order: number): TaskRow {
    return {
        id,
        reference: `FJRG-${order}`,
        name,
        description: "",
        spaceId: "s1",
        spaceName: "Space",
        listId: "l1",
        listName: "List",
        folderName: null,
        parentId: null,
        statusId: "st1",
        statusName: "Open",
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
        order,
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
        customValues: {}
    };
}

const TASKS: readonly TaskRow[] = [
    taskRow("t1", "Rotate the logs", 1),
    taskRow("t2", "Restore the backups", 2),
    taskRow("t3", "Rename the column", 3)
];

const CONTEXT: SpaceContext = {
    spaceId: "s1",
    statuses: [{ id: "st1", name: "Open", type: "open", color: "#64748b", order: 0 }],
    tags: [],
    fields: [],
    people: [],
    canEdit: true,
    canModerate: false,
    currentUserId: "u1",
    siblings: []
};

/** A list somebody has already arranged by hand, which is the state a second
 *  drag happens in and the one the bug lived in. */
const ARRANGED: SavedView = {
    id: "v1",
    name: "My order",
    type: "list",
    listId: "l1",
    spaceId: null,
    groupBy: "status",
    sort: { field: "manual", direction: "asc" },
    filter: { match: "all", conditions: [] },
    columns: [],
    showSubtasks: true,
    showClosed: false,
    shared: false,
    ownerId: "u1"
};

/** The task names in the order they are actually drawn. */
function drawn(container: HTMLElement): string[] {
    return TASKS.map((task) => ({
        name: task.name,
        at: container.innerHTML.indexOf(task.name)
    }))
        .filter((entry) => entry.at !== -1)
        .sort((left, right) => left.at - right.at)
        .map((entry) => entry.name);
}

function screen() {
    return render(
        <ListScreen
            listId="l1"
            defaultListId="l1"
            title="Inbox"
            tasks={TASKS}
            savedViews={[ARRANGED]}
            context={CONTEXT}
            lists={[{ id: "l1", name: "Inbox", spaceId: "s1" }]}
        />
    );
}

/** Pick one row up and let go of another, the way a browser reports it. jsdom
 *  measures everything as zero, so the pointer is in the lower half and the drop
 *  means "under this one". */
function drag(container: HTMLElement, from: string, onto: string): void {
    const rowFor = (name: string) => {
        const row = [...container.querySelectorAll("li")].find((node) =>
            node.textContent?.includes(name)
        );
        if (!row) throw new Error(`no row for ${name}`);
        return row;
    };
    const data = { effectAllowed: "", setData() {}, getData: () => "" };
    fireEvent.dragStart(rowFor(from), { dataTransfer: data });
    fireEvent.dragOver(rowFor(onto), { dataTransfer: data, clientY: 0 });
    fireEvent.drop(rowFor(onto), { dataTransfer: data, clientY: 0 });
}

afterEach(() => {
    cleanup();
    refreshed.mockClear();
});

describe("dragging a task into place", () => {
    it("draws it where it was dropped, with nothing reloaded", () => {
        const { container } = screen();
        expect(drawn(container)).toEqual([
            "Rotate the logs",
            "Restore the backups",
            "Rename the column"
        ]);

        // The first row, let go under the last one.
        drag(container, "Rotate the logs", "Rename the column");

        expect(drawn(container)).toEqual([
            "Restore the backups",
            "Rename the column",
            "Rotate the logs"
        ]);
    });

    it("does not need the reload it asks for", () => {
        // The screen does ask the server for fresh rows - it should - but what a
        // reader sees must not be waiting on it. This is the whole assertion:
        // the order above was already right, and nothing had come back.
        const { container } = screen();
        // The last row, let go under the first one.
        drag(container, "Rename the column", "Rotate the logs");
        expect(drawn(container)).toEqual([
            "Rotate the logs",
            "Rename the column",
            "Restore the backups"
        ]);
    });

    it("holds the new arrangement the way it held the old one", () => {
        // Two drags in a row: the second reads the arrangement the first left,
        // not the one the list loaded with.
        const { container } = screen();
        drag(container, "Rotate the logs", "Rename the column");
        drag(container, "Restore the backups", "Rename the column");
        expect(drawn(container)).toEqual([
            "Rename the column",
            "Restore the backups",
            "Rotate the logs"
        ]);
    });
});
