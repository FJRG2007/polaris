/**
 * What every view is handed, and what it hands back.
 *
 * Views are presentational: they receive tasks that are already filtered,
 * sorted and grouped by the engine, and they report intents ("this was dropped
 * before that", "make a task here"). Nothing in a view talks to the server, so
 * a new view type is a rendering problem rather than a data one.
 */

import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import {
    TASK_SELECTION_MAX,
    type TaskGroup,
    type TaskGroupField,
    type TaskPriority,
    type TaskStatusType
} from "@polaris/core";

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

/**
 * A change applied to however many tasks the menu is acting on.
 *
 * People and tags are added and removed rather than replaced: a selection has no
 * one set of either to replace, and "put this label on all five" is what the
 * gesture means anyway. Everything else is the same value on every task.
 */
export interface TaskBulkEdit {
    readonly statusId?: string;
    readonly priority?: TaskPriority;
    readonly addAssigneeIds?: string[];
    readonly removeAssigneeIds?: string[];
    readonly addTagIds?: string[];
    readonly removeTagIds?: string[];
    readonly dueDate?: string | null;
    /** Move the work into another list of the same space. */
    readonly listId?: string;
    readonly archived?: boolean;
}

/** A list work can be moved into. The space is carried because a screen can span
 *  several and a task only moves between lists of its own. */
export interface TaskListRef {
    readonly id: string;
    readonly name: string;
    readonly spaceId: string;
}

/**
 * How a click changed the selection: `toggle` for a ctrl-click on one task,
 * `range` for a shift-click reaching back to the last one clicked.
 */
export type SelectMode = "toggle" | "range";

/**
 * What a click on a task means, read the way every file manager reads it: shift
 * reaches back to the last task clicked, ctrl (or cmd) toggles that one on its
 * own, and a plain click opens the task. Null is that plain click.
 *
 * Shift is checked first so ctrl-shift is a range too, which is the gesture for
 * "add this run to what I already have" - and the range here adds rather than
 * replaces, so the two land in the same place.
 *
 * Here rather than in each view so the five of them cannot drift into three
 * different answers to one gesture.
 */
export function clickMode(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): SelectMode | null {
    if (event.shiftKey) return "range";
    return event.metaKey || event.ctrlKey ? "toggle" : null;
}

/**
 * A selection, held to the most tasks one write may carry.
 *
 * A screen loads more rows than that and a shift-click crosses them in a single
 * gesture, so the line is drawn as the selection is made rather than left to the
 * server - which can only refuse the whole thing, leaving somebody with "check
 * the selection", nothing applied, and no idea what the limit was. What did not
 * fit is counted so the screen can say it, because a selection that quietly
 * stopped short is one somebody acts on believing it covered everything.
 */
export function holdSelection(next: ReadonlySet<string>): { taken: ReadonlySet<string>; dropped: number } {
    if (next.size <= TASK_SELECTION_MAX) return { taken: next, dropped: 0 };
    return {
        taken: new Set([...next].slice(0, TASK_SELECTION_MAX)),
        dropped: next.size - TASK_SELECTION_MAX
    };
}

/** What a bulk write did, for the line that reports how much of it landed. */
export type BulkVerb = "Changed" | "Deleted";

/**
 * What to say when a write reached fewer tasks than it was handed, and nothing
 * when it reached them all.
 *
 * A selection crosses spaces, and the server drops the tasks this account may
 * only read rather than refusing the lot - the right answer, and a silent one.
 * The reader has to be told, most of all for a delete: "20 tasks" was confirmed,
 * twelve went, and nothing on the screen would ever have said which eight are
 * still there.
 */
export function shortfallMessage(count: number | undefined, asked: number, verb: BulkVerb): string | null {
    if (count === undefined || count >= asked) return null;
    const rest = asked - count;
    return `${verb} ${count} of ${asked}: ${rest === 1 ? "one task is" : `${rest} tasks are`} not yours to change.`;
}

export interface ViewProps {
    readonly rows: readonly TaskRow[];
    readonly groups: readonly TaskGroup<TaskRow>[];
    readonly context: SpaceContext;
    readonly canEdit: boolean;
    /**
     * Whether dropping a task between two others puts it there.
     *
     * True on an ordinary view whatever it is sorted by: a screen opens in the
     * order the engine chose, and the first time somebody drags a card the
     * screen keeps what it was showing and hands the order to them. False while
     * a search is on, where the rows are ranked by how well they matched and a
     * position between two of them means nothing - the drag then only moves the
     * task to the group it was dropped on.
     */
    readonly orderable: boolean;
    readonly selection: ReadonlySet<string>;
    /** The selection as rows, narrowed to what is on screen. Resolved once by the
     *  screen rather than per row, since every row would otherwise walk the whole
     *  set to find out what a right-click on it would act on. */
    readonly selected: readonly TaskRow[];
    /** The lists work can be moved into, across every space on this screen. */
    readonly lists: readonly TaskListRef[];
    readonly onOpen: (taskId: string) => void;
    /**
     * A click that changed the selection rather than opening the task. `ordered`
     * is the ids in the order this view is drawing them, because that is what a
     * shift-click means: everything between the two rows on the screen somebody
     * is looking at, which a board reads down its columns and a table down its
     * rows.
     */
    readonly onSelect: (taskId: string, mode: SelectMode, ordered: readonly string[]) => void;
    readonly onMove: (move: BoardMove) => void;
    readonly onQuickCreate: (groupKey: string, name: string) => void;
    /** Apply a change from the row itself, optimistically. */
    readonly onEdit: (task: TaskRow, change: TaskEdit) => void;
    /** Apply a change to everything a menu is acting on, which is one task or a
     *  whole selection. */
    readonly onApply: (tasks: readonly TaskRow[], change: TaskBulkEdit) => void;
    readonly onDuplicate: (task: TaskRow) => void;
    /** Asks for these tasks to be deleted; the screen owns the confirmation. */
    readonly onDelete: (tasks: readonly TaskRow[]) => void;
    /** Born where it is needed: a tag typed into a picker that matches nothing. */
    readonly onCreateTag?: (name: string, color: string) => Promise<string | null>;
    /** Whether a row has to say where it lives. True on the screens that mix
     *  several lists - Everything, a sprint, a space - where a task name alone
     *  does not say which piece of work it belongs to. */
    readonly showLocation?: boolean;
    /** What the board is grouped by, so it knows whether a new column is a
     *  status somebody can add or a slice of data it cannot invent. */
    readonly groupBy?: TaskGroupField;
    /** Add a status to the space, from the end of the board or from a task's own
     *  menu, and say which one was made so the caller can put a task on it.
     *  Only supplied when the reader may change the space's statuses and the
     *  screen belongs to one space, which is what decides whether the affordance
     *  exists at all. */
    readonly onCreateStatus?: (name: string, type: TaskStatusType, color: string) => Promise<string | null>;
    /** Reshape a column: what it is called, what it means for the work sitting in
     *  it, and the colour it is read by. Supplied under the same rule as
     *  `onCreateStatus`, and reports whether the change landed. */
    readonly onUpdateStatus?: (
        statusId: string,
        name: string,
        type: TaskStatusType,
        color: string
    ) => Promise<boolean>;
    /** Remove a column, moving the work on it onto the status given: a board that
     *  quietly drops tasks is worse than one that refuses the delete. */
    readonly onDeleteStatus?: (statusId: string, replacementId: string) => Promise<boolean>;
    /** Write down the order the columns were dragged into. It belongs to the
     *  space, so it is the order everybody on it opens the board in. */
    readonly onReorderStatuses?: (orderedIds: string[]) => Promise<boolean>;
}
