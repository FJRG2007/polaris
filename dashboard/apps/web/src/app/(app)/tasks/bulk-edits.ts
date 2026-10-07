/**
 * What a change from the selection bar actually does to a selection, and how to
 * take it back.
 *
 * Pure, so the screen and its tests agree on both answers. A bulk change is
 * measured against the rows as they were when it was asked for: the tasks it
 * would leave as they are are not written at all, and "undo" puts back what each
 * task said before rather than one value for all of them - a selection rarely
 * started out in one status.
 */

import type { TaskRow } from "@/lib/tasks/facts";
import type { TaskBulkEdit } from "./views/shared";

/** One write of an undo: the same verb, aimed at the tasks that had this value. */
export interface BulkStep {
    readonly tasks: readonly TaskRow[];
    readonly change: TaskBulkEdit;
}

/** Whether the change would leave this task any different. Only the verbs the
 *  selection bar offers are measured; anything else counts as a change. */
export function changes(task: TaskRow, change: TaskBulkEdit): boolean {
    if (change.statusId !== undefined) return task.statusId !== change.statusId;
    if (change.priority !== undefined) return task.priority !== change.priority;
    if (change.addAssigneeIds !== undefined) {
        const held = new Set(task.assignees.map((person) => person.id));
        return change.addAssigneeIds.some((id) => !held.has(id));
    }
    if (change.archived !== undefined) return task.archived !== change.archived;
    return true;
}

/** The tasks a change would actually reach. */
export function affected(tasks: readonly TaskRow[], change: TaskBulkEdit): TaskRow[] {
    return tasks.filter((task) => changes(task, change));
}

function groupBy<K>(tasks: readonly TaskRow[], key: (task: TaskRow) => K): Map<K, TaskRow[]> {
    const groups = new Map<K, TaskRow[]>();
    for (const task of tasks) {
        const at = key(task);
        groups.set(at, [...(groups.get(at) ?? []), task]);
    }
    return groups;
}

/**
 * The writes that put `tasks` back the way they were before `change`.
 *
 * `tasks` are the rows as they stood before it, and only the ones it reached.
 * Empty when there is no way back: a task that had no status cannot be given
 * "no status" by a bulk write, so it is left where the change put it rather than
 * guessed at.
 */
export function undoSteps(tasks: readonly TaskRow[], change: TaskBulkEdit): BulkStep[] {
    if (change.statusId !== undefined) {
        return [...groupBy(tasks, (task) => task.statusId)]
            .filter((entry): entry is [string, TaskRow[]] => entry[0] !== null)
            .map(([statusId, group]) => ({ tasks: group, change: { statusId } }));
    }
    if (change.priority !== undefined) {
        return [...groupBy(tasks, (task) => task.priority)].map(([priority, group]) => ({
            tasks: group,
            change: { priority }
        }));
    }
    if (change.addAssigneeIds !== undefined) {
        // Each person comes off only the tasks they were not already on.
        return change.addAssigneeIds
            .map((id) => ({
                tasks: tasks.filter((task) => !task.assignees.some((person) => person.id === id)),
                change: { removeAssigneeIds: [id] }
            }))
            .filter((step) => step.tasks.length > 0);
    }
    if (change.archived !== undefined) {
        return tasks.length > 0 ? [{ tasks, change: { archived: !change.archived } }] : [];
    }
    return [];
}
