// @vitest-environment jsdom

/**
 * Selecting tasks from the table: a box on every row and one at the head of the
 * column, and the bar that comes up over the page with the count and the verbs.
 * Driven through the real screen, the way a reader would click it.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import { act, cleanup, fireEvent, render, screen as rtl, within } from "@testing-library/react";

// See board-search-empty-state.test.tsx: the comment box reaches modules that
// read Polaris' configuration as they are imported.
vi.stubEnv("POLARIS_DATABASE_URL", "postgresql://polaris:polaris@localhost:5432/polaris");
vi.stubEnv("POLARIS_AUTH_SECRET", "a-long-enough-string-for-the-schema");
vi.stubEnv("POLARIS_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh() {}, push() {} }),
    usePathname: () => "/tasks/l/l1"
}));
vi.mock("@/app/(app)/tasks/actions", () => ({}));
vi.mock("@/app/(app)/mention-actions", () => ({
    searchMentionsAction: async () => ({ results: [] }),
    resolveReferencesAction: async () => ({ labels: {} })
}));

const { ListScreen } = await import("@/app/(app)/tasks/list-view");

function taskRow(id: string, name: string, priority: TaskRow["priority"], order: number): TaskRow {
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
        priority,
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
    taskRow("t1", "Rotate the logs", "low", 1),
    taskRow("t2", "Restore the backups", "urgent", 2)
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

function tableScreen() {
    render(
        <ListScreen
            listId="l1"
            defaultListId="l1"
            title="Inbox"
            tasks={TASKS}
            savedViews={[]}
            context={CONTEXT}
            lists={[{ id: "l1", name: "Inbox", spaceId: "s1" }]}
        />,
        { wrapper: MessagesWrapper }
    );
    fireEvent.click(rtl.getByRole("radio", { name: /Table/ }));
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("selecting rows in the table", () => {
    it("offers a box per row and one for all of them, and no bar until one is ticked", () => {
        tableScreen();
        expect(rtl.getByRole("checkbox", { name: "Select all" })).toBeTruthy();
        expect(rtl.getByRole("checkbox", { name: "Select Rotate the logs" })).toBeTruthy();
        expect(rtl.queryByRole("toolbar", { name: "Selected tasks" })).toBeNull();
    });

    it("brings the bar up with the count, and widens to every row from it", () => {
        tableScreen();
        fireEvent.click(rtl.getByRole("checkbox", { name: "Select Rotate the logs" }));

        const bar = rtl.getByRole("toolbar", { name: "Selected tasks" });
        expect(bar.textContent).toContain("1 selected");
        const all = rtl.getByRole<HTMLInputElement>("checkbox", { name: "Select all" });
        expect(all.indeterminate).toBe(true);

        fireEvent.click(rtl.getByRole("button", { name: "Select all 2" }));
        expect(bar.textContent).toContain("2 selected");
        expect(rtl.queryByRole("button", { name: "Select all 2" })).toBeNull();
        expect(all.indeterminate).toBe(false);
        expect(all.checked).toBe(true);
        for (const verb of ["Status", "Priority", "Export CSV", "Archive", "Delete"]) {
            expect(within(bar).getByRole("button", { name: verb })).toBeTruthy();
        }
    });

    it("ticks and clears every row from the head of the column", () => {
        tableScreen();
        const all = rtl.getByRole("checkbox", { name: "Select all" });
        fireEvent.click(all);
        expect(rtl.getByRole("toolbar", { name: "Selected tasks" }).textContent).toContain(
            "2 selected"
        );
        fireEvent.click(all);
        expect(
            rtl.getByRole("toolbar", { name: "Selected tasks" }).getAttribute("data-state")
        ).toBe("closed");
    });

    it("leaves on clear, keeping its count while it goes, then is taken off the page", () => {
        vi.useFakeTimers();
        tableScreen();
        fireEvent.click(rtl.getByRole("checkbox", { name: "Select Restore the backups" }));
        fireEvent.click(rtl.getByRole("button", { name: "Clear selection" }));

        const bar = rtl.getByRole("toolbar", { name: "Selected tasks" });
        expect(bar.getAttribute("data-state")).toBe("closed");
        expect(bar.textContent).toContain("1 selected");

        act(() => {
            vi.advanceTimersByTime(250);
        });
        expect(rtl.queryByRole("toolbar", { name: "Selected tasks" })).toBeNull();
    });
});
