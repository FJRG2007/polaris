"use client";

/**
 * The work inside the work: subtasks, checklists and dependencies.
 *
 * The distinction these three draw is the one people get wrong in every task
 * manager, so the copy here is deliberate. A subtask is a task - it has a
 * status, an owner and a reference. A checklist step is not - it is a tick.
 * A dependency is neither: it is a statement about order between two tasks that
 * already exist.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { useMemo, useState } from "react";
import { runAction } from "@/lib/run-action";
import { settleTagIds, withCreatedTags } from "./tag-creation";
import type { TaskBulkEdit, TaskEdit } from "./views/shared";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import { TaskMenu, type TaskCommands } from "./views/task-actions";
import { bulkOverlay, taskOverlay, type TaskOverlay } from "./optimistic";
import { AvatarStack, ProgressBar, StatusDot, StatusMarker } from "./pickers";
import type { ChecklistView, DependencyView } from "@/lib/tasks/task-service";
import { ArrowUpRight, Ban, Check, Link2, Plus, Trash2, X } from "lucide-react";
import { Button, Card, CardBody, Checkbox, cn, ConfirmDeleteDialog, Input } from "@polaris/ui";

/**
 * A row that can be picked up and put down somewhere else in its own list.
 *
 * The three lists inside a task - subtasks, checklists, the steps in one - are
 * all things people write down in the order they thought of them and then want
 * in the order they will do them. The drop is reported as the two rows it landed
 * between rather than as an index, the same way every other drag in Polaris is,
 * so two people tidying the same task cannot renumber each other.
 */
function Sortable({
    id,
    dragging,
    onDragStart,
    onDragEnd,
    onDropBefore,
    disabled,
    className,
    children
}: {
    id: string;
    dragging: string | null;
    onDragStart: () => void;
    onDragEnd: () => void;
    onDropBefore: () => void;
    disabled?: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    const [over, setOver] = useState(false);

    return (
        <li
            draggable={!disabled}
            onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", id);
                onDragStart();
            }}
            onDragEnd={onDragEnd}
            onDragOver={(event) => {
                if (disabled || !dragging || dragging === id) return;
                event.preventDefault();
                event.stopPropagation();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                if (!over) return;
                event.preventDefault();
                event.stopPropagation();
                setOver(false);
                onDropBefore();
            }}
            className={cn("relative", over && "before:absolute before:-top-px before:h-0.5 before:w-full before:rounded before:bg-primary", className)}
        >
            {children}
        </li>
    );
}

/** The row a drop above `id` should land between, among a set of siblings. */
function neighbours(siblings: readonly { id: string }[], targetId: string, dragged: string) {
    const without = siblings.filter((entry) => entry.id !== dragged);
    const index = without.findIndex((entry) => entry.id === targetId);
    return { beforeId: index > 0 ? (without[index - 1]?.id ?? null) : null, afterId: targetId };
}

/** A short line of text somebody types and presses enter on. Used for every
 *  "add one more" affordance so they all behave identically. */
