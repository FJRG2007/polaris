// @vitest-environment jsdom

/**
 * Where a task let go on a row in the List view actually lands.
 *
 * The row and the group underneath it are both drop targets, and the group's
 * one means "the end of this group". A drop that named a row has to be the only
 * one heard: when both fired, two moves were written for one gesture and the
 * end-of-group one landed last, which put the task at the bottom of the group
 * no matter where the pointer was - the exact complaint the edge-aware drop was
 * written to answer.
 *
 * Also here: a row let go on itself, which names the place it is already in and
 * must write nothing at all. Reported as two empty neighbours, the server reads
 * "no position given" and sends it to the bottom.
 */

import type { TaskGroup } from "@polaris/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@/app/(app)/tasks/actions", () => ({}));

const { ListView } = await import("@/app/(app)/tasks/views/rows");

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

const TASKS = [
    taskRow("t1", "Rotate the logs", 1),
    taskRow("t2", "Restore the backups", 2),
    taskRow("t3", "Rename the column", 3)
];

const GROUP: TaskGroup<TaskRow> = { key: "st1", label: "Open", tasks: [...TASKS] };

function context(): SpaceContext {
    return {
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
}

/** The list, with every intent it reports recorded rather than acted on. */
function list() {
    const onMove = vi.fn();
    const view = render(
        <ListView
            rows={TASKS}
            groups={[GROUP]}
            context={context()}
            canEdit
            orderable
            groupBy="status"
            selection={new Set<string>()}
            selected={[]}
            lists={[{ id: "l1", name: "Inbox", spaceId: "s1" }]}
            onOpen={() => undefined}
            onSelect={() => undefined}
            onMove={onMove}
            onQuickCreate={() => undefined}
            onEdit={() => undefined}
            onApply={() => undefined}
            onDuplicate={() => undefined}
            onDelete={() => undefined}
        />
    );
    const row = (name: string) => {
        const found = view.getByText(name).closest("li");
        if (!found) throw new Error(`No row for ${name}`);
        return found;
    };
    return { onMove, row };
}

/** A drag event carrying a pointer position, which the jsdom shorthand does not. */
function drag(type: string, clientY: number): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
    Object.defineProperty(event, "dataTransfer", {
        value: { effectAllowed: "", setData: () => undefined }
    });
    return event;
}

/** Pick `from` up and let it go on the named half of `to`. */
function dragOnto(from: Element, to: Element, half: "top" | "bottom"): void {
    // Nothing has a size in jsdom, so the row is given one: the halves are what
    // the gesture is about.
    to.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140 }) as DOMRect;
    const clientY = half === "top" ? 105 : 135;
    fireEvent(from, drag("dragstart", clientY));
    fireEvent(to, drag("dragover", clientY));
    fireEvent(to, drag("drop", clientY));
}

afterEach(cleanup);

describe("a task let go on a row in the List view", () => {
    it("lands beside that row, and is not overruled by the group underneath", () => {
        const { onMove, row } = list();

        dragOnto(row("Rotate the logs"), row("Restore the backups"), "top");

        expect(onMove).toHaveBeenCalledTimes(1);
        expect(onMove.mock.calls[0][0]).toEqual({
            taskId: "t1",
            groupKey: "st1",
            position: { beforeId: null, afterId: "t2", placed: true }
        });
    });

    it("reaches the end of the group, where the group's own drop used to send it", () => {
        const { onMove, row } = list();

        dragOnto(row("Rotate the logs"), row("Rename the column"), "bottom");

        expect(onMove).toHaveBeenCalledTimes(1);
        expect(onMove.mock.calls[0][0].position).toEqual({
            beforeId: "t3",
            afterId: null,
            placed: true
        });
    });

    it("writes nothing when it is let go on itself", () => {
        const { onMove, row } = list();

        dragOnto(row("Restore the backups"), row("Restore the backups"), "bottom");

        expect(onMove).not.toHaveBeenCalled();
    });
});
