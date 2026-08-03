/**
 * A subtask is a task.
 *
 * It has a status, an owner and a reference, so the row inside a task answers to
 * the same right-click menu as a row on a board: status, priority, people, tags,
 * duplicate, delete. Without it the only way to rename or remove one was to open
 * it first, which made the work inside a task a second-class kind of work.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PersonRef, SpaceContext, TaskRow } from "@/lib/tasks/facts";

// The rows reach for server actions on interaction only; rendering one needs
// the module to exist, not to work.
vi.mock("@/app/(app)/tasks/actions", () => ({}));

const { SubtaskSection } = await import("@/app/(app)/tasks/task-subwork");

const ANA: PersonRef = { id: "u1", name: "Ana Ruiz", image: null };

function subtask(overrides: Partial<TaskRow> = {}): TaskRow {
    return {
        id: "t2",
        reference: "FJRG-2",
        name: "Write the migration",
        description: "",
        spaceId: "s1",
        spaceName: "Space",
        listId: "l1",
        listName: "List",
        folderName: null,
        parentId: "t1",
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
        order: 1024,
        sprintId: null,
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        subtaskCount: 0,
        commentCount: 0,
        trackedSeconds: 0,
        blocked: false,
        recurring: false,
        customValues: {},
        ...overrides
    };
}

function context(canEdit: boolean): SpaceContext {
    return {
        spaceId: "s1",
        statuses: [{ id: "st1", name: "Open", type: "open", color: "#64748b", order: 1024 }],
        tags: [],
        fields: [],
        people: [ANA],
        canEdit,
        canModerate: canEdit,
        currentUserId: "u1",
        siblings: []
    };
}

function section(rows: TaskRow[], canEdit = true): string {
    return renderToStaticMarkup(
        <SubtaskSection
            taskId="t1"
            listId="l1"
            subtasks={rows}
            context={context(canEdit)}
            onOpen={() => {}}
            onChanged={() => {}}
            onError={() => {}}
        />
    );
}

describe("subtask rows", () => {
    it("hangs a menu on the row rather than on the list item that carries the drag", () => {
        const markup = section([subtask()]);
        // The trigger keeps the row from being taken over by the platform's own
        // long-press menu; the list item stays free to be dragged.
        expect(markup).toContain("-webkit-touch-callout:none");
        expect(markup.indexOf("<li")).toBeLessThan(markup.indexOf("-webkit-touch-callout:none"));
    });

    it("still opens a subtask by its name and shows who has it", () => {
        const markup = section([subtask({ assignees: [ANA] })]);
        expect(markup).toContain("Write the migration");
        expect(markup).toContain("FJRG-2");
        expect(markup).toContain("AR");
    });

    it("says what a task with no subtasks is for", () => {
        expect(section([])).toContain("Break this down");
    });
});