function QuickAdd({
    placeholder,
    onAdd,
    disabled
}: {
    placeholder: string;
    onAdd: (value: string) => Promise<void>;
    disabled?: boolean;
}) {
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);

    const submit = async () => {
        const trimmed = value.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        await onAdd(trimmed);
        setBusy(false);
        setValue("");
    };

    return (
        <div className="flex items-center gap-2">
            <Input
                value={value}
                disabled={disabled || busy}
                placeholder={placeholder}
                onChange={(event) => setValue(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") void submit();
                }}
                className="h-8 text-sm"
            />
            <Button size="sm" variant="ghost" disabled={disabled || busy || !value.trim()} onClick={() => void submit()}>
                Add
            </Button>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Subtasks
// ---------------------------------------------------------------------------

export function SubtaskSection({
    taskId,
    listId,
    subtasks,
    context,
    onOpen,
    onChanged,
    onError,
    onCreateTag
}: {
    taskId: string;
    listId: string;
    subtasks: readonly TaskRow[];
    context: SpaceContext;
    onOpen: (taskId: string) => void;
    onChanged: () => void;
    onError: (message: string) => void;
    /** Born where it is needed, the same way the pickers on a board offer it. */
    onCreateTag?: (name: string, color: string) => Promise<string | null>;
}) {
    const canEdit = context.canEdit;
    const [dragging, setDragging] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<TaskRow | null>(null);
    // Optimistic overlay, exactly as the list and the board keep one: a subtask is a
    // task and answers the same menu, so reassigning one from here has to repaint on
    // the click rather than on the reload. Cleared when fresh rows arrive.
    const [pending, setPending] = useState<Record<string, TaskOverlay>>({});
    const rows = useMemo(
        () => subtasks.map((task) => ({ ...task, ...pending[task.id] })),
        [subtasks, pending]
    );

    const progress = core.rollupProgress(rows.map((task) => ({ statusType: task.statusType })));

    const reload = () => {
        setPending({});
        onChanged();
    };

    const move = async (targetId: string) => {
        if (!dragging || dragging === targetId) return;
        const position = neighbours(rows, targetId, dragging);
        const moved = dragging;
        setDragging(null);
        onError("");
        await runAction(() => actions.moveTaskAction({ taskId: moved, ...position }), onError);
        reload();
    };

    const edit = async (subtaskId: string, change: TaskEdit) => {
        onError("");
        setPending((current) => ({
            ...current,
            [subtaskId]: { ...current[subtaskId], ...taskOverlay(change, withCreatedTags(context)) }
        }));
        // A tag created from this row is carrying an id this browser made up until
        // the write, which is where it has to be a real one.
        const written = change.tagIds ? { ...change, tagIds: await settleTagIds(change.tagIds) } : change;
        const result = await runAction(() => actions.updateTaskAction({ taskId: subtaskId, ...written }), onError);
        if (result?.error) onError(result.error);
        reload();
    };

    /** What the menu writes. It speaks about a set even here, where there is
     *  only ever one subtask, so archiving works the same way it does on a board
     *  instead of needing a second write of its own. */
    const apply = async (subtask: TaskRow, change: TaskBulkEdit) => {
        onError("");
        if (change.archived === undefined) {
            setPending((current) => ({
                ...current,
                [subtask.id]: { ...current[subtask.id], ...bulkOverlay(subtask, change, withCreatedTags(context)) }
            }));
        }
        const written = change.addTagIds ? { ...change, addTagIds: await settleTagIds(change.addTagIds) } : change;
        const result = await runAction(() => actions.bulkUpdateAction({ taskIds: [subtask.id], ...written }), onError);
        if (result?.error) onError(result.error);
        reload();
    };

    const duplicate = async (subtaskId: string) => {
        onError("");
        const result = await runAction(() => actions.duplicateTaskAction(subtaskId), onError);
        if (result?.error) onError(result.error);
        reload();
    };

    /**
     * A subtask is a task, so it answers to the same menu as one - right-click a
     * row here and get the status, priority, people, tags, duplicate and delete
     * that the board and the list offer. Anything less makes the work inside a
     * task a second-class kind of work, reachable only by opening it first.
     */
    const commandsFor = (subtask: TaskRow): TaskCommands => ({
        task: subtask,
        targets: [subtask],
        context,
        // A subtask lives wherever its parent does, so there is no list of its
        // own to move it between and the menu leaves that verb out.
        lists: [],
        canEdit,
        onOpen: () => onOpen(subtask.id),
        onEdit: (change) => void edit(subtask.id, change),
        onApply: (change) => void apply(subtask, change),
        onDuplicate: () => void duplicate(subtask.id),
        onDelete: () => setDeleting(subtask),
        onCreateTag
    });

    return (
        <section className="flex flex-col gap-2">
            <header className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Subtasks</h3>
                {progress.total > 0 && (
                    <span className="text-xs text-muted-foreground">
                        {progress.done} of {progress.total}
                    </span>
                )}
            </header>
            {progress.total > 0 && <ProgressBar percent={progress.percent} />}

            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {subtasks.length === 0 && (
                    <li className="px-3 py-2 text-xs text-muted-foreground">
                        Break this down when a step needs its own owner or date.
                    </li>
                )}
                {subtasks.map((subtask) => (
                    <Sortable
                        key={subtask.id}
                        id={subtask.id}
                        dragging={dragging}
                        disabled={!canEdit}
                        onDragStart={() => setDragging(subtask.id)}
                        onDragEnd={() => setDragging(null)}
                        onDropBefore={() => void move(subtask.id)}
                    >
                        {/* The menu wraps the row's contents rather than the row
                            itself: the list item is what carries the drag, and a
                            trigger that took its place would need a ref through
                            Sortable to hold on to. */}
                        <TaskMenu commands={commandsFor(subtask)}>
                            <div className="flex items-center gap-2 px-3 py-2">
                                {/* The marker sets the state, rather than a checkbox
                                    that only ever meant done or not. It also used to
                                    write `archived: false`, which changed nothing. */}
                                <StatusMarker
                                    statuses={context.statuses}
                                    statusId={subtask.statusId}
                                    statusColor={subtask.statusColor}
                                    statusType={subtask.statusType}
                                    statusName={subtask.statusName}
                                    disabled={!canEdit}
                                    onChange={(statusId) => void edit(subtask.id, { statusId })}
                                />
                                <button
                                    type="button"
                                    onClick={() => onOpen(subtask.id)}
                                    className="flex-1 truncate text-left text-sm hover:underline"
                                >
                                    <span className="mr-2 font-mono text-[11px] text-muted-foreground">
                                        {subtask.reference}
                                    </span>
                                    <span
                                        className={cn(
                                            core.isFinishedStatus(subtask.statusType) && "text-muted-foreground"
                                        )}
                                    >
                                        {subtask.name}
                                    </span>
                                </button>
                                <AvatarStack people={subtask.assignees} size={20} />
                            </div>
                        </TaskMenu>
                    </Sortable>
                ))}
            </ul>

            {canEdit && (
                <QuickAdd
                    placeholder="Add a subtask"
                    onAdd={async (name) => {
                        onError("");
                        const result = await runAction(
                            () =>
                                actions.createTaskAction({
                                    listId,
                                    name,
                                    parentId: taskId
                                }),
                            onError
                        );
                        if (result?.error) onError(result.error);
                        reload();
                    }}
                />
            )}

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
                    onError("");
                    const result = await runAction(() => actions.deleteTaskAction(deleting.id), onError);
                    if (result?.error) onError(result.error);
                    setDeleting(null);
                    reload();
                }}
            />
        </section>
    );
}

