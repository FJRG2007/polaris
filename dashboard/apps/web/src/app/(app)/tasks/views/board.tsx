"use client";

/**
 * The board: one column per group, cards dragged between them.
 *
 * Drag and drop is the browser's own, not a library. A card is `draggable`, a
 * card is also a drop target that means "put it before me", and the column body
 * is a drop target that means "put it at the end". Those two targets are enough
 * to express any position, which is all a board needs, and it costs no
 * dependency and no bundle.
 *
 * The drop reports the two neighbours rather than an index. The server turns
 * those into an order key, so two people dragging at the same moment cannot
 * renumber each other's rows.
 *
 * The columns themselves are dragged the same way, by their headers, and that
 * order is the space's rather than one reader's: a board is a shared picture of
 * how work moves, so the sequence of its columns has to be too.
 */

import * as core from "@polaris/core";
import type { TaskRow } from "@/lib/tasks/facts";
import { useEffect, useMemo, useState } from "react";
import { useDisplayFormat } from "@/components/display-format";
import { clickMode, type BoardMove, type SelectMode, type ViewProps } from "./shared";
import { commandsFor, TaskMenu, TaskStatusMarker, type TaskCommands } from "./task-actions";
import {
    GripVertical,
    MessageSquare,
    MoreHorizontal,
    Paperclip,
    Pencil,
    Plus,
    Repeat,
    Trash2
} from "lucide-react";
import {
    AssigneePicker,
    AvatarStack,
    BlockedMarker,
    DueBadge,
    PriorityPicker,
    StatusDot,
    TagChip,
    TaskLocation
} from "../pickers";
import {
    ConfirmDeleteDialog,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Select,
    cn,
    keepFocusOnClose,
    useDeferredFocus
} from "@polaris/ui";

/** Where a card was dropped, as neighbours rather than an index. */
function neighbours(
    tasks: readonly TaskRow[],
    targetId: string | null,
    dragged: string
): BoardMove["position"] {
    const without = tasks.filter((task) => task.id !== dragged);
    if (!targetId) {
        const last = without.at(-1);
        return { beforeId: last?.id ?? null, afterId: null };
    }
    const index = without.findIndex((task) => task.id === targetId);
    if (index === -1) return { beforeId: null, afterId: null };
    return { beforeId: without[index - 1]?.id ?? null, afterId: targetId };
}

/**
 * A column set with one column moved onto another's place.
 *
 * Dragged leftwards it lands before the column it was dropped on; dragged
 * rightwards it takes that column's place and pushes it back. Either way the
 * card ends up where the pointer left it, which is the only thing the gesture
 * promised.
 */
export function reorderColumns(ids: readonly string[], dragged: string, target: string): string[] {
    const from = ids.indexOf(dragged);
    const to = ids.indexOf(target);
    if (from === -1 || to === -1 || from === to) return [...ids];
    const without = ids.filter((id) => id !== dragged);
    const at = without.indexOf(target) + (from < to ? 1 : 0);
    return [...without.slice(0, at), dragged, ...without.slice(at)];
}

/**
 * Every status a column stands for.
 *
 * A column is a name, and nothing stops a space holding two statuses that share
 * one - the board reads them as a single column. So anything done to a column is
 * done to all of them: renaming half of a merged column would split it in two on
 * the next load, and deleting half would leave the column there with some of its
 * work missing.
 */
export function columnStatusIds(columns: readonly core.StatusColumn[], key: string): string[] {
    return columns.find((column) => column.id === key)?.ids ?? [key];
}

/** What a column is: a name, what it means for the work sitting in it, and the
 *  colour it is read by. */
interface ColumnDraft {
    readonly name: string;
    readonly type: core.TaskStatusType;
    readonly color: string;
}

/**
 * The editor a column is made and reshaped with - one form for both, so a
 * column cannot be created with a kind it can never be given back.
 */
