"use client";

/**
 * The two row-shaped views: List and Table.
 *
 * They share a renderer because they are the same thing seen at two densities.
 * List is grouped and shows the properties people scan for; Table is flat, adds
 * the custom-field columns, and scrolls sideways rather than wrapping - a table
 * that reflows is a table you cannot compare rows in.
 */

import * as core from "@polaris/core";
import { useEffect, useMemo, useState } from "react";
import { toFacts } from "@/lib/tasks/facts";
import { useRowCursor } from "./row-cursor";
import {
    Checkbox,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
    EmptyState
} from "@polaris/ui";
import { CustomFieldValue } from "../custom-fields";
import { PriorityMark } from "@/components/priority-mark";
import { columnStatusIds, reorderColumns } from "./board";
import { useDisplayFormat } from "@/components/display-format";
import { Check, ChevronDown, ChevronRight, Columns3, Plus } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { dropEdge, neighbours, type DropEdge } from "../drop-edge";
import { clickMode, type SelectMode, type ViewProps } from "./shared";
import {
    commandsFor,
    TaskControls,
    TaskMenu,
    TaskStatusMarker,
    type TaskCommands
} from "./task-actions";
import {
    AssigneePicker,
    AvatarStack,
    BlockedMarker,
    DueBadge,
    DuePicker,
    PriorityPicker,
    StatusDot,
    StatusPicker,
    TagChip,
    TaskLocation
} from "../pickers";

