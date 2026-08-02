/**
 * The wire shape of a task, and how it becomes something the engine can reason
 * about.
 *
 * Dates cross the server boundary as ISO strings, the way every other Polaris
 * payload does, while `@polaris/core`'s engine works in real Dates so its
 * comparisons are arithmetic rather than string prefixes. `toFacts` is the one
 * place that bridges the two, so a screen never hand-rolls a `new Date()` on a
 * field the engine is about to read.
 *
 * Pure and client-safe on purpose: the board re-filters and re-groups locally
 * after a drag, using exactly the rules the server used to build the page.
 */

import type { CustomFieldView, StatusView, TagView } from "./space-service";
import type { TaskFacts, TaskPriority, TaskStatusType } from "@polaris/core";

/** A person as any picker or avatar renders them. */
export interface PersonRef {
    readonly id: string;
    readonly name: string;
    readonly image: string | null;
}

export interface TagRef {
    readonly id: string;
    readonly name: string;
    readonly color: string;
}

/** One task, as every list, board, table and calendar receives it. */
export interface TaskRow {
    readonly id: string;
    /** The reference people quote: "ENG-42". */
    readonly reference: string;
    readonly name: string;
    readonly description: string;
    readonly spaceId: string;
    readonly listId: string;
    readonly listName: string;
    readonly parentId: string | null;
    readonly statusId: string | null;
    readonly statusName: string;
    readonly statusColor: string;
    readonly statusType: TaskStatusType;
    readonly priority: TaskPriority;
    readonly assignees: PersonRef[];
    readonly tags: TagRef[];
    readonly createdById: string | null;
    readonly startDate: string | null;
    readonly dueDate: string | null;
    readonly timed: boolean;
    /** Minutes. */
    readonly timeEstimate: number | null;
    readonly points: number | null;
    readonly milestone: boolean;
    readonly archived: boolean;
    readonly order: number;
    readonly sprintId: string | null;
    readonly completedAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly subtaskCount: number;
    readonly commentCount: number;
    /** Seconds logged against this task by everyone. */
    readonly trackedSeconds: number;
    /** Something unfinished is in this task's way. */
    readonly blocked: boolean;
    /** Whether a recurrence rule is attached, so a card can say so. */
    readonly recurring: boolean;
    readonly customValues: Record<string, string>;
}

function toDate(value: string | null): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A row as the engine reads it. */
export function toFacts(row: TaskRow): TaskFacts {
    return {
        id: row.id,
        name: row.name,
        listId: row.listId,
        parentId: row.parentId,
        statusId: row.statusId,
        statusType: row.statusType,
        priority: row.priority,
        assigneeIds: row.assignees.map((person) => person.id),
        tagIds: row.tags.map((tag) => tag.id),
        createdById: row.createdById,
        startDate: toDate(row.startDate),
        dueDate: toDate(row.dueDate),
        timed: row.timed,
        createdAt: new Date(row.createdAt),
        updatedAt: toDate(row.updatedAt),
        completedAt: toDate(row.completedAt),
        points: row.points,
        timeEstimate: row.timeEstimate,
        archived: row.archived,
        order: row.order,
        customValues: row.customValues
    };
}

/** Facts for a whole set, keyed by id so a view can look one up after a drag. */
export function factsById(rows: readonly TaskRow[]): Map<string, TaskFacts> {
    return new Map(rows.map((row) => [row.id, toFacts(row)]));
}

/**
 * The space vocabulary every task screen needs: what a status means here, who
 * can be assigned, which fields exist, and how far the reader is allowed in.
 *
 * Passed down from the server page rather than fetched per component - the page
 * already had to load all of it to render the first paint, and re-fetching it in
 * a panel is a waterfall for data that has not changed.
 */
export interface SpaceContext {
    readonly spaceId: string;
    readonly statuses: readonly StatusView[];
    readonly tags: readonly TagView[];
    readonly fields: readonly CustomFieldView[];
    readonly people: readonly PersonRef[];
    /** May change tasks: a member or better. */
    readonly canEdit: boolean;
    /** May remove other people's comments and time: an admin or the owner. */
    readonly canModerate: boolean;
    readonly currentUserId: string;
    /** Other tasks in the space, for the dependency picker. */
    readonly siblings: readonly TaskRow[];
}