function ColumnEditor({
    initial,
    submitLabel,
    onSubmit,
    onCancel
}: {
    initial: ColumnDraft;
    submitLabel: string;
    onSubmit: (draft: ColumnDraft) => Promise<void>;
    onCancel: () => void;
}) {
    const [draft, setDraft] = useState(initial);
    const [busy, setBusy] = useState(false);
    // Opened from a menu whose focus trap is still up when this mounts, so
    // `autoFocus` would be bounced straight back to the menu item.
    const nameField = useDeferredFocus<HTMLInputElement>();

    const submit = async () => {
        const name = draft.name.trim();
        if (!name || busy) return;
        setBusy(true);
        await onSubmit({ ...draft, name });
        setBusy(false);
    };

    return (
        <div className="flex flex-col gap-2 p-3">
            <input
                ref={nameField}
                value={draft.name}
                placeholder="Column name"
                aria-label="Column name"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                onKeyDown={(event) => {
                    if (event.key === "Escape") onCancel();
                    if (event.key === "Enter") void submit();
                }}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
            />
            {/* The kind is not decoration: it is what decides whether work in
                this column counts as finished, so it is asked for rather than
                guessed from the name. */}
            <div className="flex flex-wrap gap-1">
                {core.TASK_STATUS_TYPES.map((type) => (
                    <button
                        key={type}
                        type="button"
                        onClick={() => setDraft({ ...draft, type })}
                        aria-pressed={draft.type === type}
                        title={core.TASK_STATUS_TYPE_HINTS[type]}
                        className={cn(
                            "rounded-md border px-2 py-1 text-[11px] transition-colors",
                            draft.type === type
                                ? "border-primary bg-primary/10 text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {core.TASK_STATUS_TYPE_LABELS[type]}
                    </button>
                ))}
            </div>
            <div className="flex items-center gap-2">
                <input
                    type="color"
                    value={draft.color}
                    aria-label="Column colour"
                    onChange={(event) => setDraft({ ...draft, color: event.target.value })}
                    className="size-8 cursor-pointer rounded border border-border bg-transparent"
                />
                <button
                    type="button"
                    disabled={!draft.name.trim() || busy}
                    onClick={() => void submit()}
                    className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                >
                    {busy ? "Saving..." : submitLabel}
                </button>
                <button
                    type="button"
                    onClick={onCancel}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}

/**
 * A control in the card's corner. What is set reads as information and stays
 * visible; what is empty would only be a pair of grey placeholders on every
 * card, so it waits for the pointer, and never appears at all to somebody who
 * cannot edit the task.
 */
function CornerControl({
    set,
    canEdit,
    children
}: {
    set: boolean;
    canEdit: boolean;
    children: React.ReactNode;
}) {
    if (set) return <>{children}</>;
    if (!canEdit) return null;
    // An open menu takes the pointer off the card, so hover alone would hide the
    // control being used and leave the menu floating beside a card with nothing
    // on it. It stays while its menu is open.
    return (
        <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
            {children}
        </span>
    );
}

export function TaskCard({
    commands,
    accepting = true,
    onDragStart,
    onDropBefore,
    positioned,
    selected,
    showLocation,
    onSelect
}: {
    commands: TaskCommands;
    /** Whether this card is a drop target at all. False while a column is being
     *  dragged, so the drop falls through to the column underneath instead of
     *  being swallowed by a card that has nothing to do with it. */
    accepting?: boolean;
    onDragStart: () => void;
    onDropBefore: () => void;
    /** Whether dropping here would actually put the card here. False under a
     *  sort that decides the order itself, where the insert line would be a
     *  promise the next render breaks. */
    positioned: boolean;
    selected: boolean;
    showLocation?: boolean;
    onSelect: (mode: SelectMode) => void;
}) {
    const format = useDisplayFormat();
    const [over, setOver] = useState(false);
    const { task, context, canEdit, onOpen } = commands;
    // The bottom line only earns its space when there is something on it.
    const hasMeta =
        task.dueDate !== null ||
        task.subtaskCount > 0 ||
        task.commentCount > 0 ||
        task.points !== null;

    return (
        <TaskMenu commands={commands}>
            <li
                draggable
                onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", task.id);
                    onDragStart();
                }}
                onDragOver={(event) => {
                    if (!accepting) return;
                    event.preventDefault();
                    setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(event) => {
                    if (!accepting) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setOver(false);
                    onDropBefore();
                }}
                className={cn(
                    "relative",
                    over &&
                        positioned &&
                        "before:absolute before:-top-1 before:h-0.5 before:w-full before:rounded before:bg-primary"
                )}
            >
                <div
                    role="button"
                    tabIndex={0}
                    onMouseDown={(event) => (event.shiftKey ? event.preventDefault() : undefined)}
                    onClick={(event) => {
                        const mode = clickMode(event);
                        if (mode) onSelect(mode);
                        else onOpen();
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            onOpen();
                        }
                    }}
                    className={cn(
                        "group flex cursor-pointer flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/50",
                        selected && "border-primary ring-1 ring-primary"
                    )}
                >
                    <div className="flex items-center gap-2">
                        <span
                            // The card opens on click, so the controls on it have to
                            // stop the click from reaching the card underneath.
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                            role="presentation"
                        >
                            <TaskStatusMarker commands={commands} />
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                            {task.reference}
                        </span>
                        <span className="flex-1" />
                        <BlockedMarker task={task} format={format.date} />
                        {task.recurring && (
                            <Repeat
                                className="size-3.5 shrink-0 text-muted-foreground"
                                aria-label="Repeats"
                            />
                        )}
                        {/* Who it is on and how urgent it is, in the corner rather
                        than adrift under the name - and each one is the control
                        that changes it, so there is no second flag on hover
                        doing what the flag already shown could do. */}
                        <span
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                            role="presentation"
                            className="flex items-center gap-1"
                        >
                            <CornerControl set={task.assignees.length > 0} canEdit={canEdit}>
                                <AssigneePicker
                                    people={context.people}
                                    selected={task.assignees.map((person) => person.id)}
                                    disabled={!canEdit}
                                    onChange={(assigneeIds) => commands.onEdit({ assigneeIds })}
                                    trigger={
                                        task.assignees.length > 0 ? (
                                            <button
                                                type="button"
                                                aria-label="Assignees"
                                                className="flex items-center rounded-full transition-opacity hover:opacity-75"
                                            >
                                                <AvatarStack people={task.assignees} size={18} />
                                            </button>
                                        ) : undefined
                                    }
                                />
                            </CornerControl>
                            <CornerControl set={task.priority !== "none"} canEdit={canEdit}>
                                <PriorityPicker
                                    value={task.priority}
                                    disabled={!canEdit}
                                    onChange={(priority) => commands.onEdit({ priority })}
                                />
                            </CornerControl>
                        </span>
                    </div>

                    <p
                        className={cn(
                            "text-sm leading-snug",
                            core.isFinishedStatus(task.statusType) && "text-muted-foreground"
                        )}
                    >
                        {task.name}
                    </p>

                    {showLocation && (
                        <span onClick={(event) => event.stopPropagation()} role="presentation">
                            <TaskLocation task={task} />
                        </span>
                    )}

                    {task.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                            {task.tags.map((tag) => (
                                <TagChip key={tag.id} tag={tag} />
                            ))}
                        </div>
                    )}

                    {hasMeta && (
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <DueBadge
                                dueDate={task.dueDate}
                                statusType={task.statusType}
                                timed={task.timed}
                                format={format.date}
                            />
                            {task.subtaskCount > 0 && (
                                <span
                                    className="inline-flex items-center gap-0.5"
                                    title={`${task.subtaskCount} subtasks`}
                                >
                                    <Paperclip className="size-3" />
                                    {task.subtaskCount}
                                </span>
                            )}
                            {task.commentCount > 0 && (
                                <span
                                    className="inline-flex items-center gap-0.5"
                                    title={`${task.commentCount} comments`}
                                >
                                    <MessageSquare className="size-3" />
                                    {task.commentCount}
                                </span>
                            )}
                            {task.points !== null && <span title="Points">{task.points} pts</span>}
                        </div>
                    )}
                </div>
            </li>
        </TaskMenu>
    );
}

