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
import { useMemo, useRef, useState } from "react";
import { runAction } from "@/lib/run-action";
import { schemaMessage } from "./schema-message";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { settleTagIds, withCreatedTags } from "./tag-creation";
import type { TaskBulkEdit, TaskEdit } from "./views/shared";
import { dropEdge, neighbours, type DropEdge } from "./drop-edge";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import { TaskMenu, type TaskCommands } from "./views/task-actions";
import { bulkOverlay, taskOverlay, type TaskOverlay } from "./optimistic";
import { AvatarStack, ProgressBar, StatusDot, StatusMarker } from "./pickers";
import type { ChecklistView, DependencyView } from "@/lib/tasks/task-service";
import * as order from "./subwork-order";
import { ArrowUpRight, Ban, Check, ChevronDown, ChevronUp, Link2, Plus, Trash2, X } from "lucide-react";
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
    onDropAt,
    disabled,
    className,
    children
}: {
    id: string;
    dragging: string | null;
    onDragStart: () => void;
    onDragEnd: () => void;
    /** Dropped on this row, on the half of it the pointer was in. */
    onDropAt: (edge: DropEdge) => void;
    disabled?: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    const [over, setOver] = useState<DropEdge | null>(null);

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
                setOver(dropEdge(event.clientY, event.currentTarget));
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(event) => {
                // Let go on its own row. It still takes the drop: underneath is
                // the list itself, which means the end of it, and a row released
                // where it already is has not asked to go anywhere.
                if (dragging === id) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                if (!over) return;
                event.preventDefault();
                event.stopPropagation();
                setOver(null);
                onDropAt(over);
            }}
            className={cn("relative", className)}
        >
            {over && (
                <span
                    aria-hidden
                    className={cn(
                        "pointer-events-none absolute left-0 z-10 h-0.5 w-full rounded bg-primary",
                        over === "before" ? "-top-px" : "-bottom-px"
                    )}
                />
            )}
            {children}
        </li>
    );
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
    const t = useTranslations("tasksDetail");
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
            <Button
                size="sm"
                variant="ghost"
                disabled={disabled || busy || !value.trim()}
                onClick={() => void submit()}
            >
                {t("subwork.add")}
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
    const t = useTranslations("tasksDetail");
    const tt = useTranslations("tasks");
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

    const move = async (targetId: string, edge: DropEdge) => {
        if (!dragging || dragging === targetId) return;
        const position = neighbours(rows, targetId, dragging, edge);
        if (!position) return;
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
        const written = change.tagIds
            ? { ...change, tagIds: await settleTagIds(change.tagIds) }
            : change;
        const result = await runAction(
            () => actions.updateTaskAction({ taskId: subtaskId, ...written }),
            onError
        );
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
                [subtask.id]: {
                    ...current[subtask.id],
                    ...bulkOverlay(subtask, change, withCreatedTags(context))
                }
            }));
        }
        const written = change.addTagIds
            ? { ...change, addTagIds: await settleTagIds(change.addTagIds) }
            : change;
        const result = await runAction(
            () => actions.bulkUpdateAction({ taskIds: [subtask.id], ...written }),
            onError
        );
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
                <h3 className="text-sm font-medium">{t("subwork.subtasks")}</h3>
                {progress.total > 0 && (
                    <span className="text-xs text-muted-foreground">
                        {t("subwork.progress", { done: progress.done, total: progress.total })}
                    </span>
                )}
            </header>
            {progress.total > 0 && <ProgressBar percent={progress.percent} />}

            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                {subtasks.length === 0 && (
                    <li className="px-3 py-2 text-xs text-muted-foreground">
                        {t("subwork.subtasksEmpty")}
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
                        onDropAt={(edge) => void move(subtask.id, edge)}
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
                                    <span className="mr-2 font-mono text-[0.6875rem] text-muted-foreground">
                                        {subtask.reference}
                                    </span>
                                    <span
                                        className={cn(
                                            core.isFinishedStatus(subtask.statusType) &&
                                                "text-muted-foreground"
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
                    placeholder={t("subwork.addSubtask")}
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
                title={tt("deleteTask.title")}
                question={tt.rich("deleteTask.question", {
                    name: deleting?.name ?? "",
                    strong: (chunks) => <span key="name" className="font-medium text-foreground">{chunks}</span>
                })}
                description={tt("deleteTask.description")}
                confirmLabel={tt("deleteTask.title")}
                onConfirm={async () => {
                    if (!deleting) return;
                    onError("");
                    const result = await runAction(
                        () => actions.deleteTaskAction(deleting.id),
                        onError
                    );
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

/**
 * A list as the screen shows it while a change to it is on its way.
 *
 * Kept beside the rows it was made from and used only while those are still
 * the rows on screen: when the reload that follows a write brings fresh ones,
 * the overlay is simply no longer theirs, the same "dropped rather than merged"
 * the board's overlay keeps. A refused write puts the server's rows back.
 */
function useOverlay<Row>(
    rows: readonly Row[],
    onChanged: () => void,
    onError: (message: string) => void
) {
    const [overlay, setOverlay] = useState<{
        source: readonly Row[];
        view: readonly Row[];
    } | null>(null);
    const shown = overlay && overlay.source === rows ? overlay.view : rows;

    const apply = async (next: readonly Row[], call: () => Promise<{ error?: string }>) => {
        setOverlay({ source: rows, view: next });
        onError("");
        const result = await runAction(call, onError);
        if (!result || result.error) {
            setOverlay(null);
            if (result?.error) onError(result.error);
        }
        onChanged();
    };

    return { shown, apply };
}

/**
 * One place up or down: the drag, for somebody on a keyboard, and for a phone,
 * where holding a row until it lifts is not something anybody discovers.
 */
function MoveButtons({
    name,
    index,
    count,
    onMove
}: {
    name: string;
    index: number;
    count: number;
    onMove: (delta: -1 | 1) => void;
}) {
    const t = useTranslations("tasksDetail");
    if (count < 2) return null;
    const style =
        "rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30";
    return (
        <>
            <button
                type="button"
                disabled={index === 0}
                aria-label={t("subwork.moveUpNamed", { name })}
                title={t("subwork.moveUp")}
                onClick={() => onMove(-1)}
                className={style}
            >
                <ChevronUp className="size-3.5" />
            </button>
            <button
                type="button"
                disabled={index === count - 1}
                aria-label={t("subwork.moveDownNamed", { name })}
                title={t("subwork.moveDown")}
                onClick={() => onMove(1)}
                className={style}
            >
                <ChevronDown className="size-3.5" />
            </button>
        </>
    );
}

/**
 * A name that becomes a field when it is clicked. Enter or leaving the field
 * saves, Escape puts it back. Checked against the rule the server uses while it
 * is typed, and a name that ends up where it started is not a write.
 */
export function InlineName({
    name,
    rule,
    disabled,
    className,
    onRename
}: {
    name: string;
    /** Which name rule applies: a checklist's, which is a container's, or a step's. */
    rule: "checklist" | "step";
    disabled?: boolean;
    className?: string;
    onRename: (name: string) => void;
}) {
    const t = useTranslations("tasksDetail");
    const tt = useTranslations("tasks");
    const [draft, setDraft] = useState<string | null>(null);
    // Escape closes the field, and the browser may still report it losing focus
    // on the way out; that blur must not save what Escape just threw away.
    const closed = useRef(false);
    const schema = rule === "checklist" ? core.checklistSchema.shape.name : core.taskName;

    if (draft === null) {
        if (disabled) return <span className={cn("min-w-0 truncate", className)}>{name}</span>;
        return (
            <button
                type="button"
                title={t("subwork.rename")}
                aria-label={t("subwork.renameNamed", { name })}
                onClick={() => {
                    closed.current = false;
                    setDraft(name);
                }}
                className={cn("min-w-0 cursor-text truncate text-left hover:underline", className)}
            >
                {name}
            </button>
        );
    }

    const parsed = schema.safeParse(draft);
    // An emptied field is unfinished rather than wrong: it saves nothing and says
    // nothing, and the rule only speaks up about something actually typed.
    const issue =
        draft.trim() && !parsed.success
            ? schemaMessage(tt, parsed.error.issues[0]?.message, "") || null
            : null;

    const finish = (save: boolean) => {
        if (closed.current) return;
        // Enter on a name the rule refuses keeps the field open beside the reason.
        if (save && issue) return;
        closed.current = true;
        if (save && parsed.success && parsed.data !== name) onRename(parsed.data);
        setDraft(null);
    };

    return (
        <span className="flex min-w-0 flex-1 flex-col gap-1">
            <Input
                autoFocus
                value={draft}
                data-keeps-escape=""
                aria-label={t("subwork.renameNamed", { name })}
                aria-invalid={issue ? true : undefined}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        finish(true);
                    } else if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        finish(false);
                    }
                }}
                // Leaving with something the rule refuses puts the old name back
                // rather than holding the reader in a field they have left.
                onBlur={() => finish(!issue)}
                className="h-7 text-sm"
            />
            {issue && <span className="text-xs text-danger">{issue}</span>}
        </span>
    );
}

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
    const t = useTranslations("tasksDetail");
    const [adding, setAdding] = useState(false);
    // One at a time: a checklist and a step are never dragged together, and
    // keeping them apart is what stops a step being dropped onto a checklist
    // header and landing nowhere.
    const [draggingList, setDraggingList] = useState<string | null>(null);
    const [draggingStep, setDraggingStep] = useState<{ id: string; checklistId: string } | null>(
        null
    );
    const { shown, apply } = useOverlay(checklists, onChanged, onError);

    const placeChecklist = (checklistId: string, position: order.DropPosition) => {
        const next = order.placeRow(shown, checklistId, position);
        if (order.samePlace(shown, next)) return;
        void apply(next, () => actions.moveChecklistAction(taskId, checklistId, position));
    };

    const moveChecklist = (targetId: string, edge: DropEdge) => {
        if (!draggingList || draggingList === targetId) return;
        const position = neighbours(shown, targetId, draggingList, edge);
        const moved = draggingList;
        setDraggingList(null);
        if (position) placeChecklist(moved, position);
    };

    const placeStepAt = (itemId: string, checklistId: string, position: order.DropPosition) => {
        const next = order.placeStep(shown, itemId, checklistId, position);
        const unchanged = shown.every((checklist, index) =>
            order.samePlace(checklist.items, next[index]?.items ?? [])
        );
        if (unchanged) return;
        void apply(next, () =>
            actions.moveChecklistItemAction(taskId, itemId, { checklistId, ...position })
        );
    };

    const moveStep = (
        checklistId: string,
        items: readonly { id: string }[],
        target: { id: string; edge: DropEdge } | null
    ) => {
        if (!draggingStep) return;
        const moved = draggingStep.id;
        // Dropped on the list itself rather than on a step: the end of it.
        const position = target
            ? neighbours(items, target.id, moved, target.edge)
            : {
                  beforeId: items.filter((item) => item.id !== moved).at(-1)?.id ?? null,
                  afterId: null
              };
        setDraggingStep(null);
        // The step it landed on is gone: no place was named, and the end of the
        // checklist is not a stand-in for one.
        if (position) placeStepAt(moved, checklistId, position);
    };

    const rename = (checklistId: string, name: string) =>
        void apply(
            shown.map((checklist) =>
                checklist.id === checklistId ? { ...checklist, name } : checklist
            ),
            () => actions.renameChecklistAction(taskId, checklistId, name)
        );

    const renameStep = (itemId: string, name: string) =>
        void apply(
            shown.map((checklist) => ({
                ...checklist,
                items: checklist.items.map((item) => (item.id === itemId ? { ...item, name } : item))
            })),
            () => actions.renameChecklistItemAction(taskId, itemId, name)
        );

    return (
        <section className="flex flex-col gap-3">
            <header className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{t("subwork.checklists")}</h3>
                {canEdit && !adding && (
                    <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
                        <Plus className="size-3.5" /> {t("subwork.checklist")}
                    </Button>
                )}
            </header>

            {adding && (
                <QuickAdd
                    placeholder={t("subwork.checklistName")}
                    onAdd={async (name) => {
                        onError("");
                        const result = await runAction(
                            () => actions.createChecklistAction(taskId, name),
                            onError
                        );
                        if (result?.error) onError(result.error);
                        setAdding(false);
                        onChanged();
                    }}
                />
            )}

            {shown.length === 0 && !adding && (
                <p className="text-xs text-muted-foreground">
                    {t("subwork.checklistsEmpty")}
                </p>
            )}

            <ul className="flex flex-col gap-3">
                {shown.map((checklist, checklistIndex) => {
                    const done = checklist.items.filter((item) => item.done).length;
                    return (
                        <Sortable
                            key={checklist.id}
                            id={checklist.id}
                            dragging={draggingList}
                            disabled={!canEdit}
                            onDragStart={() => setDraggingList(checklist.id)}
                            onDragEnd={() => setDraggingList(null)}
                            onDropAt={(edge) => moveChecklist(checklist.id, edge)}
                        >
                            <Card>
                                <CardBody className="flex flex-col gap-2 p-3">
                                    <div className="group/checklist flex items-center justify-between gap-2">
                                        <InlineName
                                            name={checklist.name}
                                            rule="checklist"
                                            disabled={!canEdit}
                                            onRename={(name) => rename(checklist.id, name)}
                                            className="text-sm font-medium"
                                        />
                                        <div className="flex shrink-0 items-center gap-2">
                                            <span className="text-xs text-muted-foreground">
                                                {done}/{checklist.items.length}
                                            </span>
                                            {canEdit && (
                                                <span className="flex items-center gap-0.5 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover/checklist:opacity-100">
                                                    <MoveButtons
                                                        name={checklist.name}
                                                        index={checklistIndex}
                                                        count={shown.length}
                                                        onMove={(delta) => {
                                                            const position = order.shiftPosition(
                                                                shown,
                                                                checklist.id,
                                                                delta
                                                            );
                                                            if (position)
                                                                placeChecklist(checklist.id, position);
                                                        }}
                                                    />
                                                    <button
                                                        type="button"
                                                        aria-label={t("subwork.removeNamed", { name: checklist.name })}
                                                        title={t("subwork.removeChecklist")}
                                                        onClick={async () => {
                                                            await runAction(
                                                                () =>
                                                                    actions.deleteChecklistAction(
                                                                        taskId,
                                                                        checklist.id
                                                                    ),
                                                                onError
                                                            );
                                                            onChanged();
                                                        }}
                                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                                    >
                                                        <Trash2 className="size-3.5" />
                                                    </button>
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    {checklist.items.length > 0 && (
                                        <ProgressBar
                                            percent={Math.round(
                                                (done / checklist.items.length) * 100
                                            )}
                                        />
                                    )}

                                    <ul
                                        className="flex flex-col gap-1"
                                        onDragOver={(event) => {
                                            if (draggingStep) event.preventDefault();
                                        }}
                                        onDrop={(event) => {
                                            if (!draggingStep) return;
                                            event.preventDefault();
                                            moveStep(checklist.id, checklist.items, null);
                                        }}
                                    >
                                        {checklist.items.map((item, itemIndex) => (
                                            <Sortable
                                                key={item.id}
                                                id={item.id}
                                                dragging={draggingStep?.id ?? null}
                                                disabled={!canEdit}
                                                onDragStart={() =>
                                                    setDraggingStep({
                                                        id: item.id,
                                                        checklistId: checklist.id
                                                    })
                                                }
                                                onDragEnd={() => setDraggingStep(null)}
                                                onDropAt={(edge) =>
                                                    moveStep(checklist.id, checklist.items, {
                                                        id: item.id,
                                                        edge
                                                    })
                                                }
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
                                                <InlineName
                                                    name={item.name}
                                                    rule="step"
                                                    disabled={!canEdit}
                                                    onRename={(name) => renameStep(item.id, name)}
                                                    className={cn(
                                                        "flex-1 text-sm",
                                                        item.done && "text-muted-foreground"
                                                    )}
                                                />
                                                {canEdit && (
                                                    <span className="flex shrink-0 items-center gap-0.5 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
                                                        <MoveButtons
                                                            name={item.name}
                                                            index={itemIndex}
                                                            count={checklist.items.length}
                                                            onMove={(delta) => {
                                                                const position = order.shiftPosition(
                                                                    checklist.items,
                                                                    item.id,
                                                                    delta
                                                                );
                                                                if (position)
                                                                    placeStepAt(
                                                                        item.id,
                                                                        checklist.id,
                                                                        position
                                                                    );
                                                            }}
                                                        />
                                                        <button
                                                            type="button"
                                                            aria-label={t("subwork.promoteNamed", { name: item.name })}
                                                            title={t("subwork.promote")}
                                                            onClick={async () => {
                                                                await runAction(
                                                                    () =>
                                                                        actions.promoteChecklistItemAction(
                                                                            taskId,
                                                                            item.id
                                                                        ),
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
                                                            aria-label={t("subwork.removeNamed", { name: item.name })}
                                                            title={t("subwork.removeStep")}
                                                            onClick={async () => {
                                                                await runAction(
                                                                    () =>
                                                                        actions.deleteChecklistItemAction(
                                                                            taskId,
                                                                            item.id
                                                                        ),
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
                                            placeholder={t("subwork.addStep")}
                                            onAdd={async (name) => {
                                                const result = await runAction(
                                                    () =>
                                                        actions.addChecklistItemAction(
                                                            taskId,
                                                            checklist.id,
                                                            name
                                                        ),
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
    const t = useTranslations("tasksDetail");
    const [query, setQuery] = useState("");
    const [direction, setDirection] = useState<"blocking" | "waitingOn">("waitingOn");
    // Each list is arranged on its own, so a link is only ever dropped inside the
    // list it was picked up from.
    const [dragging, setDragging] = useState<{
        id: string;
        direction: core.DependencyDirection;
    } | null>(null);
    const { shown, apply } = useOverlay(dependencies, onChanged, onError);

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

    const waitingOn = shown.filter((edge) => edge.direction === "waitingOn");
    const blocking = shown.filter((edge) => edge.direction === "blocking");

    const place = (
        edges: readonly DependencyView[],
        edgeId: string,
        side: core.DependencyDirection,
        position: order.DropPosition
    ) => {
        if (order.samePlace(edges, order.placeRow(edges, edgeId, position))) return;
        void apply(order.placeDependency(shown, edgeId, side, position), () =>
            actions.moveDependencyAction(taskId, edgeId, { direction: side, ...position })
        );
    };

    const list = (side: core.DependencyDirection, edges: readonly DependencyView[]) => (
        <ul className="divide-y divide-border rounded-md border border-border">
            {edges.map((edge, index) => (
                <Sortable
                    key={edge.id}
                    id={edge.id}
                    dragging={dragging?.direction === side ? dragging.id : null}
                    disabled={!canEdit}
                    onDragStart={() => setDragging({ id: edge.id, direction: side })}
                    onDragEnd={() => setDragging(null)}
                    onDropAt={(dropped) => {
                        if (!dragging || dragging.direction !== side) return;
                        const moved = dragging.id;
                        setDragging(null);
                        const position = neighbours(edges, edge.id, moved, dropped);
                        if (position) place(edges, moved, side, position);
                    }}
                    className="group flex items-center gap-2 px-3 py-2"
                >
                    {edge.finished ? (
                        <Check className="size-3.5 shrink-0 text-success" />
                    ) : (
                        <Ban className="size-3.5 shrink-0 text-warning" />
                    )}
                    <button
                        type="button"
                        onClick={() => onOpen(edge.taskId)}
                        className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                    >
                        <span className="mr-2 font-mono text-[0.6875rem] text-muted-foreground">
                            {edge.reference}
                        </span>
                        {edge.name}
                    </button>
                    <StatusDot color={edge.statusColor} />
                    {canEdit && (
                        <span className="flex shrink-0 items-center gap-0.5">
                            <span className="flex items-center gap-0.5 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
                                <MoveButtons
                                    name={edge.name}
                                    index={index}
                                    count={edges.length}
                                    onMove={(delta) => {
                                        const position = order.shiftPosition(edges, edge.id, delta);
                                        if (position) place(edges, edge.id, side, position);
                                    }}
                                />
                            </span>
                            <button
                                type="button"
                                aria-label={t("subwork.unlinkNamed", { name: edge.name })}
                                title={t("subwork.removeLink")}
                                onClick={async () => {
                                    await runAction(
                                        () => actions.removeDependencyAction(taskId, edge.id),
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
    );

    return (
        <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">{t("subwork.dependencies")}</h3>

            {shown.length === 0 && (
                <p className="text-xs text-muted-foreground">
                    {t("subwork.dependenciesEmpty")}
                </p>
            )}

            {waitingOn.length > 0 && (
                <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">{t("subwork.waitingOn")}</p>
                    {list("waitingOn", waitingOn)}
                </div>
            )}
            {blocking.length > 0 && (
                <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">{t("subwork.blocking")}</p>
                    {list("blocking", blocking)}
                </div>
            )}

            {canEdit && (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() =>
                                setDirection(direction === "waitingOn" ? "blocking" : "waitingOn")
                            }
                            className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            {direction === "waitingOn" ? t("subwork.thisWaitsOn") : t("subwork.thisBlocks")}
                        </button>
                        <Input
                            value={query}
                            placeholder={t("subwork.find")}
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
                                        <span className="font-mono text-[0.6875rem] text-muted-foreground">
                                            {candidate.reference}
                                        </span>
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
