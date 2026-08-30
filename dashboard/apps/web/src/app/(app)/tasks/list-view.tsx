"use client";

/**
 * The workhorse screen: one list, seen five ways.
 *
 * The server sends the tasks once; everything after that - filtering, grouping,
 * sorting, switching between List, Board, Table, Calendar and Gantt - happens
 * here against the same @polaris/core engine the server would have used. That is
 * what makes changing the grouping instant instead of a round trip, and it is
 * why a saved view is settings rather than a query somebody has to keep in step.
 *
 * Writes are optimistic where the result is obvious (a drag, a tick) and plain
 * where it is not. A refused write reloads the list rather than leaving the
 * screen showing something that did not happen.
 */

import Fuse from "fuse.js";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { FilterBar } from "./filter-bar";
import { TaskPanel } from "./task-panel";
import { BoardView } from "./views/board";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { GanttView } from "./views/schedule";
import { CalendarView } from "./views/calendar";
import { keyboardIsBusy } from "@/lib/keyboard";
import { useStableOrder } from "./stable-order";
import { ListView, TableView } from "./views/rows";
import { TaskCreateDialog } from "./task-create-dialog";
import { AssigneePicker, StatusPicker } from "./pickers";
import type { SavedView } from "@/lib/tasks/view-service";
import { useDisplayFormat } from "@/components/display-format";
import { holdSelection, shortfallMessage } from "./views/shared";
import { bulkOverlay, taskOverlay, useLatest } from "./optimistic";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toFacts, type SpaceContext, type TaskRow } from "@/lib/tasks/facts";
import { settleTagIds, useTagCreation, withCreatedTags } from "./tag-creation";
import { Button, ConfirmDeleteDialog, EmptyState, Select, cn } from "@polaris/ui";
import { readViewPreferences, viewScopeKey, writeViewPreferences } from "./view-preferences";
import { CalendarDays, GanttChart, LayoutList, Plus, Rows3, Search, Table2, X } from "lucide-react";
import type {
    BulkVerb,
    SelectMode,
    TaskBulkEdit,
    TaskEdit,
    TaskListRef,
    ViewProps
} from "./views/shared";

/**
 * What a screen opens on when nothing has said otherwise.
 *
 * Priority rather than manual order, because manual order only means something
 * once somebody has dragged a card: on a list nobody has arranged by hand it is
 * creation order wearing another name, which puts the most urgent work wherever
 * it happened to be typed. Held at module scope so restoring it is a no-op React
 * can skip rather than another render.
 */
const DEFAULT_SORT: core.TaskSort = { field: "priority", direction: "asc" };

const VIEW_ICONS: Record<core.TaskViewType, typeof LayoutList> = {
    list: LayoutList,
    board: Rows3,
    table: Table2,
    calendar: CalendarDays,
    gantt: GanttChart
};

export interface ListScreenProps {
    /** The list being shown, or null for a cross-list view (a space, a sprint). */
    readonly listId: string | null;
    readonly title: string;
    readonly subtitle?: string;
    readonly tasks: readonly TaskRow[];
    readonly savedViews: readonly SavedView[];
    readonly context: SpaceContext;
    /** Every list in reach, so a task can be moved into one of its own space. */
    readonly lists: readonly TaskListRef[];
    /** Where a quick-add goes when the screen spans several lists. */
    readonly defaultListId: string | null;
    /** Opened straight away, for a deep link to one task. */
    readonly initialTaskId?: string | null;
    /** Applied instead of the saved view's own filter, for a link that arrives
     *  already narrowed - one person's work, say. It is an ordinary filter once
     *  the screen has it, so the bar can widen or clear it. */
    readonly initialFilter?: core.TaskFilter;
}

