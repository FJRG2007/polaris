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

import type { TaskEdit } from "./views/shared";
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
    "sprintId"
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
