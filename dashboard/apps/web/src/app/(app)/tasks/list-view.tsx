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
import { ListView, TableView } from "./views/rows";
import { TaskCreateDialog } from "./task-create-dialog";
import { useMemo, useState, useTransition } from "react";
import { AssigneePicker, StatusPicker } from "./pickers";
import type { TaskEdit, ViewProps } from "./views/shared";
import type { SavedView } from "@/lib/tasks/view-service";
import { CalendarView, GanttView } from "./views/schedule";
import { Button, ConfirmDeleteDialog, Select, cn } from "@polaris/ui";
import { toFacts, type SpaceContext, type TaskRow } from "@/lib/tasks/facts";
import { CalendarDays, GanttChart, LayoutList, Plus, Rows3, Search, Table2, X } from "lucide-react";

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
    readonly lists: readonly { id: string; name: string }[];
    /** Where a quick-add goes when the screen spans several lists. */
    readonly defaultListId: string | null;
    /** Opened straight away, for a deep link to one task. */
    readonly initialTaskId?: string | null;
}

export function ListScreen({
    listId,
    title,
    subtitle,
    tasks,
    savedViews,
    context,
    lists,
    defaultListId,
    initialTaskId = null
}: ListScreenProps) {
    const router = useRouter();
    const [, startRefresh] = useTransition();

    const initial = savedViews[0];
    const [viewType, setViewType] = useState<core.TaskViewType>(initial?.type ?? "board");
    const [groupBy, setGroupBy] = useState<core.TaskGroupField>(initial?.groupBy ?? "status");
    const [sort, setSort] = useState<core.TaskSort>(initial?.sort ?? { field: "manual", direction: "asc" });
    const [filter, setFilter] = useState<core.TaskFilter>(initial?.filter ?? core.EMPTY_FILTER);
    const [showClosed, setShowClosed] = useState(initial?.showClosed ?? false);
    const [search, setSearch] = useState("");
    const [openTaskId, setOpenTaskId] = useState<string | null>(initialTaskId);
    const [creating, setCreating] = useState(false);
    const [deleting, setDeleting] = useState<TaskRow | null>(null);
    const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
    const [error, setError] = useState("");

    // Optimistic overlay: what a drag or a tick changed before the server said so.
    const [pending, setPending] = useState<Record<string, Partial<TaskRow>>>({});

    const rows = useMemo(() => tasks.map((task) => ({ ...task, ...pending[task.id] })), [tasks, pending]);

    const refresh = () =>
        startRefresh(() => {
            setPending({});
            router.refresh();
        });

    const statusOrder = useMemo(
        () => new Map(context.statuses.map((status, index) => [status.id, index])),
        [context.statuses]
    );

    // The engine reasons in facts (real Dates); the screen renders rows (ISO
    // strings). Rather than convert back and forth, the facts are derived once
    // and the row is looked back up by id wherever one is drawn.
    const rowById = useMemo(() => new Map(rows.map((task) => [task.id, task])), [rows]);

    /**
     * Search is fuzzy, because the way people look for a task is by half
     * remembering it. A substring match only finds "user agent" if that is what
     * somebody typed, and misses it for "useragent", "UA blocked" or a
     * transposed letter - which is exactly when they are searching in the first
     * place. Reference and tags are searchable too, at lower weight, so quoting
     * "ENG-42" still lands on it.
     */
    const index = useMemo(
        () =>
            new Fuse(rows, {
                keys: [
                    { name: "name", weight: 3 },
                    { name: "reference", weight: 2 },
                    { name: "description", weight: 1 },
                    { name: "tags.name", weight: 1 }
                ],
                threshold: 0.4,
                ignoreLocation: true,
                minMatchCharLength: 2
            }),
        [rows]
    );

    const visibleFacts = useMemo(() => {
        const now = new Date();
        const needle = search.trim();
        const matched = needle ? index.search(needle).map((hit) => hit.item) : rows;
        const working = matched
            .filter((task) => showClosed || task.statusType !== "closed")
            .map(toFacts)
            .filter((facts) => core.matchesFilter(facts, filter, now));
        // A search is already ranked by how well each row matched; re-sorting it
        // by due date would throw that away.
        return needle ? working : core.sortTasks(working, sort, statusOrder);
    }, [rows, index, filter, showClosed, search, sort, statusOrder]);

    const visible = useMemo(
        () => visibleFacts.map((facts) => rowById.get(facts.id)).filter((task): task is TaskRow => task !== undefined),
        [visibleFacts, rowById]
    );

    const groups = useMemo<ViewProps["groups"]>(
        () =>
            core
                .groupTasks(visibleFacts, groupBy, {
                    statuses: context.statuses,
                    people: context.people.map((person) => ({ id: person.id, name: person.name })),
                    tags: context.tags,
                    lists
                })
                .map((group) => ({
                    ...group,
                    tasks: group.tasks
                        .map((facts) => rowById.get(facts.id))
                        .filter((task): task is TaskRow => task !== undefined)
                })),
        [visibleFacts, rowById, groupBy, context.statuses, context.people, context.tags, lists]
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
        // The overlay is written into, so it is the mutable shape of a row.
        const optimistic: { -readonly [Key in keyof TaskRow]?: TaskRow[Key] } = {};
        if (change.statusId !== undefined) {
            const status = context.statuses.find((entry) => entry.id === change.statusId);
            if (status) {
                optimistic.statusId = status.id;
                optimistic.statusName = status.name;
                optimistic.statusColor = status.color;
                optimistic.statusType = status.type;
            }
        }
        if (change.priority !== undefined) optimistic.priority = change.priority;
        if (change.dueDate !== undefined) optimistic.dueDate = change.dueDate;
        if (change.assigneeIds !== undefined) {
            optimistic.assignees = context.people.filter((person) => change.assigneeIds?.includes(person.id));
        }
        if (change.tagIds !== undefined) {
            optimistic.tags = context.tags.filter((tag) => change.tagIds?.includes(tag.id));
        }
        setPending((current) => ({ ...current, [task.id]: { ...current[task.id], ...optimistic } }));

        const result = await runAction(() => actions.updateTaskAction({ taskId: task.id, ...change }), setError);
        if (result?.error) setError(result.error);
        refresh();
    };

    const duplicateTask = async (task: TaskRow) => {
        const result = await runAction(() => actions.duplicateTaskAction(task.id), setError);
        if (result?.error) setError(result.error);
        refresh();
    };

    const move: ViewProps["onMove"] = async ({ taskId, groupKey, position }) => {
        // The column of tasks with no status is keyed by an empty string. Sent
        // as-is it fails validation and the drop silently does nothing, so it
        // becomes an explicit null: "put this back to having no status".
        const statusId = groupBy === "status" ? (groupKey || null) : undefined;
        const target = context.statuses.find((status) => status.id === statusId);
        setPending((current) => ({
            ...current,
            [taskId]: target
                ? { statusId: target.id, statusName: target.name, statusColor: target.color, statusType: target.type }
                : statusId === null
                  ? { statusId: null, statusName: "No status", statusColor: "#64748b", statusType: "open" }
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
        refresh();
    };

    const quickCreate = async (groupKey: string, name: string) => {
        const target = listId ?? defaultListId;
        if (!target) {
            setError("Pick a list to add this to.");
            return;
        }
        // The key says what it is rather than being read off the current view: a
        // calendar hands back "date:<iso>", every other view hands back the group
        // it was added to. Guessing from the view type puts a status id in the
        // due date the moment somebody uses the header button on a calendar.
        const dueDate = groupKey.startsWith("date:") ? groupKey.slice(5) : null;
        const statusId = !dueDate && groupBy === "status" && groupKey ? groupKey : null;

        const result = await runAction(
            () => actions.createTaskAction({ listId: target, name, statusId, dueDate }),
            setError
        );
        if (result?.error) setError(result.error);
        refresh();
    };

    const toggleSelect = (taskId: string) => {
        const next = new Set(selection);
        if (next.has(taskId)) next.delete(taskId);
        else next.add(taskId);
        setSelection(next);
    };

    const viewProps: ViewProps = {
        rows: visible,
        groups,
        context,
        canEdit: context.canEdit,
        selection,
        onOpen: setOpenTaskId,
        onSelect: toggleSelect,
        onMove: move,
        onQuickCreate: quickCreate,
        onEdit: editTask,
        onDuplicate: duplicateTask,
        onDelete: setDeleting,
        // A screen with no list of its own is showing work from several, so each
        // row has to name the one it came from.
        showLocation: listId === null,
        // A tag belongs to a space. A screen that spans them all has none of its
        // own, so there is nowhere to put a new one; the picker then offers
        // finding rather than creating, instead of refusing a typed name.
        onCreateTag: context.spaceId
            ? async (name, color) => {
                  const created = await runAction(
                      () => actions.createTagAction(context.spaceId, name, color),
                      setError
                  );
                  if (created?.id) refresh();
                  return created?.id ?? null;
              }
            : undefined,
        groupBy,
        // A new board column is a new status for the whole space, so it is
        // offered only to whoever may change the space's statuses. The action
        // enforces the same thing; this is what keeps the button from appearing
        // for somebody who would only be refused.
        onCreateGroup: context.canModerate
            ? async (name, type, color) => {
                  const result = await runAction(
                      () => actions.createStatusAction(context.spaceId, { name, type, color }),
                      setError
                  );
                  if (result?.error) setError(result.error);
                  refresh();
              }
            : undefined
    };

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <header className="flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                    <h1 className="truncate text-xl font-semibold">{title}</h1>
                    {subtitle && <p className="truncate text-sm text-muted-foreground">{subtitle}</p>}
                </div>
                <span className="flex-1" />
                {context.canEdit && (listId ?? defaultListId) && (
                    <Button size="sm" onClick={() => setCreating(true)}>
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
                                <span className="hidden sm:inline">{core.TASK_VIEW_LABELS[type]}</span>
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
                    onValueChange={(field) => setSort({ ...sort, field: field as core.TaskSortField })}
                    options={core.TASK_SORT_FIELDS.map((field) => ({
                        value: field,
                        label: `Sort: ${core.TASK_SORT_LABELS[field]}`
                    }))}
                    aria-label="Sort by"
                    className="h-8 w-44 text-xs"
                />
                <button
                    type="button"
                    onClick={() => setSort({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })}
                    className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    {sort.direction === "asc" ? "Ascending" : "Descending"}
                </button>

                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />
                    Show closed
                </label>

                <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search tasks"
                        aria-label="Search tasks"
                        className="h-8 w-44 rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-primary"
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
                <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                </p>
            )}

            {selection.size > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
                    <span className="text-sm font-medium">{selection.size} selected</span>
                    <StatusPicker
                        statuses={context.statuses}
                        value={null}
                        onChange={async (statusId) => {
                            await runAction(
                                () => actions.bulkUpdateAction({ taskIds: [...selection], statusId }),
                                setError
                            );
                            setSelection(new Set());
                            refresh();
                        }}
                    />
                    <AssigneePicker
                        people={context.people}
                        selected={[]}
                        onChange={async (ids) => {
                            await runAction(
                                () => actions.bulkUpdateAction({ taskIds: [...selection], addAssigneeIds: ids }),
                                setError
                            );
                            setSelection(new Set());
                            refresh();
                        }}
                    />
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                            await runAction(
                                () => actions.bulkUpdateAction({ taskIds: [...selection], archived: true }),
                                setError
                            );
                            setSelection(new Set());
                            refresh();
                        }}
                    >
                        Archive
                    </Button>
                    <span className="flex-1" />
                    <button
                        type="button"
                        aria-label="Clear selection"
                        title="Clear selection"
                        onClick={() => setSelection(new Set())}
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
                <p className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
                    Nothing here yet. Add the first task and it appears on every view of this list.
                </p>
            )}

            <p className="text-[11px] text-muted-foreground">
                Ctrl-click (or Cmd-click) a task to select it without opening it.
            </p>

            {(listId ?? defaultListId) && (
                <TaskCreateDialog
                    open={creating}
                    spaceId={context.spaceId}
                    statuses={context.statuses}
                    tags={context.tags}
                    people={context.people}
                    lists={lists.length > 0 ? lists : [{ id: (listId ?? defaultListId) as string, name: title }]}
                    defaultListId={(listId ?? defaultListId) as string}
                    onClose={() => setCreating(false)}
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
                open={deleting !== null}
                onOpenChange={(open) => (open ? undefined : setDeleting(null))}
                name={deleting?.name ?? ""}
                kind="task"
                requireTyping={false}
                description="Comments, checklists and tracked time go with it. Archiving keeps all of that and takes it off the board."
                confirmLabel="Delete task"
                onConfirm={async () => {
                    if (!deleting) return;
                    const result = await runAction(() => actions.deleteTaskAction(deleting.id), setError);
                    if (result?.error) setError(result.error);
                    setDeleting(null);
                    refresh();
                }}
            />
        </div>
    );
}
