// @vitest-environment jsdom

/**
 * The board, the calendar and the timeline used to keep drawing their columns
 * and days when a search matched nothing, so the screen read as an empty
 * board rather than a search that found nothing. This drives the real screen
 * through a search box a reader would type into, on its default view (board),
 * and checks the empty state names the query - and that a filter emptying the
 * board for a reason that is not the search still gets the filter's own
 * message rather than pretending the search was what found nothing.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import { cleanup, fireEvent, render, screen as rtl } from "@testing-library/react";

// The task screen's comment box is the one from Chat, whose emoji picker reaches
// Chat's own server actions - and that module reads Polaris' configuration as it
// is imported. A running server has all of this; a test process has to say so.
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

function screen(initialFilter?: import("@polaris/core").TaskFilter) {
    return render(
        <ListScreen
            listId="l1"
            defaultListId="l1"
            title="Inbox"
            tasks={TASKS}
            savedViews={[]}
            context={CONTEXT}
            lists={[{ id: "l1", name: "Inbox", spaceId: "s1" }]}
            initialFilter={initialFilter}
        />,
        { wrapper: MessagesWrapper }
    );
}

function type(query: string): void {
    fireEvent.change(rtl.getByPlaceholderText("Search tasks"), { target: { value: query } });
}

afterEach(cleanup);

describe("searching the board for a word no task carries", () => {
    it("opens on the board, with every task drawn and no empty state", () => {
        screen();
        expect(rtl.getByText("Rotate the logs")).toBeTruthy();
        expect(rtl.getByText("Restore the backups")).toBeTruthy();
        expect(rtl.queryByText(/No task contains/)).toBeNull();
    });

    it("names the query once nothing carries it, instead of drawing empty columns", () => {
        screen();
        type("kubernetes");

        expect(rtl.queryByText("Rotate the logs")).toBeNull();
        expect(rtl.queryByText("Restore the backups")).toBeNull();
        expect(rtl.getByText("No task contains “kubernetes”.")).toBeTruthy();
    });

    it("clears the empty state once the query matches something again", () => {
        screen();
        type("kubernetes");
        expect(rtl.getByText(/No task contains/)).toBeTruthy();

        type("backups");
        expect(rtl.queryByText(/No task contains/)).toBeNull();
        expect(rtl.getByText("Restore the backups")).toBeTruthy();
    });

    it("blames the filter, not the search, when the filter is what emptied the board", () => {
        // Narrowed to urgent work before the search box is touched - the kind of
        // link a dashboard widget hands out already filtered.
        screen({
            match: "all",
            conditions: [{ field: "priority", operator: "is", values: ["urgent"] }]
        });

        // The search alone would find this task - it carries the word - but the
        // filter still excludes it, so the board is empty for the filter's reason.
        type("rotate");

        expect(rtl.queryByText(/No task contains/)).toBeNull();
        expect(rtl.getByText("No tasks match this view.")).toBeTruthy();
    });
});
