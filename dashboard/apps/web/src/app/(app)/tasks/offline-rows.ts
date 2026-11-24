/**
 * The tasks a screen shows, with what this device wrote and has not sent yet
 * drawn over them: a change shows as made, a move as moved, and a task made
 * here sits in its list - with no reference until the server numbers it.
 *
 * Pure, so the screen and its test read the same answer.
 */

import { taskOverlay } from "./optimistic";
import type { TaskListRef } from "./views/shared";
import type { AppWrite } from "@/lib/offline/app-writes";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";

export const TASK_CREATE = "task.create";
export const TASK_UPDATE = "task.update";
export const TASK_MOVE = "task.move";

type Directory = Pick<SpaceContext, "statuses" | "people" | "tags">;

/** A task made on this device, as a row draws it, before the server has it. */
function madeHere(entry: AppWrite, list: TaskListRef, spaceName: string, directory: Directory): TaskRow {
    const fields = entry.payload as Record<string, unknown>;
    const status = directory.statuses.find((candidate) => candidate.id === fields.statusId) ?? directory.statuses[0];
    const text = (key: string): string => (typeof fields[key] === "string" ? (fields[key] as string) : "");
    const optional = (key: string): string | null => (typeof fields[key] === "string" ? (fields[key] as string) : null);
    const count = (key: string): number | null => (typeof fields[key] === "number" ? (fields[key] as number) : null);
    const blockedUntil = optional("blockedUntil");
    const blockedNote = text("blockedNote");
    return {
        id: entry.target,
        reference: "",
        name: text("name"),
        description: text("description"),
        spaceId: list.spaceId,
        spaceName,
        listId: list.id,
        listName: list.name,
        folderName: null,
        parentId: optional("parentId"),
        statusId: status?.id ?? null,
        statusName: status?.name ?? "",
        statusColor: status?.color ?? "#64748b",
        statusType: status?.type ?? "open",
        priority: (typeof fields.priority === "string" ? fields.priority : "none") as TaskRow["priority"],
        assignees: [],
        tags: [],
        createdById: null,
        startDate: optional("startDate"),
        dueDate: optional("dueDate"),
        timed: fields.timed === true,
        timeEstimate: count("timeEstimate"),
        points: count("points"),
        milestone: fields.milestone === true,
        archived: false,
        // After everything the server already ordered: it is the newest.
        order: Number.MAX_SAFE_INTEGER,
        sprintId: optional("sprintId"),
        completedAt: null,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        subtaskCount: 0,
        commentCount: 0,
        trackedSeconds: 0,
        blocked: blockedUntil !== null || blockedNote !== "",
        blockedUntil,
        blockedNote,
        recurring: false,
        customValues: {},
        ...taskOverlay({ assigneeIds: fields.assigneeIds, tagIds: fields.tagIds }, directory)
    };
}

/**
 * `tasks` with `entries` (waiting and failed task writes, oldest first) applied.
 * A task made here shows only on a screen holding its list; once the server
 * has it, the server's row is the one drawn.
 */
export function withQueuedWrites(
    tasks: readonly TaskRow[],
    entries: readonly AppWrite[],
    directory: Directory,
    lists: readonly TaskListRef[],
    listId: string | null
): readonly TaskRow[] {
    if (entries.length === 0) return tasks;
    const changes = new Map<string, Record<string, unknown>>();
    const made: AppWrite[] = [];
    for (const entry of entries) {
        if (entry.kind === TASK_CREATE) made.push(entry);
        else if (entry.kind === TASK_UPDATE || entry.kind === TASK_MOVE) {
            const fields = { ...(entry.payload as Record<string, unknown>) };
            delete fields.taskId;
            delete fields.beforeId;
            delete fields.afterId;
            // A move to "no status" is a status the overlay cannot draw: left to the server.
            if (fields.statusId === null) delete fields.statusId;
            changes.set(entry.target, { ...changes.get(entry.target), ...fields });
        }
    }
    const known = new Set(tasks.map((task) => task.id));
    const spaceNames = new Map(tasks.map((task) => [task.spaceId, task.spaceName]));
    const extra: TaskRow[] = [];
    for (const entry of made) {
        if (known.has(entry.target)) continue;
        const list = lists.find((candidate) => candidate.id === (entry.payload as { listId?: unknown; }).listId);
        if (!list || (listId !== null && list.id !== listId)) continue;
        extra.push(madeHere(entry, list, spaceNames.get(list.spaceId) ?? "", directory));
    }
    const apply = (task: TaskRow): TaskRow => {
        const change = changes.get(task.id);
        return change ? { ...task, ...taskOverlay(change, directory) } : task;
    };
    return [...tasks, ...extra].map(apply);
}
