/**
 * What every view is handed, and what it hands back.
 *
 * Views are presentational: they receive tasks that are already filtered,
 * sorted and grouped by the engine, and they report intents ("this was dropped
 * before that", "make a task here"). Nothing in a view talks to the server, so
 * a new view type is a rendering problem rather than a data one.
 */

import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import type { TaskGroup, TaskGroupField, TaskPriority, TaskStatusType } from "@polaris/core";

/** A drag result, described by the neighbours it landed between. */
export interface BoardMove {
    readonly taskId: string;
    /** The group it was dropped into: a status id when grouping by status, the
     *  group key otherwise. */
    readonly groupKey: string;
    readonly position: { beforeId: string | null; afterId: string | null };
}

/**
 * A change made from a row without opening the task. Every field here is one a
 * person changes far more often than they change a description, which is why
 * they are reachable from the row at all.
 */
export interface TaskEdit {
    readonly statusId?: string;
    readonly priority?: TaskPriority;
    readonly assigneeIds?: string[];
    readonly tagIds?: string[];
    readonly dueDate?: string | null;
}

export interface ViewProps {
    readonly rows: readonly TaskRow[];
    readonly groups: readonly TaskGroup<TaskRow>[];
    readonly context: SpaceContext;
    readonly canEdit: boolean;
    readonly selection: ReadonlySet<string>;
    readonly onOpen: (taskId: string) => void;
    readonly onSelect: (taskId: string) => void;
    readonly onMove: (move: BoardMove) => void;
    readonly onQuickCreate: (groupKey: string, name: string) => void;
    /** Apply a change from the row itself, optimistically. */
    readonly onEdit: (task: TaskRow, change: TaskEdit) => void;
    readonly onDuplicate: (task: TaskRow) => void;
    /** Asks for the task to be deleted; the screen owns the confirmation. */
    readonly onDelete: (task: TaskRow) => void;
    /** Born where it is needed: a tag typed into a picker that matches nothing. */
    readonly onCreateTag?: (name: string, color: string) => Promise<string | null>;
    /** What the board is grouped by, so it knows whether a new column is a
     *  status somebody can add or a slice of data it cannot invent. */
    readonly groupBy?: TaskGroupField;
    /** Add a status to the space from the end of the board. Only supplied when
     *  the reader may change the space's statuses, which is what decides whether
     *  the affordance exists at all. */
    readonly onCreateGroup?: (name: string, type: TaskStatusType, color: string) => Promise<void>;
}
