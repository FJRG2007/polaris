import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskCard } from "@/app/(app)/tasks/views/board";
import type { TaskCommands } from "@/app/(app)/tasks/views/task-actions";
import type { PersonRef, SpaceContext, TaskRow } from "@/lib/tasks/facts";

const ANA: PersonRef = { id: "u1", name: "Ana Ruiz", image: null };

function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
    return {
        id: "t1",
        reference: "FJRG-1",
        name: "Add backup codes",
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
        order: 1,
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

function commandsFor(task: TaskRow, canEdit = true): TaskCommands {
    const context: SpaceContext = {
        spaceId: "s1",
        statuses: [],
        tags: [],
        fields: [],
        people: [ANA],
        canEdit,
        canModerate: canEdit,
        currentUserId: "u1",
        siblings: []
    };
    return {
        task,
        context,
        canEdit,
        onOpen: () => {},
        onEdit: () => {},
        onDuplicate: () => {},
        onDelete: () => {}
    };
}

function card(task: TaskRow, canEdit = true): string {
    return renderToStaticMarkup(
        <TaskCard commands={commandsFor(task, canEdit)} selected={false} onDragStart={() => {}} onDropBefore={() => {}} />
    );
}

describe("board card", () => {
    it("puts the assignees in the header corner, above the name", () => {
        const markup = card(taskRow({ assignees: [ANA] }));
        expect(markup).toContain("AR");
        expect(markup.indexOf("AR")).toBeLessThan(markup.indexOf("Add backup codes"));
    });

    it("drops the bottom line when there is nothing on it", () => {
        const bare = card(taskRow({ assignees: [ANA] }));
        expect(bare).not.toContain("pts");
        const withMeta = card(taskRow({ assignees: [ANA], points: 3, commentCount: 2 }));
        expect(withMeta).toContain("3 pts");
    });

    it("offers the priority and assignee controls even when both are empty", () => {
        const markup = card(taskRow());
        expect(markup).toContain('aria-label="Priority"');
        expect(markup).toContain('aria-label="Assignees"');
    });

    it("keeps an empty control on screen while its own menu is open", () => {
        // The menu takes the pointer off the card, so a control revealed by
        // hover alone would vanish the moment it was used.
        const markup = card(taskRow());
        expect(markup).toContain("has-[[data-state=open]]:opacity-100");
    });

    it("offers no controls to somebody who cannot edit", () => {
        const markup = card(taskRow(), false);
        expect(markup).not.toContain('aria-label="Priority"');
        expect(markup).not.toContain('aria-label="Assignees"');
    });
});