export function ListScreen({
    listId,
    title,
    subtitle,
    tasks,
    savedViews,
    context: space,
    lists,
    defaultListId,
    initialTaskId = null,
    initialFilter
}: ListScreenProps) {
    const router = useRouter();
    const format = useDisplayFormat();
    const [, startRefresh] = useTransition();

    // A private view is one person's own way of looking at this list, so it is
    // the one they open on; a shared view is the list's, and is what everybody
    // else gets. That is also where anything this screen saves for them goes -
    // reshaping what the rest of the team sees is not a thing a drag should do.
    const ownView = savedViews.find((view) => view.ownerId === space.currentUserId && !view.shared);
    const initial = ownView ?? savedViews[0];
    const [viewType, setViewType] = useState<core.TaskViewType>(initial?.type ?? "board");
    const [groupBy, setGroupBy] = useState<core.TaskGroupField>(initial?.groupBy ?? "status");
    const [sort, setSort] = useState<core.TaskSort>(initial?.sort ?? DEFAULT_SORT);
    const [filter, setFilter] = useState<core.TaskFilter>(
        initialFilter ?? initial?.filter ?? core.EMPTY_FILTER
    );
    const [showClosed, setShowClosed] = useState(initial?.showClosed ?? false);
    // Not remembered anywhere: a half-typed name is a question somebody asked
    // once, and a screen that reopened still narrowed to it looks empty for no
    // reason anybody could see.
    const [search, setSearch] = useState("");
    const [openTaskId, setOpenTaskId] = useState<string | null>(initialTaskId);
    // The create dialog, and what was already known when it was asked for.
    const [creating, setCreating] = useState<{ name: string; dueDate: string | null } | null>(null);
    const [deleting, setDeleting] = useState<readonly TaskRow[]>([]);
    const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
    // The task a shift-click reaches back to: the last one clicked on its own.
    const [anchor, setAnchor] = useState<string | null>(null);
    const [error, setError] = useState("");

    // A tag created from a row's picker or its menu goes on the task at once, so
    // this screen has to be able to name it before the reload brings it back -
    // see `useTagCreation`. Everything below reads the space through `context`,
    // which is the one the server sent with those tags folded in.
    const tagBook = useTagCreation(space.spaceId, space.tags);
    const context = useMemo<SpaceContext>(
        () => ({ ...space, tags: tagBook.tags }),
        [space, tagBook.tags]
    );
    // Read at the moment an edit is applied rather than when the menu that applies
    // it was drawn, so a tag created from that menu resolves - see `useLatest`.
    const directory = useLatest(context);

    // Optimistic overlay: what a drag or a tick changed before the server said so.
    const [pending, setPending] = useState<Record<string, Partial<TaskRow>>>({});

    /**
     * How this reader left this screen, read back out of their own browser.
     *
     * After mount rather than during render: the server has no localStorage, and
     * a first paint that disagreed with what it rendered would be a hydration
     * mismatch rather than a preference. So the screen paints on the saved view -
     * which for a list is usually the same arrangement anyway - and settles onto
     * this reader's a moment later.
     *
     * It runs again whenever the screen changes, because moving between two
     * lists reuses this component, and a list nobody has arranged should open on
     * its own saved view rather than inheriting the last one's sort. A link that
     * arrives already narrowed - one person's work - says what to show, and what
     * was left here last time does not get to widen it.
     */
    const scope = viewScopeKey(listId, context.spaceId);
    const [restored, setRestored] = useState<string | null>(null);

    useEffect(() => {
        const stored = readViewPreferences(scope);
        setViewType(stored?.type ?? initial?.type ?? "board");
        setGroupBy(stored?.groupBy ?? initial?.groupBy ?? "status");
        setSort(stored?.sort ?? initial?.sort ?? DEFAULT_SORT);
        setShowClosed(stored?.showClosed ?? initial?.showClosed ?? false);
        setFilter(initialFilter ?? stored?.filter ?? initial?.filter ?? core.EMPTY_FILTER);
        setRestored(scope);
        // The saved view and the incoming filter belong to the screen, so they
        // are already current whenever the screen changes; watching their
        // identities as well would re-read storage on every reload instead.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope]);

    /**
     * Remember it, now rather than on the way out: a tab that is closed, or a
     * link followed away from, never gets the chance to save on leaving.
     *
     * Held back until this screen's own preferences have been read, or the
     * commit that moves between two lists would write the list being left behind
     * over the one being opened.
     */
    useEffect(() => {
        if (restored !== scope) return;
        writeViewPreferences(scope, { type: viewType, groupBy, sort, filter, showClosed });
    }, [restored, scope, viewType, groupBy, sort, filter, showClosed]);

    const rows = useMemo(
        () => tasks.map((task) => ({ ...task, ...pending[task.id] })),
        [tasks, pending]
    );

    /**
     * Go and get what the server now has, and drop the overlay that was standing
     * in for it.
     *
     * `settled` names the tasks the write covered; without it the whole overlay
     * goes, which is what a reload after something structural wants. Naming them
     * matters wherever a row was painted optimistically: two tasks ticked in
     * quick succession share one overlay, and clearing all of it on the first
     * reload flickers the second row back to what it was until its own lands.
     */
    const refresh = (settled?: readonly string[]) =>
        startRefresh(() => {
            setPending((current) => {
                if (!settled) return {};
                const next = { ...current };
                for (const id of settled) delete next[id];
                return next;
            });
            router.refresh();
        });

    // By column, not by row: on a screen spanning several spaces the same status
    // exists once per space, and sorting by its own position would interleave
    // "Done" from one space with "In progress" from another.
    const statusOrder = useMemo(() => core.statusColumnOrder(context.statuses), [context.statuses]);

    // The engine reasons in facts (real Dates); the screen renders rows (ISO
    // strings). Rather than convert back and forth, the facts are derived once
    // and the row is looked back up by id wherever one is drawn.
    const rowById = useMemo(() => new Map(rows.map((task) => [task.id, task])), [rows]);

    const needle = search.trim();

    /**
     * Search is fuzzy, because the way people look for a task is by half
     * remembering it. A substring match only finds "user agent" if that is what
     * somebody typed, and misses it for "useragent", "UA blocked" or a
     * transposed letter - which is exactly when they are searching in the first
     * place. Reference and tags are searchable too, at lower weight, so quoting
     * "ENG-42" still lands on it.
     *
     * Built only while something is being searched for. The index is over every
     * task on the screen and the rows change on every tick of a checkbox, so
     * building it regardless would rebuild a few thousand entries on each edit
     * to answer a question nobody asked.
     */
    const index = useMemo(
        () =>
            needle
                ? new Fuse(rows, {
                      keys: [
                          { name: "name", weight: 3 },
                          { name: "reference", weight: 2 },
                          { name: "description", weight: 1 },
                          { name: "tags.name", weight: 1 }
                      ],
                      threshold: 0.4,
                      ignoreLocation: true,
                      minMatchCharLength: 2
                  })
                : null,
        [rows, needle]
    );

    const hidesClosed = core.hidesClosedWork(groupBy, showClosed);

    const sortedFacts = useMemo(() => {
        const now = new Date();
        const matched = index ? index.search(needle).map((hit) => hit.item) : rows;
        const working = matched
            .filter((task) => !hidesClosed || task.statusType !== "closed")
            .map(toFacts)
            .filter((facts) => core.matchesFilter(facts, filter, now, format.weekStartsOn));
        // A search is already ranked by how well each row matched; re-sorting it
        // by due date would throw that away.
        return index ? working : core.sortTasks(working, sort, statusOrder);
    }, [rows, index, needle, filter, hidesClosed, sort, statusOrder, format.weekStartsOn]);

    /**
     * What the reader asked to see, as opposed to what the data happens to be.
     *
     * The engine sorts; this screen then holds that arrangement until one of
     * these changes, so raising a task's priority does not tear the row out from
     * under the pointer of whoever is triaging. The screen belongs in the key
     * because a soft navigation between two lists reuses the component, and the
     * needle because a search is ranked rather than sorted - carrying the old
     * positions into it would put the best match wherever it used to be.
     */
    const arrangement = `${listId ?? ""}|${sort.field}|${sort.direction}|${needle}`;
    const { items: visibleFacts, arrange, settle } = useStableOrder(sortedFacts, arrangement);

    const visible = useMemo(
        () =>
            visibleFacts
                .map((facts) => rowById.get(facts.id))
                .filter((task): task is TaskRow => task !== undefined),
        [visibleFacts, rowById]
    );

    const groups = useMemo<ViewProps["groups"]>(
        () =>
            core
                .groupTasks(
                    visibleFacts,
                    groupBy,
                    {
                        statuses: context.statuses,
                        people: context.people.map((person) => ({
                            id: person.id,
                            name: person.name
                        })),
                        tags: context.tags,
                        lists
                    },
                    new Date(),
                    format.weekStartsOn
                )
                .map((group) => ({
                    ...group,
                    tasks: group.tasks
                        .map((facts) => rowById.get(facts.id))
                        .filter((task): task is TaskRow => task !== undefined)
                })),
        [
            visibleFacts,
            rowById,
            groupBy,
            context.statuses,
            context.people,
            context.tags,
            lists,
            format.weekStartsOn
        ]
    );

    /**
     * A change made from a row, applied here before it is sent.
     *
     * The overlay carries the resolved shape a row renders - a status id is no
     * use to a cell that draws a colour - so the screen repaints on the click
     * rather than on the round trip. A refused write reloads and the overlay
     * goes with it.
     */
    const editTask = async (task: TaskRow, change: TaskEdit) => {
        setPending((current) => ({
            ...current,
            [task.id]: {
                ...current[task.id],
                ...taskOverlay(change, withCreatedTags(directory.current))
            }
        }));

        // A tag created a moment ago is still carrying this browser's own id, and
        // the write is where it has to be a real one.
        const written = change.tagIds
            ? { ...change, tagIds: await settleTagIds(change.tagIds) }
            : change;
        const result = await runAction(
            () => actions.updateTaskAction({ taskId: task.id, ...written }),
            setError
        );
        if (result?.error) setError(result.error);
        refresh([task.id]);
    };

    const duplicateTask = async (task: TaskRow) => {
        const result = await runAction(() => actions.duplicateTaskAction(task.id), setError);
        if (result?.error) setError(result.error);
        refresh();
    };

    /**
     * Remember that this screen is in manual order, so a reload opens on the
     * arrangement instead of sorting it away again.
     *
     * It is saved as the reader's own view, since the order they dragged into
     * place is theirs and a view somebody shared with the list belongs to whoever
     * made it. A screen spanning spaces has no list or space of its own to hang a
     * view on, so there it is only this browser that remembers - which is enough,
     * because the order itself was written down on the tasks and all that was
     * missing was being told to open on it.
     */
    const keepManualOrder = async () => {
        const owner = listId
            ? { listId, spaceId: null }
            : context.spaceId
              ? { listId: null, spaceId: context.spaceId }
              : null;
        if (!owner) return;

        const view = {
            ...owner,
            name: ownView?.name ?? "My order",
            type: viewType,
            groupBy,
            sort: { field: "manual", direction: "asc" },
            filter,
            columns: ownView?.columns ?? [],
            showSubtasks: ownView?.showSubtasks ?? true,
            showClosed,
            shared: false
        };
        const result = ownView
            ? await runAction(() => actions.updateViewAction(ownView.id, view), setError)
            : await runAction(() => actions.createViewAction(view), setError);
        if (result?.error) setError(result.error);
    };

    /**
     * Keep the order the screen was showing, with the dragged task where it was
     * dropped, and hand the arrangement over to whoever made it.
     *
     * A view opens in the order the engine chose - most urgent first - and that
     * order is not written down anywhere, so a card dropped between two others
     * would be re-sorted away the moment it landed. Rather than refuse the drag,
     * the arrangement on screen becomes the manual one: every row keeps the place
     * it was in, the dragged task takes its new one, and the view says it is now
     * in manual order. Nothing jumps, and the next drag is an ordinary one.
     */
    const adoptOrder = async (
        task: TaskRow,
        position: { beforeId: string | null; afterId: string | null }
    ) => {
        // Order runs per list. A screen spanning several - Everything, a sprint -
        // is looking at that many separate sequences, so only the dragged task's
        // own list is written down and every other list keeps the order somebody
        // arranged there.
        const inList = rows.filter((row) => row.listId === task.listId);
        // The whole list, not just what passes the filter: re-spacing only the
        // visible rows would interleave them with the ones a filter is hiding.
        // Put through the arrangement the screen is holding, because that - and
        // not what the engine would sort to now - is the order somebody dropped
        // the card into.
        const arranged = arrange(
            core.sortTasks(inList.map(toFacts), sort, statusOrder).map((facts) => facts.id)
        );
        const taskIds = core.arrangeAround(arranged, task.id, position);

        const result = await runAction(() => actions.arrangeTasksAction({ taskIds }), setError);
        if (result?.error) {
            setError(result.error);
            return;
        }

        // The order keys the write just gave them, applied here as well. Without
        // this the view flips to manual while the rows still carry the positions
        // they were written down with months ago, and the whole board scrambles
        // for the length of a round trip before the refresh puts it right.
        const orders = core.rebalanceOrders(taskIds.length);
        setPending((current) => {
            const next = { ...current };
            taskIds.forEach((id, index) => {
                next[id] = { ...next[id], order: orders[index] };
            });
            return next;
        });

        // The screen only goes into manual order when the arrangement that was
        // just written down is the whole of it. Ordering a screen that spans
        // lists by a key that only means something inside one would scramble
        // every list on it except the one somebody just dragged in.
        if (rows.every((row) => row.listId === task.listId)) {
            setSort({ field: "manual", direction: "asc" });
            await keepManualOrder();
        }
    };

    const move: ViewProps["onMove"] = async ({ taskId, groupKey, position }) => {
        // Where the drop put it, on screen, now.
        //
        // The screen holds its arrangement so that ticking a checkbox does not
        // throw the row out from under the pointer, and a drag is the one thing
        // that must go straight through that: the reader has just said where the
        // row goes. Without this the row sprang back to where it was and stayed
        // there until a full page reload rebuilt the held order - the write had
        // landed, the screen was simply refusing to show it.
        //
        // Before the write rather than after, because this is what the reader
        // sees the instant they let go, and the round trip is not something they
        // should be watching.
        settle(core.arrangeAround(visibleFacts.map((facts) => facts.id), taskId, position));
        // The column of tasks with no status is keyed by an empty string. Sent
        // as-is it fails validation and the drop silently does nothing, so it
        // becomes an explicit null: "put this back to having no status".
        const statusId = groupBy === "status" ? groupKey || null : undefined;
        const target = context.statuses.find((status) => status.id === statusId);
        setPending((current) => ({
            ...current,
            [taskId]: target
                ? {
                      statusId: target.id,
                      statusName: target.name,
                      statusColor: target.color,
                      statusType: target.type
                  }
                : statusId === null
                  ? {
                        statusId: null,
                        statusName: "No status",
                        statusColor: "#64748b",
                        statusType: "open"
                    }
                  : {}
        }));
        const result = await runAction(
            () =>
                actions.moveTaskAction({
                    taskId,
                    statusId,
                    beforeId: position.beforeId,
                    afterId: position.afterId
                }),
            setError
        );
        if (result?.error) setError(result.error);
        // Dropped onto a task - the only drop that promised a place, since that
        // is where the line appears. Dropping into the space below a column is
        // "put it in this column" and leaves the order to the sort. Under a sort
        // that decides the order, a promised place only survives if the screen's
        // arrangement is written down with it, and only once the move itself
        // went through.
        else if (result && sort.field !== "manual" && position.placed) {
            const dragged = rowById.get(taskId);
            // A neighbour from another list is not a place: the two are ordered
            // against their own lists, so there is no gap between them to be put
            // in. Whichever side of the drop names one has to be in the same list
            // as what was dragged.
            const beside = [position.beforeId, position.afterId]
                .filter((id): id is string => id !== null)
                .map((id) => rowById.get(id));
            if (
                dragged &&
                beside.length > 0 &&
                beside.every((row) => row !== undefined && row.listId === dragged.listId)
            ) {
                await adoptOrder(dragged, position);
            }
        }
        refresh();
    };

    const quickCreate = async (groupKey: string, name: string) => {
        // The key says what it is rather than being read off the current view: a
        // calendar hands back "date:<iso>", every other view hands back the group
        // it was added to. Guessing from the view type puts a status id in the
        // due date the moment somebody uses the header button on a calendar.
        const dueDate = groupKey.startsWith("date:") ? groupKey.slice(5) : null;
        const statusId = !dueDate && groupBy === "status" && groupKey ? groupKey : null;

        const target = listId ?? defaultListId;
        if (!target) {
            // A screen spanning several lists has nowhere to put a typed-in name,
            // and the column it was typed into is a status belonging to whichever
            // space defined it first. So the dialog opens carrying what is known -
            // the name, and the day if that is what was clicked - and asks for the
            // list, rather than refusing what was just typed.
            setCreating({ name, dueDate });
            return;
        }

        const result = await runAction(
            () => actions.createTaskAction({ listId: target, name, statusId, dueDate }),
            setError
        );
        if (result?.error) setError(result.error);
        refresh();
    };

    // What "New task" opens on. A screen with no list of its own still has to be
    // able to make one - Everything is where a lot of people live - so it falls
    // back to the first list in reach and the dialog asks which one it goes in.
    const createTarget = listId ?? defaultListId ?? lists[0]?.id ?? null;

    /** Take a selection, and say so when it was more than one write may carry. */
    const hold = (next: ReadonlySet<string>) => {
        const { taken, dropped } = holdSelection(next);
        setSelection(taken);
        if (dropped > 0) {
            const left = dropped === 1 ? "one task was" : `${dropped} tasks were`;
            setError(`A selection holds ${taken.size} tasks at a time, so ${left} left out.`);
        }
    };

    /**
     * Selection, read the way a file manager reads it: ctrl-click puts one task
     * in or takes it out, shift-click takes everything between it and the last
     * one clicked on its own.
     *
     * `ordered` comes from the view rather than from here because a range means
     * what is between the two rows on screen, and the screen is a board read
     * down its columns, a table read down its rows, or a list with its subtasks
     * nested - three different sequences over the same tasks.
     */
    const select = (taskId: string, mode: SelectMode, ordered: readonly string[]) => {
        const from = anchor === null ? -1 : ordered.indexOf(anchor);
        const to = ordered.indexOf(taskId);
        if (mode === "range" && from !== -1 && to !== -1) {
            const span = ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
            hold(new Set([...selection, ...span]));
            return;
        }

        const next = new Set(selection);
        if (next.has(taskId)) next.delete(taskId);
        else next.add(taskId);
        hold(next);
        // A shift-click with nowhere to reach back to is the first click of the
        // range, so it becomes the anchor like any other.
        setAnchor(taskId);
    };

    const clearSelection = () => {
        setSelection(new Set());
        setAnchor(null);
    };

    // The selection as rows, narrowed to what is on screen: an id a filter has
    // since hidden is not something a bulk verb should quietly write to.
    const selected = useMemo(
        () => visible.filter((task) => selection.has(task.id)),
        [visible, selection]
    );

    /** Say so when a write reached fewer tasks than the selection it was handed. */
    const reportShortfall = (count: number | undefined, asked: number, verb: BulkVerb) => {
        const message = shortfallMessage(count, asked, verb);
        if (message) setError(message);
    };

    /**
     * A change from the context menu, applied to whatever it was acting on -
     * one task, or the whole selection.
     *
     * It always goes through the bulk write, including for a single task: the
     * verbs are the same ones either way, and two paths to them is two places
     * for the assignee toggle to disagree with itself.
     */
    const applyToTasks = async (targets: readonly TaskRow[], change: TaskBulkEdit) => {
        const taskIds = targets.map((task) => task.id);
        if (taskIds.length === 0) return;

        // A move and an archive decide which rows belong on this screen at all,
        // so they are left to the reload rather than painted on rows that are
        // about to leave.
        const leaves = change.archived !== undefined || change.listId !== undefined;
        if (!leaves) {
            setPending((current) => {
                const next = { ...current };
                for (const task of targets) {
                    next[task.id] = {
                        ...next[task.id],
                        ...bulkOverlay(task, change, withCreatedTags(directory.current))
                    };
                }
                return next;
            });
        }

        const written = change.addTagIds
            ? { ...change, addTagIds: await settleTagIds(change.addTagIds) }
            : change;
        const result = await runAction(
            () => actions.bulkUpdateAction({ taskIds, ...written }),
            setError
        );
        if (result?.error) setError(result.error);
        else reportShortfall(result?.count, taskIds.length, "Changed");
        if (leaves) clearSelection();
        refresh(taskIds);
    };

    /**
     * The screen's own keys: N starts a task, Escape drops the selection.
     *
     * They listen on the window so they work wherever the focus sits on the
     * board, and stand down whenever something else owns the keyboard - a field
     * being typed in, an open dialog, an open menu - which is the same rule the
     * file explorer follows and the reason a task named "New plan" can be typed
     * at all.
     *
     * Re-bound when what the handler reads changes rather than on every render,
     * which is the same thing while somebody is pressing keys and is not while
     * they are editing: a screen that swaps its window listener on each tick of
     * a checkbox is doing that work for nothing.
     */
    useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            if (keyboardIsBusy(event)) return;
            if (event.key === "Escape") {
                if (selection.size === 0) return;
                event.preventDefault();
                clearSelection();
                return;
            }
            // A modifier means the press belongs to the browser or to an editing
            // shortcut (Ctrl+N opens a window), never to this one.
            if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
            if (event.key.toLowerCase() !== "n" || !context.canEdit || !createTarget) return;
            event.preventDefault();
            setCreating({ name: "", dueDate: null });
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
        // `clearSelection` only ever calls setState, which React keeps stable, so
        // what the handler actually reads is the three below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selection.size, context.canEdit, createTarget]);

    /**
     * Whether this screen may change the columns at all.
     *
     * A status belongs to a space, so a screen that spans them all has nowhere
     * to put one and no single set to reorder - the same reason a tag cannot be
     * created there. The rest is offered only to whoever may change a space's
     * statuses; the actions enforce that too, this is what keeps the affordance
     * from appearing for somebody who would only be refused.
     */
    const canManageColumns = context.canModerate && context.spaceId !== "";

    const viewProps: ViewProps = {
        rows: visible,
        groups,
        context,
        canEdit: context.canEdit,
        // A search is ranked by how well each row matched, so a position among
        // those rows is not one anybody could keep.
        orderable: needle === "",
        selection,
        selected,
        lists,
        onOpen: setOpenTaskId,
        onSelect: select,
        onMove: move,
        onQuickCreate: quickCreate,
        onEdit: editTask,
        onApply: applyToTasks,
        onDuplicate: duplicateTask,
        onDelete: setDeleting,
        // A screen with no list of its own is showing work from several, so each
        // row has to name the one it came from.
        showLocation: listId === null,
        // A tag belongs to a space. A screen that spans them all has none of its
        // own, so there is nowhere to put a new one; the picker then offers
        // finding rather than creating, instead of refusing a typed name.
        onCreateTag: context.spaceId ? tagBook.create : undefined,
        groupBy,
        onCreateStatus: canManageColumns
            ? async (name, type, color) => {
                  const created = await runAction(
                      () => actions.createStatusAction(context.spaceId, { name, type, color }),
                      setError
                  );
                  if (created?.error) setError(created.error);
                  refresh();
                  return created?.id ?? null;
              }
            : undefined,
        onUpdateStatus: canManageColumns
            ? async (statusId, name, type, color) => {
                  const saved = await runAction(
                      () =>
                          actions.updateStatusAction(context.spaceId, statusId, {
                              name,
                              type,
                              color
                          }),
                      setError
                  );
                  if (saved?.error) setError(saved.error);
                  refresh();
                  return saved !== null && !saved.error;
              }
            : undefined,
        onDeleteStatus: canManageColumns
            ? async (statusId, replacementId) => {
                  const removed = await runAction(
                      () => actions.deleteStatusAction(context.spaceId, statusId, replacementId),
                      setError
                  );
                  if (removed?.error) setError(removed.error);
                  refresh();
                  return removed !== null && !removed.error;
              }
            : undefined,
        onReorderStatuses: canManageColumns
            ? async (orderedIds) => {
                  const moved = await runAction(
                      () => actions.reorderStatusesAction(context.spaceId, orderedIds),
                      setError
                  );
                  if (moved?.error) setError(moved.error);
                  refresh();
                  return moved !== null && !moved.error;
              }
            : undefined
    };

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <header className="flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                    <h1 title={title} className="truncate text-[17px] font-semibold tracking-tight">
                        {title}
                    </h1>
                    {subtitle && (
                        <p title={subtitle} className="truncate text-sm text-muted-foreground">
                            {subtitle}
                        </p>
                    )}
                </div>
                <span className="flex-1" />
                {context.canEdit && createTarget && (
                    <Button
                        size="sm"
                        title="New task (N)"
                        onClick={() => setCreating({ name: "", dueDate: null })}
                    >
                        <Plus className="size-4" /> New task
                    </Button>
                )}
            </header>

            <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-md border border-border p-0.5">
                    {core.TASK_VIEW_TYPES.map((type) => {
                        const Icon = VIEW_ICONS[type];
                        return (
                            <button
                                key={type}
                                type="button"
                                onClick={() => setViewType(type)}
                                aria-pressed={viewType === type}
                                title={core.TASK_VIEW_LABELS[type]}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
                                    viewType === type
                                        ? "bg-muted font-medium text-foreground"
                                        : "text-muted-foreground hover:text-foreground"
                                )}
                            >
                                <Icon className="size-3.5" />
                                <span className="hidden sm:inline">
                                    {core.TASK_VIEW_LABELS[type]}
                                </span>
                            </button>
                        );
                    })}
                </div>

                {(viewType === "list" || viewType === "board") && (
                    <Select
                        value={groupBy}
                        onValueChange={(value) => setGroupBy(value as core.TaskGroupField)}
                        options={core.TASK_GROUP_FIELDS.map((field) => ({
                            value: field,
                            label: `Group: ${core.TASK_GROUP_LABELS[field]}`
                        }))}
                        aria-label="Group by"
                        className="h-8 w-44 text-xs"
                    />
                )}

                <Select
                    value={sort.field}
                    onValueChange={(field) =>
                        setSort({ ...sort, field: field as core.TaskSortField })
                    }
                    options={core.TASK_SORT_FIELDS.map((field) => ({
                        value: field,
                        label: `Sort: ${core.TASK_SORT_LABELS[field]}`
                    }))}
                    aria-label="Sort by"
                    className="h-8 w-44 text-xs"
                />
                <button
                    type="button"
                    onClick={() =>
                        setSort({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })
                    }
                    className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    {sort.direction === "asc" ? "Ascending" : "Descending"}
                </button>

                {/* Not offered while grouping by status, where closed work is in
                    a column of its own and the box would change nothing. A
                    control that does nothing is read as a broken one. */}
                {groupBy === "status" ? null : (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <input
                            type="checkbox"
                            checked={showClosed}
                            onChange={(event) => setShowClosed(event.target.checked)}
                        />
                        Show closed
                    </label>
                )}

                <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search tasks"
                        aria-label="Search tasks"
                        className="h-8 w-44 rounded-md border border-border bg-field pl-7 pr-2 text-xs hover:border-border-strong focus:border-border-strong"
                    />
                </div>

                <FilterBar
                    filter={filter}
                    onChange={setFilter}
                    context={{
                        statuses: context.statuses,
                        tags: context.tags,
                        people: context.people,
                        fields: context.fields,
                        lists
                    }}
                />

                <span className="text-xs text-muted-foreground">
                    {visible.length} of {rows.length}
                </span>
            </div>

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error}
                </p>
            )}

            {selected.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
                    <span className="text-sm font-medium">{selected.length} selected</span>
                    {/* The same verbs the right-click menu applies, through the
                        same call: two ways in, one answer to what each one does -
                        including being absent for somebody who may read this work
                        and not change it. Selecting is still theirs: it is how a
                        few tasks are held together to be read. */}
                    {context.canEdit && (
                        <>
                            <StatusPicker
                                statuses={context.statuses}
                                value={null}
                                onChange={(statusId) => void applyToTasks(selected, { statusId })}
                            />
                            <AssigneePicker
                                people={context.people}
                                selected={[]}
                                onChange={(ids) =>
                                    void applyToTasks(selected, { addAssigneeIds: ids })
                                }
                            />
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void applyToTasks(selected, { archived: true })}
                            >
                                Archive
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setDeleting(selected)}>
                                Delete
                            </Button>
                        </>
                    )}
                    <span className="flex-1" />
                    <button
                        type="button"
                        aria-label="Clear selection"
                        title="Clear selection (Esc)"
                        onClick={clearSelection}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <X className="size-4" />
                    </button>
                </div>
            )}

            {viewType === "board" && <BoardView {...viewProps} />}
            {viewType === "list" && <ListView {...viewProps} />}
            {viewType === "table" && <TableView {...viewProps} />}
            {viewType === "calendar" && <CalendarView {...viewProps} />}
            {viewType === "gantt" && <GanttView {...viewProps} />}

            {rows.length === 0 && (
                <EmptyState
                    title="Nothing here yet."
                    description="Add the first task and it appears on every view of this list."
                />
            )}

            <p className="text-[11px] text-muted-foreground">
                Ctrl-click (or Cmd-click) selects a task without opening it, shift-click takes
                everything between, Esc clears the selection, and N starts a new task.
            </p>

            {createTarget && (
                <TaskCreateDialog
                    open={creating !== null}
                    spaceId={context.spaceId}
                    statuses={context.statuses}
                    tags={context.tags}
                    people={context.people}
                    lists={lists.length > 0 ? lists : [{ id: createTarget, name: title }]}
                    defaultListId={createTarget}
                    defaultName={creating?.name ?? ""}
                    defaultDueDate={creating?.dueDate ?? null}
                    // The statuses on a screen that spans spaces are every
                    // space's, so starting on one of them would be starting on
                    // another space's word. Left unset, the list it goes into
                    // decides.
                    defaultStatusId={(listId ?? defaultListId) ? undefined : null}
                    onClose={() => setCreating(null)}
                    onCreated={(id) => {
                        refresh();
                        // Straight into the new task: whoever just described it
                        // is the person most likely to keep working on it.
                        setOpenTaskId(id);
                    }}
                />
            )}

            <TaskPanel
                taskId={openTaskId}
                context={context}
                onClose={() => setOpenTaskId(null)}
                onChanged={refresh}
            />

            <ConfirmDeleteDialog
                open={deleting.length > 0}
                onOpenChange={(open) => (open ? undefined : setDeleting([]))}
                // One task is named; a selection is counted, since a dialog
                // listing forty names says less than the number does.
                name={
                    deleting.length === 1 ? (deleting[0]?.name ?? "") : `${deleting.length} tasks`
                }
                kind={deleting.length === 1 ? "task" : "tasks"}
                // One row of many is asked plainly, the way every other single
                // delete is. A selection is not one row: it takes every subtask,
                // comment and hour logged against forty at once, off one click on
                // a screen where the click before it was a shift-click.
                requireTyping={deleting.length > 1}
                description="Comments, checklists and tracked time go with them. Archiving keeps all of that and takes them off the board."
                confirmLabel={
                    deleting.length === 1 ? "Delete task" : `Delete ${deleting.length} tasks`
                }
                onConfirm={async () => {
                    const taskIds = deleting.map((task) => task.id);
                    if (taskIds.length === 0) return;
                    const result = await runAction(
                        () => actions.deleteTasksAction({ taskIds }),
                        setError
                    );
                    if (result?.error) setError(result.error);
                    else reportShortfall(result?.count, taskIds.length, "Deleted");
                    setDeleting([]);
                    clearSelection();
                    refresh();
                }}
            />
        </div>
    );
}