/** One task as a row. Shared by both views so a task reads the same in either. */
function TaskLine({
    commands,
    depth,
    selected,
    selecting = false,
    cursor,
    showStatus,
    showLocation,
    positioned = true,
    onSelect,
    onPoint,
    onRegister,
    onDragStart,
    onDropAt
}: {
    commands: TaskCommands;
    depth: number;
    selected: boolean;
    /** Whether anything on the screen is selected, which keeps every row's box
     *  showing rather than only the one under the pointer. */
    selecting?: boolean;
    /** Whether the keyboard cursor is on this row. Drawn as a rail down the left
     *  edge rather than as a background, so it stays legible on a row that is
     *  also selected - the two mean different things and have to be tellable
     *  apart. */
    cursor: boolean;
    /** Whether the row says what its status is. False when the list is already
     *  grouped by status, where every row in a group would repeat the heading
     *  above it - the widest column on the screen saying nothing. */
    showStatus: boolean;
    showLocation?: boolean;
    /** Whether dropping here would actually put the row here. False while a
     *  search is on, where the rows are ranked by how well they matched. */
    positioned?: boolean;
    onSelect: (mode: SelectMode) => void;
    /** A press anywhere on the row moves the cursor here, so the keyboard picks
     *  up from wherever the reader last looked rather than from the top. */
    onPoint?: () => void;
    onRegister?: (element: HTMLElement | null) => void;
    onDragStart?: () => void;
    /** Dropped on this row, on the half of it the pointer was in. */
    onDropAt?: (edge: DropEdge) => void;
}) {
    const format = useDisplayFormat();
    const t = useTranslations("tasksViews");
    const [over, setOver] = useState<DropEdge | null>(null);
    const { task, canEdit, onOpen } = commands;

    return (
        <TaskMenu commands={commands}>
            <li
                ref={onRegister}
                onMouseDown={onPoint}
                draggable={canEdit && onDragStart !== undefined}
                onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", task.id);
                    onDragStart?.();
                }}
                onDragOver={(event) => {
                    if (!onDropAt) return;
                    event.preventDefault();
                    setOver(dropEdge(event.clientY, event.currentTarget));
                }}
                onDragLeave={() => setOver(null)}
                onDrop={(event) => {
                    if (!onDropAt) return;
                    event.preventDefault();
                    // The group underneath is where a drop that named no row
                    // lands - the end of it. This one named a row, so the group
                    // must not also hear it and overrule the place with its own.
                    event.stopPropagation();
                    const edge = over ?? dropEdge(event.clientY, event.currentTarget);
                    setOver(null);
                    onDropAt(edge);
                }}
                className={cn(
                    "group relative flex items-center gap-2 border-b border-border px-2 py-1.5 transition-colors duration-fast hover:bg-card-hover",
                    selected && "bg-primary/5",
                    cursor &&
                        "bg-card-hover before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
                )}
                style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
            >
                {/* The line the drop would land on, drawn on the edge it would
                actually use rather than always above: a row dragged downwards
                goes under the one it was released over. */}
                {over && positioned && (
                    <span
                        aria-hidden
                        className={cn(
                            "pointer-events-none absolute left-0 z-10 h-0.5 w-full rounded bg-primary",
                            over === "before" ? "top-0" : "bottom-0"
                        )}
                    />
                )}
                {/* Selecting without a modifier key, which is the only way there
                    is on a touch screen. Out of the way on a desktop until the
                    row is pointed at, and kept once anything is selected, so a
                    selection being built can be seen and added to. */}
                <span
                    className={cn(
                        "flex shrink-0 items-center transition-opacity duration-fast focus-within:opacity-100 md:group-hover:opacity-100",
                        !selecting && "md:opacity-0"
                    )}
                >
                    <Checkbox
                        checked={selected}
                        aria-label={t("table.selectRow", { name: task.name })}
                        onChange={() => undefined}
                        onClick={(event) => onSelect(event.shiftKey ? "range" : "toggle")}
                    />
                </span>
                <TaskStatusMarker commands={commands} />
                <div className="flex min-w-0 flex-1 flex-col">
                    <button
                        type="button"
                        // A shift-click would otherwise drag a text selection across
                        // half the screen on its way to selecting the rows.
                        onMouseDown={(event) =>
                            event.shiftKey ? event.preventDefault() : undefined
                        }
                        onClick={(event) => {
                            const mode = clickMode(event);
                            if (mode) onSelect(mode);
                            else onOpen();
                        }}
                        className="flex min-w-0 items-center gap-2 text-left"
                    >
                        {/* Priority first, because the list is sorted by it out of
                        the box and a list ordered by something it never shows is
                        a list nobody can check. Nothing is drawn for a task with
                        none, so it costs no width in the common case. */}
                        <PriorityMark priority={task.priority} />
                        <span className="hidden font-mono text-[0.6875rem] text-muted-foreground sm:inline">
                            {task.reference}
                        </span>
                        <span
                            title={task.name}
                            className={cn(
                                "truncate text-sm",
                                core.isFinishedStatus(task.statusType) && "text-muted-foreground"
                            )}
                        >
                            {task.name}
                        </span>
                        <BlockedMarker task={task} format={format.date} />
                        {task.tags.slice(0, 2).map((tag) => (
                            <TagChip key={tag.id} tag={tag} />
                        ))}
                    </button>
                    {showLocation && <TaskLocation task={task} />}
                </div>

                {showStatus && (
                    <span className="hidden items-center gap-1 text-[0.6875rem] text-muted-foreground md:flex">
                        <StatusDot color={task.statusColor} />
                        {task.statusName}
                    </span>
                )}
                <span className="hidden w-24 justify-end md:flex">
                    <DueBadge
                        dueDate={task.dueDate}
                        statusType={task.statusType}
                        timed={task.timed}
                        format={format.date}
                    />
                </span>
                <AvatarStack people={task.assignees} size={20} />
                {/* The editable versions of what the row just showed. They sit at the
                end so the row still reads left to right, and stay out of the way
                until somebody is actually pointing at this task. */}
                <span
                    className={cn(
                        "flex shrink-0 items-center transition-opacity focus-within:opacity-100 md:group-hover:opacity-100",
                        canEdit ? "md:opacity-0" : "hidden"
                    )}
                >
                    <TaskControls commands={commands} />
                </span>
            </li>
        </TaskMenu>
    );
}

