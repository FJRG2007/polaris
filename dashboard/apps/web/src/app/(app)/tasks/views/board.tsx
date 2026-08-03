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
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import type { TaskRow } from "@/lib/tasks/facts";
import type { BoardMove, ViewProps } from "./shared";
import { useDisplayFormat } from "@/components/display-format";
import { Ban, MessageSquare, Paperclip, Plus, Repeat } from "lucide-react";
import { commandsFor, TaskMenu, TaskStatusMarker, type TaskCommands } from "./task-actions";
import { AssigneePicker, AvatarStack, DueBadge, PriorityPicker, StatusDot, TagChip, TaskLocation } from "../pickers";

/** Where a card was dropped, as neighbours rather than an index. */
function neighbours(tasks: readonly TaskRow[], targetId: string | null, dragged: string): BoardMove["position"] {
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
 * A control in the card's corner. What is set reads as information and stays
 * visible; what is empty would only be a pair of grey placeholders on every
 * card, so it waits for the pointer, and never appears at all to somebody who
 * cannot edit the task.
 */
function CornerControl({ set, canEdit, children }: { set: boolean; canEdit: boolean; children: React.ReactNode }) {
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
    onDragStart,
    onDropBefore,
    selected,
    showLocation,
    onSelect
}: {
    commands: TaskCommands;
    onDragStart: () => void;
    onDropBefore: () => void;
    selected: boolean;
    showLocation?: boolean;
    onSelect?: (event: React.MouseEvent) => void;
}) {
    const format = useDisplayFormat();
    const [over, setOver] = useState(false);
    const { task, context, canEdit, onOpen } = commands;
    // The bottom line only earns its space when there is something on it.
    const hasMeta = task.dueDate !== null || task.subtaskCount > 0 || task.commentCount > 0 || task.points !== null;

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
                event.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setOver(false);
                onDropBefore();
            }}
            className={cn("relative", over && "before:absolute before:-top-1 before:h-0.5 before:w-full before:rounded before:bg-primary")}
        >
            <div
                role="button"
                tabIndex={0}
                onClick={(event) => (onSelect && (event.metaKey || event.ctrlKey) ? onSelect(event) : onOpen())}
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
                    <span className="font-mono text-[10px] text-muted-foreground">{task.reference}</span>
                    <span className="flex-1" />
                    {task.blocked && <Ban className="size-3.5 shrink-0 text-amber-500" aria-label="Blocked" />}
                    {task.recurring && <Repeat className="size-3.5 shrink-0 text-muted-foreground" aria-label="Repeats" />}
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

                <p className={cn("text-sm leading-snug", core.isFinishedStatus(task.statusType) && "text-muted-foreground")}>
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
                        <DueBadge dueDate={task.dueDate} statusType={task.statusType} timed={task.timed} format={format.date} />
                        {task.subtaskCount > 0 && (
                            <span className="inline-flex items-center gap-0.5" title={`${task.subtaskCount} subtasks`}>
                                <Paperclip className="size-3" />
                                {task.subtaskCount}
                            </span>
                        )}
                        {task.commentCount > 0 && (
                            <span className="inline-flex items-center gap-0.5" title={`${task.commentCount} comments`}>
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
    const { groups, selection, onSelect, onMove, onQuickCreate, canEdit } = props;
    const [dragging, setDragging] = useState<string | null>(null);
    const [addingTo, setAddingTo] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [newColumn, setNewColumn] = useState<{ name: string; type: core.TaskStatusType; color: string } | null>(null);
    const [savingColumn, setSavingColumn] = useState(false);

    // A column can only be added when the board's columns ARE the space's
    // statuses. Grouped by assignee or by tag, "add a column" would mean
    // inventing a person or a label, which is not what the button says.
    const canAddColumn = props.onCreateStatus !== undefined && (props.groupBy ?? "status") === "status";

    const drop = (groupKey: string, tasks: readonly TaskRow[], targetId: string | null) => {
        if (!dragging) return;
        onMove({ taskId: dragging, groupKey, position: neighbours(tasks, targetId, dragging) });
        setDragging(null);
    };

    return (
        <div className="flex gap-3 overflow-x-auto pb-4">
            {groups.map((group) => (
                <section
                    key={group.key}
                    className="flex w-72 shrink-0 flex-col rounded-lg bg-muted/40"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                        event.preventDefault();
                        drop(group.key, group.tasks, null);
                    }}
                >
                    <header className="flex items-center gap-2 px-3 py-2">
                        {group.color && <StatusDot color={group.color} />}
                        <h3 className="truncate text-sm font-medium">{group.label}</h3>
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
                    </header>

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
                                selected={selection.has(task.id)}
                                showLocation={props.showLocation}
                                onSelect={() => onSelect(task.id)}
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
            ))}

            {canAddColumn &&
                (newColumn ? (
                    <section className="flex w-72 shrink-0 flex-col gap-2 rounded-lg border border-dashed border-primary/50 bg-muted/20 p-3">
                        <input
                            autoFocus
                            value={newColumn.name}
                            placeholder="Column name"
                            aria-label="Status name"
                            onChange={(event) => setNewColumn({ ...newColumn, name: event.target.value })}
                            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
                        />
                        {/* The kind is not decoration: it is what decides whether
                            work in this column counts as finished, so it is asked
                            for rather than guessed from the name. */}
                        <div className="flex flex-wrap gap-1">
                            {core.TASK_STATUS_TYPES.map((type) => (
                                <button
                                    key={type}
                                    type="button"
                                    onClick={() => setNewColumn({ ...newColumn, type })}
                                    aria-pressed={newColumn.type === type}
                                    title={core.TASK_STATUS_TYPE_HINTS[type]}
                                    className={cn(
                                        "rounded-md border px-2 py-1 text-[11px] transition-colors",
                                        newColumn.type === type
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
                                value={newColumn.color}
                                aria-label="Column colour"
                                onChange={(event) => setNewColumn({ ...newColumn, color: event.target.value })}
                                className="size-8 cursor-pointer rounded border border-border bg-transparent"
                            />
                            <button
                                type="button"
                                disabled={!newColumn.name.trim() || savingColumn}
                                onClick={async () => {
                                    if (!props.onCreateStatus) return;
                                    setSavingColumn(true);
                                    await props.onCreateStatus(newColumn.name.trim(), newColumn.type, newColumn.color);
                                    setSavingColumn(false);
                                    setNewColumn(null);
                                }}
                                className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                            >
                                Add
                            </button>
                            <button
                                type="button"
                                onClick={() => setNewColumn(null)}
                                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                            >
                                Cancel
                            </button>
                        </div>
                    </section>
                ) : (
                    <button
                        type="button"
                        onClick={() => setNewColumn({ name: "", type: "open", color: "#64748b" })}
                        className="flex h-10 w-56 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                    >
                        <Plus className="size-3.5" /> New column
                    </button>
                ))}
        </div>
    );
}
