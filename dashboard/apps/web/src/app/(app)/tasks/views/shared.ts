/**
 * What every view is handed, and what it hands back.
 *
 * Views are presentational: they receive tasks that are already filtered,
 * sorted and grouped by the engine, and they report intents ("this was dropped
 * before that", "make a task here"). Nothing in a view talks to the server, so
 * a new view type is a rendering problem rather than a data one.
 */

import type { TaskGroup } from "@polaris/core";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";


/** A drag result, described by the neighbours it landed between. */
export interface BoardMove {
    readonly taskId: string;
    /** The group it was dropped into: a status id when grouping by status, the
     *  group key otherwise. */
    readonly groupKey: string;
    readonly position: { beforeId: string | null; afterId: string | null };
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
    /** Complete or reopen from a row, the most-used control in the app. */
    readonly onToggleComplete: (task: TaskRow, complete: boolean) => void;
}