export function ListView(props: ViewProps) {
    const { groups, canEdit, context, groupBy, selection, onOpen, onSelect, onMove, onQuickCreate, orderable } =
        props;
    const t = useTranslations("tasksViews");
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const [dragging, setDragging] = useState<string | null>(null);
    const [addingTo, setAddingTo] = useState<string | null>(null);
    const [draft, setDraft] = useState("");

    /**
     * Arranging the sections, which the board has always allowed and this did
     * not.
     *
     * They are the same sections. A board draws them left to right and a list
     * draws them top to bottom, and somebody who has put their columns in the
     * order their team works in should not find that order thrown away by
     * switching how the same work is drawn. So the heading is the handle, the
     * same way the column heading is, and it writes the same order to the same
     * place - it belongs to the space, so everybody on it opens in it.
     *
     * Only where the sections stand for something the space owns. Grouped by
     * assignee or by priority they are slices of the data rather than columns,
     * and there is nothing to write down.
     */
    const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
    const [groupOver, setGroupOver] = useState<string | null>(null);
    /** The order a drop asked for, held while the write is in flight so the
     *  sections do not spring back for the length of a round trip. */
    const [pendingOrder, setPendingOrder] = useState<readonly string[] | null>(null);

    const columns = useMemo(() => core.statusColumns(context.statuses), [context.statuses]);
    const byStatus = (groupBy ?? "status") === "status";
    const canOrderGroups = byStatus && props.onReorderStatuses !== undefined && groups.length > 1;

    /** The sections in the order they are drawn: what the space says, with a
     *  drop that has not landed yet applied over it. */
    const shown = useMemo(() => {
        if (!pendingOrder) return groups;
        const byKey = new Map(groups.map((group) => [group.key, group]));
        const moved = pendingOrder
            .map((key) => byKey.get(key))
            .filter((group): group is (typeof groups)[number] => group !== undefined);
        // Anything the held order does not name - the pile with no status, a
        // section that arrived while the write was in flight - keeps its place at
        // the end rather than disappearing.
        const named = new Set(pendingOrder);
        return [...moved, ...groups.filter((group) => !named.has(group.key))];
    }, [groups, pendingOrder]);

    const dropGroup = async (targetKey: string) => {
        const dragged = draggingGroup;
        setDraggingGroup(null);
        setGroupOver(null);
        if (!dragged || !props.onReorderStatuses || !targetKey || dragged === targetKey) return;
        const order = reorderColumns(shown.map((group) => group.key), dragged, targetKey);
        setPendingOrder(order);
        // A section can stand for more than one status - two statuses sharing a
        // name are read as one - so the order written down is every status
        // behind every section, in the order the sections now sit in.
        await props.onReorderStatuses(order.flatMap((key) => columnStatusIds(columns, key)));
    };

    const toggleGroup = (key: string) => {
        const next = new Set(collapsed);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setCollapsed(next);
    };

    /**
     * The rows as the screen is drawing them - every open group in order, each
     * nested the way it renders - which is what a shift-click reaches across. A
     * collapsed group is not on screen, so a range never quietly picks up work
     * nobody can see.
     */
    const rendered = useMemo(
        () =>
            groups
                .filter((group) => !collapsed.has(group.key))
                .flatMap((group) =>
                    core
                        .flattenTree(core.buildTaskTree(group.tasks.map(toFacts)))
                        .map((node) => node.task.id)
                ),
        [groups, collapsed]
    );

    const cursor = useRowCursor(rendered, { onOpen, onSelect });

    return (
        <div className="flex flex-col gap-4">
            {shown.map((group) => {
                const isCollapsed = collapsed.has(group.key);
                // Nest subtasks under the parent they belong to, when both are in
                // this group. The engine works in facts, so the rows are mapped
                // in and looked back up by id when they are drawn.
                const byId = new Map(group.tasks.map((task) => [task.id, task]));
                const rows = core.flattenTree(core.buildTaskTree(group.tasks.map(toFacts)));

                // The pile of work with no status is not a section of the space:
                // there is nothing there to move.
                const movable = canOrderGroups && group.key !== "";

                return (
                    <section key={group.key} className="rounded-lg border border-border">
                        {/* Sticky, because a long group scrolls past its own
                            heading and "which status am I looking at" is the one
                            question the heading exists to answer. */}
                        <header
                            draggable={movable}
                            onDragStart={(event) => {
                                if (!movable) return;
                                // Its own kind, so a section being moved is never
                                // mistaken for a card being moved into it.
                                event.dataTransfer.setData("text/x-polaris-group", group.key);
                                event.dataTransfer.effectAllowed = "move";
                                setDraggingGroup(group.key);
                            }}
                            onDragEnd={() => {
                                setDraggingGroup(null);
                                setGroupOver(null);
                            }}
                            onDragOver={(event) => {
                                if (!draggingGroup || draggingGroup === group.key) return;
                                event.preventDefault();
                                event.stopPropagation();
                                setGroupOver(group.key);
                            }}
                            onDragLeave={() => setGroupOver((at) => (at === group.key ? null : at))}
                            onDrop={(event) => {
                                if (!draggingGroup) return;
                                event.preventDefault();
                                event.stopPropagation();
                                void dropGroup(group.key);
                            }}
                            className={cn(
                                "sticky top-0 z-10 flex items-center gap-2 rounded-t-lg border-b border-border bg-surface px-3 py-2",
                                movable && "cursor-grab active:cursor-grabbing",
                                draggingGroup === group.key && "opacity-50",
                                groupOver === group.key && "ring-2 ring-inset ring-primary"
                            )}
                        >
                            <button
                                type="button"
                                onClick={() => toggleGroup(group.key)}
                                aria-label={
                                    isCollapsed
                                        ? t("list.expand", { name: group.label })
                                        : t("list.collapse", { name: group.label })
                                }
                                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                            >
                                {isCollapsed ? (
                                    <ChevronRight className="size-4" />
                                ) : (
                                    <ChevronDown className="size-4" />
                                )}
                            </button>
                            {group.color && <StatusDot color={group.color} />}
                            <h3 className="min-w-0 truncate text-sm font-medium" title={group.label}>
                                {group.label}
                            </h3>
                            <span className="rounded bg-background px-1.5 text-[0.6875rem] text-muted-foreground">
                                {group.tasks.length}
                            </span>
                            <span className="flex-1" />
                            {canEdit && (
                                <button
                                    type="button"
                                    aria-label={t("list.addTo", { name: group.label })}
                                    title={t("empty.add")}
                                    onClick={() => {
                                        setAddingTo(group.key);
                                        setDraft("");
                                    }}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                                >
                                    <Plus className="size-3.5" />
                                </button>
                            )}
                        </header>

                        {!isCollapsed && (
                            <ul
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={() => {
                                    if (!dragging) return;
                                    const last = group.tasks
                                        .filter((task) => task.id !== dragging)
                                        .at(-1);
                                    onMove({
                                        taskId: dragging,
                                        groupKey: group.key,
                                        position: {
                                            beforeId: last?.id ?? null,
                                            afterId: null,
                                            placed: false
                                        }
                                    });
                                    setDragging(null);
                                }}
                            >
                                {rows.map((node) => {
                                    const task = byId.get(node.task.id);
                                    if (!task) return null;
                                    return (
                                        <TaskLine
                                            key={task.id}
                                            commands={commandsFor(props, task)}
                                            depth={node.depth}
                                            selected={selection.has(task.id)}
                                            selecting={selection.size > 0}
                                            cursor={cursor.at === task.id}
                                            showStatus={props.groupBy !== "status"}
                                            showLocation={props.showLocation}
                                            positioned={orderable && dragging !== task.id}
                                            onPoint={() => cursor.moveTo(task.id)}
                                            onRegister={(element) =>
                                                cursor.register(task.id, element)
                                            }
                                            onSelect={(mode) => onSelect(task.id, mode, rendered)}
                                            onDragStart={() => setDragging(task.id)}
                                            onDropAt={(edge) => {
                                                if (!dragging) return;
                                                setDragging(null);
                                                // Let go on its own row: the place it
                                                // is already in, and nothing to write.
                                                if (dragging === task.id) return;
                                                // Only the group is honoured while a
                                                // search is on: the row landed on says
                                                // which one, not where in it.
                                                const at = orderable
                                                    ? neighbours(
                                                          group.tasks,
                                                          task.id,
                                                          dragging,
                                                          edge
                                                      )
                                                    : null;
                                                if (orderable && !at) return;
                                                const last = group.tasks
                                                    .filter((entry) => entry.id !== dragging)
                                                    .at(-1);
                                                onMove({
                                                    taskId: dragging,
                                                    groupKey: group.key,
                                                    position: at
                                                        ? { ...at, placed: true }
                                                        : {
                                                              beforeId: last?.id ?? null,
                                                              afterId: null,
                                                              placed: false
                                                          }
                                                });
                                            }}
                                        />
                                    );
                                })}

                                {addingTo === group.key ? (
                                    <li className="px-2 py-1.5">
                                        <input
                                            autoFocus
                                            value={draft}
                                            placeholder={t("list.quickPlaceholder")}
                                            onChange={(event) => setDraft(event.target.value)}
                                            onBlur={() => setAddingTo(null)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Escape") setAddingTo(null);
                                                if (event.key === "Enter" && draft.trim()) {
                                                    onQuickCreate(group.key, draft.trim());
                                                    setDraft("");
                                                }
                                            }}
                                            className="w-full rounded-md border border-primary bg-background px-2 py-1 text-sm outline-none"
                                        />
                                    </li>
                                ) : (
                                    group.tasks.length === 0 && (
                                        <li className="px-4 py-4 text-xs text-muted-foreground">
                                            {t("empty.title")}
                                        </li>
                                    )
                                )}
                            </ul>
                        )}
                    </section>
                );
            })}

            {groups.length === 0 && (
                <EmptyState
                    title={t("list.noMatch")}
                    description={t("list.noMatchDescription")}
                />
            )}
        </div>
    );
}