// ---------------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------------

export function ChecklistSection({
    taskId,
    checklists,
    canEdit,
    onChanged,
    onError
}: {
    taskId: string;
    checklists: readonly ChecklistView[];
    canEdit: boolean;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const [adding, setAdding] = useState(false);
    // One at a time: a checklist and a step are never dragged together, and
    // keeping them apart is what stops a step being dropped onto a checklist
    // header and landing nowhere.
    const [draggingList, setDraggingList] = useState<string | null>(null);
    const [draggingStep, setDraggingStep] = useState<{ id: string; checklistId: string } | null>(null);

    const moveChecklist = async (targetId: string) => {
        if (!draggingList || draggingList === targetId) return;
        const position = neighbours(checklists, targetId, draggingList);
        const moved = draggingList;
        setDraggingList(null);
        onError("");
        await runAction(() => actions.moveChecklistAction(taskId, moved, position), onError);
        onChanged();
    };

    const moveStep = async (checklistId: string, items: readonly { id: string }[], targetId: string | null) => {
        if (!draggingStep) return;
        const moved = draggingStep.id;
        // Dropped on the list itself rather than on a step: the end of it.
        const position = targetId
            ? neighbours(items, targetId, moved)
            : { beforeId: items.filter((item) => item.id !== moved).at(-1)?.id ?? null, afterId: null };
        setDraggingStep(null);
        onError("");
        await runAction(() => actions.moveChecklistItemAction(taskId, moved, { checklistId, ...position }), onError);
        onChanged();
    };

    return (
        <section className="flex flex-col gap-3">
            <header className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Checklists</h3>
                {canEdit && !adding && (
                    <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                        <Plus className="size-3.5" /> Checklist
                    </Button>
                )}
            </header>

            {adding && (
                <QuickAdd
                    placeholder="Checklist name"
                    onAdd={async (name) => {
                        onError("");
                        const result = await runAction(() => actions.createChecklistAction(taskId, name), onError);
                        if (result?.error) onError(result.error);
                        setAdding(false);
                        onChanged();
                    }}
                />
            )}

            {checklists.length === 0 && !adding && (
                <p className="text-xs text-muted-foreground">
                    A checklist tracks steps that do not each need an owner or a date.
                </p>
            )}

            <ul className="flex flex-col gap-3">
            {checklists.map((checklist) => {
                const done = checklist.items.filter((item) => item.done).length;
                return (
                    <Sortable
                        key={checklist.id}
                        id={checklist.id}
                        dragging={draggingList}
                        disabled={!canEdit}
                        onDragStart={() => setDraggingList(checklist.id)}
                        onDragEnd={() => setDraggingList(null)}
                        onDropBefore={() => void moveChecklist(checklist.id)}
                    >
                    <Card>
                        <CardBody className="flex flex-col gap-2 p-3">
                            <div className="flex items-center justify-between gap-2">
                                <h4 className="text-sm font-medium">{checklist.name}</h4>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs text-muted-foreground">
                                        {done}/{checklist.items.length}
                                    </span>
                                    {canEdit && (
                                        <button
                                            type="button"
                                            aria-label={`Remove ${checklist.name}`}
                                            title="Remove checklist"
                                            onClick={async () => {
                                                await runAction(
                                                    () => actions.deleteChecklistAction(taskId, checklist.id),
                                                    onError
                                                );
                                                onChanged();
                                            }}
                                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                        >
                                            <Trash2 className="size-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            {checklist.items.length > 0 && (
                                <ProgressBar percent={Math.round((done / checklist.items.length) * 100)} />
                            )}

                            <ul
                                className="flex flex-col gap-1"
                                onDragOver={(event) => {
                                    if (draggingStep) event.preventDefault();
                                }}
                                onDrop={(event) => {
                                    if (!draggingStep) return;
                                    event.preventDefault();
                                    void moveStep(checklist.id, checklist.items, null);
                                }}
                            >
                                {checklist.items.map((item) => (
                                    <Sortable
                                        key={item.id}
                                        id={item.id}
                                        dragging={draggingStep?.id ?? null}
                                        disabled={!canEdit}
                                        onDragStart={() => setDraggingStep({ id: item.id, checklistId: checklist.id })}
                                        onDragEnd={() => setDraggingStep(null)}
                                        onDropBefore={() => void moveStep(checklist.id, checklist.items, item.id)}
                                        className="group flex items-center gap-2"
                                    >
                                        <Checkbox
                                            checked={item.done}
                                            aria-label={item.name}
                                            onChange={async (event) => {
                                                await runAction(
                                                    () =>
                                                        actions.setChecklistItemDoneAction(
                                                            taskId,
                                                            item.id,
                                                            event.target.checked
                                                        ),
                                                    onError
                                                );
                                                onChanged();
                                            }}
                                        />
                                        <span className={cn("flex-1 text-sm", item.done && "text-muted-foreground")}>
                                            {item.name}
                                        </span>
                                        {canEdit && (
                                            <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                                <button
                                                    type="button"
                                                    aria-label={`Turn ${item.name} into a task`}
                                                    title="Turn into a task"
                                                    onClick={async () => {
                                                        await runAction(
                                                            () => actions.promoteChecklistItemAction(taskId, item.id),
                                                            onError
                                                        );
                                                        onChanged();
                                                    }}
                                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                                >
                                                    <ArrowUpRight className="size-3.5" />
                                                </button>
                                                <button
                                                    type="button"
                                                    aria-label={`Remove ${item.name}`}
                                                    title="Remove step"
                                                    onClick={async () => {
                                                        await runAction(
                                                            () => actions.deleteChecklistItemAction(taskId, item.id),
                                                            onError
                                                        );
                                                        onChanged();
                                                    }}
                                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                                >
                                                    <X className="size-3.5" />
                                                </button>
                                            </span>
                                        )}
                                    </Sortable>
                                ))}
                            </ul>

                            {canEdit && (
                                <QuickAdd
                                    placeholder="Add a step"
                                    onAdd={async (name) => {
                                        const result = await runAction(
                                            () => actions.addChecklistItemAction(taskId, checklist.id, name),
                                            onError
                                        );
                                        if (result?.error) onError(result.error);
                                        onChanged();
                                    }}
                                />
                            )}
                        </CardBody>
                    </Card>
                    </Sortable>
                );
            })}
            </ul>
        </section>
    );
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export function DependencySection({
    taskId,
    dependencies,
    candidates,
    canEdit,
    onOpen,
    onChanged,
    onError
}: {
    taskId: string;
    dependencies: readonly DependencyView[];
    /** Other tasks in the space, for the picker. */
    candidates: readonly TaskRow[];
    canEdit: boolean;
    onOpen: (taskId: string) => void;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const [query, setQuery] = useState("");
    const [direction, setDirection] = useState<"blocking" | "waitingOn">("waitingOn");

    const matches = query.trim()
        ? candidates
              .filter((task) => task.id !== taskId)
              .filter(
                  (task) =>
                      task.name.toLowerCase().includes(query.trim().toLowerCase()) ||
                      task.reference.toLowerCase().includes(query.trim().toLowerCase())
              )
              .slice(0, 6)
        : [];

    const waitingOn = dependencies.filter((edge) => edge.direction === "waitingOn");
    const blocking = dependencies.filter((edge) => edge.direction === "blocking");

    const row = (edge: DependencyView) => (
        <li key={edge.id} className="flex items-center gap-2 px-3 py-2">
            {edge.finished ? (
                <Check className="size-3.5 shrink-0 text-emerald-500" />
            ) : (
                <Ban className="size-3.5 shrink-0 text-amber-500" />
            )}
            <button type="button" onClick={() => onOpen(edge.taskId)} className="flex-1 truncate text-left text-sm hover:underline">
                <span className="mr-2 font-mono text-[11px] text-muted-foreground">{edge.reference}</span>
                {edge.name}
            </button>
            <StatusDot color={edge.statusColor} />
            {canEdit && (
                <button
                    type="button"
                    aria-label={`Unlink ${edge.name}`}
                    title="Remove link"
                    onClick={async () => {
                        await runAction(() => actions.removeDependencyAction(taskId, edge.id), onError);
                        onChanged();
                    }}
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                >
                    <X className="size-3.5" />
                </button>
            )}
        </li>
    );

    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Dependencies</h3>

            {dependencies.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    Link work that has to happen in order. A task waiting on something unfinished is marked on the board.
                </p>
            )}

            {waitingOn.length > 0 && (
                <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Waiting on</p>
                    <ul className="divide-y divide-border rounded-md border border-border">{waitingOn.map(row)}</ul>
                </div>
            )}
            {blocking.length > 0 && (
                <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Blocking</p>
                    <ul className="divide-y divide-border rounded-md border border-border">{blocking.map(row)}</ul>
                </div>
            )}

            {canEdit && (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setDirection(direction === "waitingOn" ? "blocking" : "waitingOn")}
                            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            {direction === "waitingOn" ? "This waits on" : "This blocks"}
                        </button>
                        <Input
                            value={query}
                            placeholder="Find a task by name or reference"
                            onChange={(event) => setQuery(event.target.value)}
                            className="h-8 flex-1 text-sm"
                        />
                    </div>
                    {matches.length > 0 && (
                        <ul className="divide-y divide-border rounded-md border border-border">
                            {matches.map((candidate) => (
                                <li key={candidate.id}>
                                    <button
                                        type="button"
                                        onClick={async () => {
                                            const result = await runAction(
                                                () =>
                                                    actions.addDependencyAction({
                                                        taskId,
                                                        relatedTaskId: candidate.id,
                                                        type: "blocks",
                                                        // "This waits on X" means X blocks this.
                                                        reverse: direction === "waitingOn"
                                                    }),
                                                onError
                                            );
                                            if (result?.error) onError(result.error);
                                            setQuery("");
                                            onChanged();
                                        }}
                                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                                    >
                                        <Link2 className="size-3.5 text-muted-foreground" />
                                        <span className="font-mono text-[11px] text-muted-foreground">{candidate.reference}</span>
                                        <span className="truncate">{candidate.name}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </section>
    );
}