export function BoardView(props: ViewProps) {
    const { context, groups, selection, onSelect, onMove, onQuickCreate, canEdit, orderable } =
        props;
    const [dragging, setDragging] = useState<string | null>(null);
    const [addingTo, setAddingTo] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [creating, setCreating] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);
    const [removing, setRemoving] = useState<{ key: string; label: string } | null>(null);
    const [replacement, setReplacement] = useState("");
    // The column being dragged by its header, and the one it is over. While one
    // is in the air the cards stop taking drops, so a column released over the
    // middle of another still lands on that column.
    const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
    const [columnOver, setColumnOver] = useState<string | null>(null);
    // The order a drag just asked for, held until the reload brings it back: a
    // column that snaps home for the length of a round trip reads as a refused
    // drag rather than a saved one.
    const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

    // Columns are the space's statuses only when that is what the board is
    // grouped by. Grouped by assignee or by tag, "add a column" would mean
    // inventing a person or a label, and renaming one would mean renaming them.
    const byStatus = (props.groupBy ?? "status") === "status";
    const canAddColumn = props.onCreateStatus !== undefined && byStatus;
    const canOrderColumns = props.onReorderStatuses !== undefined && byStatus;

    // The columns the space actually defines, which is what a reorder and a
    // replacement are chosen from. The "no status" pile is not one of them.
    const columns = useMemo(() => core.statusColumns(context.statuses), [context.statuses]);

    // The reload that follows a reorder brings the new order with it, and that
    // is when the local one has done its job - whether or not the write landed.
    useEffect(() => setPendingOrder(null), [context.statuses]);

    const shown = useMemo(() => {
        if (!pendingOrder) return groups;
        const at = new Map(pendingOrder.map((key, index) => [key, index]));
        // Anything the new order does not name - the "no status" pile - keeps
        // its place at the end.
        return [...groups].sort(
            (left, right) =>
                (at.get(left.key) ?? groups.length) - (at.get(right.key) ?? groups.length)
        );
    }, [groups, pendingOrder]);

    // A board is read down each column and then on to the next, which is the
    // order a shift-click spans.
    const rendered = useMemo(
        () => shown.flatMap((group) => group.tasks.map((task) => task.id)),
        [shown]
    );

    const drop = (groupKey: string, tasks: readonly TaskRow[], targetId: string | null) => {
        if (!dragging) return;
        // While a search is on, the card the drop landed on says which column was
        // meant and nothing more: the rows are ranked by how well they matched,
        // so a position among them is not one anybody could keep.
        const target = orderable ? targetId : null;
        onMove({ taskId: dragging, groupKey, position: neighbours(tasks, target, dragging) });
        setDragging(null);
    };

    const columnIds = (key: string) => columnStatusIds(columns, key);

    const dropColumn = async (targetKey: string) => {
        const dragged = draggingColumn;
        setDraggingColumn(null);
        setColumnOver(null);
        if (!dragged || !props.onReorderStatuses || !targetKey || dragged === targetKey) return;
        const order = reorderColumns(
            columns.map((column) => column.id),
            dragged,
            targetKey
        );
        setPendingOrder(order);
        await props.onReorderStatuses(order.flatMap(columnIds));
    };

    /** Start removing a column, on the one it would hand its work to. */
    const askToRemove = (group: { key: string; label: string }) => {
        setRemoving({ key: group.key, label: group.label });
        setReplacement(columns.find((column) => column.id !== group.key)?.id ?? "");
    };

    return (
        <>
            <div className="flex gap-3 overflow-x-auto pb-4">
                {shown.map((group) => {
                    // The pile of work with no status is not a column of the space:
                    // there is nothing there to rename, remove or move.
                    const isColumn = byStatus && group.key !== "";
                    const manageable =
                        isColumn &&
                        (props.onUpdateStatus !== undefined || props.onDeleteStatus !== undefined);
                    const movable = isColumn && canOrderColumns && columns.length > 1;
                    const status = isColumn
                        ? context.statuses.find((entry) => entry.id === group.key)
                        : undefined;

                    return (
                        <section
                            key={group.key}
                            className={cn(
                                "group/column flex w-72 shrink-0 flex-col rounded-lg bg-muted/40 transition-shadow",
                                draggingColumn === group.key && "opacity-60",
                                columnOver === group.key && "ring-2 ring-primary"
                            )}
                            onDragOver={(event) => {
                                event.preventDefault();
                                if (draggingColumn && draggingColumn !== group.key && isColumn)
                                    setColumnOver(group.key);
                            }}
                            onDragLeave={(event) => {
                                // Moving between the column's own children leaves it as
                                // far as the browser is concerned, so the pointer is only
                                // gone when what it entered is outside.
                                if (
                                    event.currentTarget.contains(event.relatedTarget as Node | null)
                                )
                                    return;
                                setColumnOver((current) =>
                                    current === group.key ? null : current
                                );
                            }}
                            onDrop={(event) => {
                                event.preventDefault();
                                if (draggingColumn) void dropColumn(group.key);
                                else drop(group.key, group.tasks, null);
                            }}
                        >
                            {editing === group.key ? (
                                <ColumnEditor
                                    initial={{
                                        name: group.label,
                                        type: status?.type ?? "open",
                                        color: group.color ?? "#64748b"
                                    }}
                                    submitLabel="Save"
                                    onCancel={() => setEditing(null)}
                                    onSubmit={async (next) => {
                                        const saved = await Promise.all(
                                            columnIds(group.key).map((id) =>
                                                props.onUpdateStatus?.(
                                                    id,
                                                    next.name,
                                                    next.type,
                                                    next.color
                                                )
                                            )
                                        );
                                        if (saved.every(Boolean)) setEditing(null);
                                    }}
                                />
                            ) : (
                                <header
                                    draggable={movable}
                                    onDragStart={(event) => {
                                        if (!movable) return;
                                        event.dataTransfer.effectAllowed = "move";
                                        event.dataTransfer.setData("text/plain", group.key);
                                        setDraggingColumn(group.key);
                                    }}
                                    onDragEnd={() => {
                                        setDraggingColumn(null);
                                        setColumnOver(null);
                                    }}
                                    className={cn(
                                        "flex items-center gap-2 px-3 py-2",
                                        movable && "cursor-grab active:cursor-grabbing"
                                    )}
                                >
                                    {movable && (
                                        // Fades in rather than appearing, so a row of
                                        // headers does not shuffle sideways on hover.
                                        <GripVertical
                                            aria-hidden
                                            className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/column:opacity-100"
                                        />
                                    )}
                                    {group.color && <StatusDot color={group.color} />}
                                    <h3
                                        className="truncate text-sm font-medium"
                                        title={group.label}
                                    >
                                        {group.label}
                                    </h3>
                                    <span className="rounded bg-background px-1.5 text-[11px] text-muted-foreground">
                                        {group.tasks.length}
                                    </span>
                                    <span className="flex-1" />
                                    {canEdit && (
                                        <button
                                            type="button"
                                            aria-label={`Add a task to ${group.label}`}
                                            title="Add a task"
                                            onClick={() => {
                                                setAddingTo(group.key);
                                                setDraft("");
                                            }}
                                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                                        >
                                            <Plus className="size-3.5" />
                                        </button>
                                    )}
                                    {manageable && (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <button
                                                    type="button"
                                                    aria-label={`Column options for ${group.label}`}
                                                    title="Column options"
                                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                                                >
                                                    <MoreHorizontal className="size-3.5" />
                                                </button>
                                            </DropdownMenuTrigger>
                                            {/* The rename field this menu opens would be
                                        blurred the moment the menu handed focus
                                        back to its trigger. */}
                                            <DropdownMenuContent
                                                align="end"
                                                className="w-44"
                                                onCloseAutoFocus={keepFocusOnClose}
                                            >
                                                {props.onUpdateStatus && (
                                                    <DropdownMenuItem
                                                        className="gap-2"
                                                        onSelect={() => setEditing(group.key)}
                                                    >
                                                        <Pencil className="size-3.5" />
                                                        Edit column
                                                    </DropdownMenuItem>
                                                )}
                                                {props.onDeleteStatus && (
                                                    <DropdownMenuItem
                                                        className="gap-2 text-danger focus:bg-danger/10"
                                                        // A board needs somewhere for the
                                                        // work to go, so the last column
                                                        // stays.
                                                        disabled={columns.length <= 1}
                                                        onSelect={() => askToRemove(group)}
                                                    >
                                                        <Trash2 className="size-3.5" />
                                                        Delete column
                                                    </DropdownMenuItem>
                                                )}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}
                                </header>
                            )}

                            <ul className="flex min-h-24 flex-col gap-2 px-2 pb-2">
                                {addingTo === group.key && (
                                    <li>
                                        <input
                                            autoFocus
                                            value={draft}
                                            placeholder="Task name, then enter"
                                            onChange={(event) => setDraft(event.target.value)}
                                            onBlur={() => setAddingTo(null)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Escape") setAddingTo(null);
                                                if (event.key === "Enter" && draft.trim()) {
                                                    onQuickCreate(group.key, draft.trim());
                                                    setDraft("");
                                                }
                                            }}
                                            className="w-full rounded-lg border border-primary bg-card px-3 py-2 text-sm outline-none"
                                        />
                                    </li>
                                )}
                                {group.tasks.map((task) => (
                                    <TaskCard
                                        key={task.id}
                                        commands={commandsFor(props, task)}
                                        accepting={draggingColumn === null}
                                        selected={selection.has(task.id)}
                                        showLocation={props.showLocation}
                                        positioned={orderable}
                                        onSelect={(mode) => onSelect(task.id, mode, rendered)}
                                        onDragStart={() => setDragging(task.id)}
                                        onDropBefore={() => drop(group.key, group.tasks, task.id)}
                                    />
                                ))}
                                {group.tasks.length === 0 && addingTo !== group.key && (
                                    <li className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
                                        Drop work here
                                    </li>
                                )}
                            </ul>
                        </section>
                    );
                })}

                {canAddColumn &&
                    (creating ? (
                        <section className="flex w-72 shrink-0 flex-col rounded-lg border border-dashed border-primary/50 bg-muted/20">
                            <ColumnEditor
                                initial={{ name: "", type: "open", color: "#64748b" }}
                                submitLabel="Add"
                                onCancel={() => setCreating(false)}
                                onSubmit={async (next) => {
                                    const id = await props.onCreateStatus?.(
                                        next.name,
                                        next.type,
                                        next.color
                                    );
                                    if (id) setCreating(false);
                                }}
                            />
                        </section>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setCreating(true)}
                            className="flex h-10 w-56 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                        >
                            <Plus className="size-3.5" /> New column
                        </button>
                    ))}
            </div>

            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => (open ? undefined : setRemoving(null))}
                name={removing?.label ?? ""}
                kind="column"
                description="Tasks on it move to the column you pick, so nothing falls off the board."
                confirmLabel="Delete column"
                confirmDisabled={!replacement}
                onConfirm={async () => {
                    if (!removing || !replacement) return;
                    // One at a time: a space keeps its last status, and two deletes
                    // racing each other would both read the count before either
                    // landed. The replacement is another column, so it is never one
                    // of these.
                    let done = true;
                    for (const id of columnIds(removing.key)) {
                        done = (await props.onDeleteStatus?.(id, replacement)) === true && done;
                    }
                    if (done) setRemoving(null);
                }}
            >
                <label className="flex flex-col gap-1 text-sm">
                    Move its tasks to
                    <Select
                        value={replacement}
                        onValueChange={setReplacement}
                        options={columns
                            .filter((column) => column.id !== removing?.key)
                            .map((column) => ({ value: column.id, label: column.name }))}
                        aria-label="Replacement column"
                        className="h-8 text-xs"
                    />
                </label>
            </ConfirmDeleteDialog>
        </>
    );
}
