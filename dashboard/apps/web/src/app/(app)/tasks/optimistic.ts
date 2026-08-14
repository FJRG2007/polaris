/**
 * What a task change looks like before the server has agreed to it.
 *
 * Every screen that edits a task - the list, the board, My work, the subtasks inside
 * a task, the panel itself - has to repaint on the click rather than on the round
 * trip, or assigning somebody feels like the click missed. They were not all doing
 * it, and the ones that were had their own copy of the resolution, so this is one
 * function: a change speaks in ids, a row draws names and colours, and turning one
 * into the other is the whole job.
 *
 * Only the fields a change can carry are resolved, and only from what the space
 * already knows. Anything the server derives - a completion timestamp, a rollup, a
 * recurrence spawning the next occurrence - is left to the reload that follows, which
 * is why the overlay is dropped rather than merged when fresh rows arrive.
 */

import type { TaskBulkEdit, TaskEdit } from "./views/shared";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";

/** The row shape as an overlay: writable, and every field optional. */
export type TaskOverlay = { -readonly [Key in keyof TaskRow]?: TaskRow[Key] };

/** What the space knows, which is everything an id has to be resolved against. */
type Directory = Pick<SpaceContext, "statuses" | "people" | "tags">;

/**
 * Fields a change carries at the same name and shape a row draws them in, so they
 * need no resolution. Listed rather than spread, because a patch also carries keys a
 * row has no business holding (a recurrence rule, a checklist) and copying those in
 * would put shapes into the overlay that nothing knows how to render.
 */
const PASSTHROUGH = [
    "name",
    "description",
    "priority",
    "startDate",
    "dueDate",
    "timed",
    "timeEstimate",
    "points",
    "milestone",
    "archived",
    "sprintId",
    "blockedUntil",
    "blockedNote"
] as const;

/**
 * The row fields a change implies.
 *
 * `change` is the same object the update action is called with, so a caller never
 * has to describe its edit twice. A key it does not carry is absent from the result
 * rather than null: an overlay is merged over the row, and null would erase a value
 * nobody touched.
 */
export function taskOverlay(change: TaskEdit | Record<string, unknown>, context: Directory): TaskOverlay {
    // A row's menu speaks `TaskEdit`; the panel sends the whole update input, which is
    // wider and open-ended. Read as one bag of keys here, and only the ones named
    // below are taken out of it - the interface has no index signature and adding one
    // would let any typo through where the edit is actually written.
    const fields = change as Record<string, unknown>;
    const overlay: TaskOverlay = {};

    for (const key of PASSTHROUGH) {
        if (fields[key] !== undefined) Object.assign(overlay, { [key]: fields[key] });
    }

    if (fields.statusId !== undefined) {
        // A status the space does not have is not applied at all: the row would keep
        // the old colour and name beside a new id, which reads as a rendering bug.
        const status = context.statuses.find((entry) => entry.id === fields.statusId);
        if (status) {
            overlay.statusId = status.id;
            overlay.statusName = status.name;
            overlay.statusColor = status.color;
            overlay.statusType = status.type;
        }
    }

    if (Array.isArray(fields.assigneeIds)) {
        const wanted = new Set(fields.assigneeIds as string[]);
        overlay.assignees = context.people.filter((person) => wanted.has(person.id));
    }

    if (Array.isArray(fields.tagIds)) {
        const wanted = new Set(fields.tagIds as string[]);
        overlay.tags = context.tags.filter((tag) => wanted.has(tag.id));
    }

    return overlay;
}

/**
 * Whether a change would actually change the task.
 *
 * A field edited and put back where it started is not an edit, and writing it
 * anyway costs a round trip and leaves a line in the task's history saying somebody
 * changed nothing. It matters most where a field saves itself while it is being
 * typed, because there the same value arrives again on every pause.
 *
 * Compared against the task as the server last confirmed it rather than against the
 * screen: a write that was refused has to still look like an edit, or it is never
 * tried again. Anything the row does not hold under that name - a list of ids, a
 * recurrence rule - counts as a change, because the cost of an unnecessary write is
 * one request and the cost of a skipped one is somebody's paragraph.
 */
export function wouldChange(change: Record<string, unknown>, task: TaskRow): boolean {
    const row = task as unknown as Record<string, unknown>;
    return Object.entries(change).some(([field, value]) => !Object.is(row[field], value));
}

/**
 * The same, for a change a menu is applying to a whole selection.
 *
 * People and tags arrive there as additions and removals rather than as a list,
 * because five tasks have no one set of either to replace. Each row folds the
 * change into its own set first, and what comes out is an ordinary edit that
 * `taskOverlay` already knows how to resolve.
 *
 * A move and an archive are not resolved at all: both change which rows belong
 * on the screen rather than what one row shows, and that is the reload's answer.
 */
export function bulkOverlay(task: TaskRow, change: TaskBulkEdit, context: Directory): TaskOverlay {
    const assignees = new Set(task.assignees.map((person) => person.id));
    for (const id of change.addAssigneeIds ?? []) assignees.add(id);
    for (const id of change.removeAssigneeIds ?? []) assignees.delete(id);

    const tags = new Set(task.tags.map((tag) => tag.id));
    for (const id of change.addTagIds ?? []) tags.add(id);
    for (const id of change.removeTagIds ?? []) tags.delete(id);

    const touchesPeople = change.addAssigneeIds !== undefined || change.removeAssigneeIds !== undefined;
    const touchesTags = change.addTagIds !== undefined || change.removeTagIds !== undefined;

    return taskOverlay(
        {
            statusId: change.statusId,
            priority: change.priority,
            dueDate: change.dueDate,
            assigneeIds: touchesPeople ? [...assignees] : undefined,
            tagIds: touchesTags ? [...tags] : undefined
        },
        context
    );
}