/**
 * The table's own columns, in the order they are drawn. The task's name and its
 * status marker are not among them: a row with no name is not a row anybody can
 * read, so those two cannot be hidden.
 */
const TABLE_COLUMNS = ["status", "assignees", "priority", "due", "estimate", "tracked"] as const;

/**
 * Which columns this reader has taken off the table, kept in their browser.
 *
 * One set for every table rather than one per list: the built-in columns are the
 * same everywhere, and a custom field's id belongs to one space, so hiding it
 * here can never hide something on another screen. It is a reader's own
 * convenience, so a browser that refuses storage just shows every column.
 */
const HIDDEN_COLUMNS_KEY = "polaris.tasks.table.hidden";

function readHiddenColumns(): ReadonlySet<string> {
    try {
        const raw = window.localStorage.getItem(HIDDEN_COLUMNS_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return new Set(
            Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
        );
    } catch {
        return new Set();
    }
}

function writeHiddenColumns(hidden: ReadonlySet<string>): void {
    try {
        window.localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify([...hidden]));
    } catch {
        // Private browsing or a full quota: the choice holds for this visit only.
    }
}

export function TableView(props: ViewProps) {
    const { rows, context, selection, onOpen, onSelect } = props;
    const format = useDisplayFormat();
    const t = useTranslations("tasksViews");
    const tp = useTranslations("tasks");
    // Every custom field gets a column here: being able to compare them side by
    // side is the whole reason to look at a table rather than a list.
    const fields = context.fields;
    // A table is flat, so the rows themselves are the order a shift-click spans.
    const rendered = useMemo(() => rows.map((task) => task.id), [rows]);
    const cursor = useRowCursor(rendered, { onOpen, onSelect });

    // Read after mount: the server has no localStorage, and a first paint that
    // disagreed with what it rendered would be a hydration mismatch.
    const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
    useEffect(() => setHidden(readHiddenColumns()), []);
    const shows = (id: string) => !hidden.has(id);
    const toggleColumn = (id: string) => {
        const next = new Set(hidden);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setHidden(next);
        writeHiddenColumns(next);
    };
    const shownFields = fields.filter((field) => shows(field.id));
    const span = 3 + TABLE_COLUMNS.filter(shows).length + shownFields.length + 1;

    // The box at the head of the column says what the boxes under it add up to:
    // ticked when every row is in the selection, a dash when some are.
    const chosen = rows.reduce((count, task) => count + (selection.has(task.id) ? 1 : 0), 0);
    const allChosen = rows.length > 0 && chosen === rows.length;

    const columnLabel: Record<(typeof TABLE_COLUMNS)[number], string> = {
        status: t("table.status"),
        assignees: t("table.assignees"),
        priority: t("table.priority"),
        due: t("table.due"),
        estimate: t("table.estimate"),
        tracked: t("table.tracked")
    };

    return (
        <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
                <thead className="sticky top-0 z-10">
                    <tr className="border-b border-border bg-surface text-left text-xs text-muted-foreground">
                        <th className="w-8 py-2 pl-3 pr-1">
                            {props.onReplaceSelection && (
                                <Checkbox
                                    checked={allChosen}
                                    indeterminate={chosen > 0 && !allChosen}
                                    disabled={rows.length === 0}
                                    aria-label={t("table.selectAll")}
                                    title={t("table.selectAll")}
                                    onChange={() =>
                                        props.onReplaceSelection?.(allChosen ? [] : rendered)
                                    }
                                />
                            )}
                        </th>
                        <th className="w-8 px-1 py-2" />
                        <th className="px-2 py-2 font-medium">{t("table.task")}</th>
                        {TABLE_COLUMNS.filter(shows).map((id) => (
                            <th key={id} className="px-2 py-2 font-medium">
                                {columnLabel[id]}
                            </th>
                        ))}
                        {shownFields.map((field) => (
                            <th key={field.id} className="px-2 py-2 font-medium">
                                {field.name}
                            </th>
                        ))}
                        <th className="w-8 px-1 py-1 text-right">
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        aria-label={t("table.columns")}
                                        title={t("table.columns")}
                                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-card-hover hover:text-foreground active:bg-muted data-[state=open]:bg-card-hover data-[state=open]:text-foreground"
                                    >
                                        <Columns3 className="size-4" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-52">
                                    <DropdownMenuLabel>{t("table.columns")}</DropdownMenuLabel>
                                    {[
                                        ...TABLE_COLUMNS.map((id) => ({ id, label: columnLabel[id] })),
                                        ...fields.map((field) => ({ id: field.id, label: field.name }))
                                    ].map((column) => (
                                        <DropdownMenuItem
                                            key={column.id}
                                            role="menuitemcheckbox"
                                            aria-checked={shows(column.id)}
                                            // Stays open, so several columns can be
                                            // switched in one visit to the menu.
                                            onSelect={(event) => {
                                                event.preventDefault();
                                                toggleColumn(column.id);
                                            }}
                                        >
                                            <span className="flex size-4 items-center justify-center">
                                                {shows(column.id) && (
                                                    <Check className="text-primary" />
                                                )}
                                            </span>
                                            <span className="min-w-0 flex-1 truncate" title={column.label}>
                                                {column.label}
                                            </span>
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((task) => {
                        const commands = commandsFor(props, task);
                        const isSelected = selection.has(task.id);
                        return (
                            <TaskMenu key={task.id} commands={commands}>
                                <tr
                                    ref={(element) => cursor.register(task.id, element)}
                                    onMouseDown={() => cursor.moveTo(task.id)}
                                    aria-selected={isSelected}
                                    className={cn(
                                        "group border-b border-border transition-colors duration-fast hover:bg-card-hover",
                                        isSelected && "bg-primary/5",
                                        cursor.at === task.id &&
                                            "bg-card-hover shadow-[inset_2px_0_0_0_hsl(var(--primary))]"
                                    )}
                                >
                                    <td className="py-1.5 pl-3 pr-1">
                                        <Checkbox
                                            checked={isSelected}
                                            aria-label={t("table.selectRow", { name: task.name })}
                                            onChange={() => undefined}
                                            onClick={(event) =>
                                                onSelect(
                                                    task.id,
                                                    event.shiftKey ? "range" : "toggle",
                                                    rendered
                                                )
                                            }
                                        />
                                    </td>
                                    <td className="px-1 py-1.5">
                                        <TaskStatusMarker commands={commands} />
                                    </td>
                                    <td className="max-w-xs px-2 py-1.5">
                                        <button
                                            type="button"
                                            onMouseDown={(event) =>
                                                event.shiftKey ? event.preventDefault() : undefined
                                            }
                                            onClick={(event) => {
                                                const mode = clickMode(event);
                                                if (mode) onSelect(task.id, mode, rendered);
                                                else onOpen(task.id);
                                            }}
                                            className="flex w-full items-center gap-2 text-left"
                                        >
                                            <span className="shrink-0 whitespace-nowrap font-mono text-[0.6875rem] text-muted-foreground">
                                                {task.reference}
                                            </span>
                                            <span className="min-w-0 truncate" title={task.name}>
                                                {task.name}
                                            </span>
                                        </button>
                                        {props.showLocation && <TaskLocation task={task} />}
                                    </td>
                                    {shows("status") && (
                                        <td className="whitespace-nowrap px-2 py-1">
                                            {/* The status says itself and is the control
                                                that changes it, the way the priority beside
                                                it always was. */}
                                            <StatusPicker
                                                statuses={context.statuses}
                                                value={task.statusId}
                                                disabled={!props.canEdit}
                                                spaceId={context.spaceId}
                                                onChange={(statusId) => props.onEdit(task, { statusId })}
                                                trigger={
                                                    <button
                                                        type="button"
                                                        title={task.statusName}
                                                        aria-label={tp("pickers.statusNamed", {
                                                            name: task.statusName
                                                        })}
                                                        className="inline-flex max-w-[12rem] items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors duration-fast hover:bg-muted active:bg-muted/70 disabled:cursor-default disabled:hover:bg-transparent data-[state=open]:bg-muted"
                                                    >
                                                        <StatusDot color={task.statusColor} />
                                                        <span className="truncate" title={task.statusName}>{task.statusName}</span>
                                                    </button>
                                                }
                                            />
                                        </td>
                                    )}
                                    {shows("assignees") && (
                                        <td className="px-2 py-1.5">
                                            <span className="flex items-center gap-1">
                                                <AvatarStack people={task.assignees} size={20} />
                                                <span className="transition-opacity duration-fast md:opacity-0 focus-within:opacity-100 md:group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
                                                    <AssigneePicker
                                                        people={context.people}
                                                        selected={task.assignees.map(
                                                            (person) => person.id
                                                        )}
                                                        disabled={!props.canEdit}
                                                        onChange={(assigneeIds) =>
                                                            props.onEdit(task, { assigneeIds })
                                                        }
                                                    />
                                                </span>
                                            </span>
                                        </td>
                                    )}
                                    {shows("priority") && (
                                        <td className="whitespace-nowrap px-2 py-1 text-xs">
                                            <PriorityPicker
                                                value={task.priority}
                                                disabled={!props.canEdit}
                                                onChange={(priority) => props.onEdit(task, { priority })}
                                                trigger={
                                                    <button
                                                        type="button"
                                                        aria-label={tp("pickers.priority")}
                                                        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors duration-fast hover:bg-muted active:bg-muted/70 disabled:cursor-default disabled:hover:bg-transparent data-[state=open]:bg-muted"
                                                    >
                                                        <PriorityMark priority={task.priority} />
                                                        {tp(`labels.priority.${task.priority}`)}
                                                    </button>
                                                }
                                            />
                                        </td>
                                    )}
                                    {shows("due") && (
                                        <td className="whitespace-nowrap px-2 py-1.5">
                                            <span className="inline-flex items-center gap-1">
                                                <DueBadge
                                                    dueDate={task.dueDate}
                                                    statusType={task.statusType}
                                                    timed={task.timed}
                                                    format={format.date}
                                                />
                                                <span className="transition-opacity duration-fast md:opacity-0 focus-within:opacity-100 md:group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
                                                    <DuePicker
                                                        dueDate={task.dueDate}
                                                        timed={task.timed}
                                                        disabled={!props.canEdit}
                                                        onChange={(dueDate) =>
                                                            props.onEdit(task, { dueDate })
                                                        }
                                                    />
                                                </span>
                                            </span>
                                        </td>
                                    )}
                                    {shows("estimate") && (
                                        <td className="whitespace-nowrap px-2 py-1.5 text-xs tabular-nums text-muted-foreground">
                                            {core.formatDurationMinutes(task.timeEstimate) || "-"}
                                        </td>
                                    )}
                                    {shows("tracked") && (
                                        <td className="whitespace-nowrap px-2 py-1.5 text-xs tabular-nums text-muted-foreground">
                                            {task.trackedSeconds > 0
                                                ? core.formatTrackedSeconds(task.trackedSeconds)
                                                : "-"}
                                        </td>
                                    )}
                                    {shownFields.map((field) => (
                                        <td
                                            key={field.id}
                                            className="max-w-[12rem] px-2 py-1.5 text-xs"
                                        >
                                            <CustomFieldValue
                                                field={field}
                                                value={task.customValues[field.id] ?? ""}
                                                people={context.people}
                                            />
                                        </td>
                                    ))}
                                    <td />
                                </tr>
                            </TaskMenu>
                        );
                    })}
                    {rows.length === 0 && (
                        <tr>
                            <td
                                colSpan={span}
                                className="px-4 py-10 text-center text-sm text-muted-foreground"
                            >
                                {t("list.noMatch")}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}
