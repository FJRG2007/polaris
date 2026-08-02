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

import { useState } from "react";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import type { TaskRow } from "@/lib/tasks/facts";
import { AvatarStack, ProgressBar, StatusDot } from "./pickers";
import { Button, Card, CardBody, Checkbox, cn, Input } from "@polaris/ui";
import type { ChecklistView, DependencyView } from "@/lib/tasks/task-service";
import { ArrowUpRight, Ban, Check, Link2, Plus, Trash2, X } from "lucide-react";

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
    canEdit,
    onOpen,
    onChanged,
    onError
}: {
    taskId: string;
    listId: string;
    subtasks: readonly TaskRow[];
    canEdit: boolean;
    onOpen: (taskId: string) => void;
    onChanged: () => void;
    onError: (message: string) => void;
}) {
    const progress = core.rollupProgress(subtasks.map((task) => ({ statusType: task.statusType })));

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
                    <li key={subtask.id} className="flex items-center gap-2 px-3 py-2">
                        <Checkbox
                            checked={core.isFinishedStatus(subtask.statusType)}
                            disabled={!canEdit}
                            aria-label={`Complete ${subtask.name}`}
                            onChange={async () => {
                                onError("");
                                await runAction(
                                    () => actions.updateTaskAction({ taskId: subtask.id, archived: false }),
                                    onError
                                );
                                onChanged();
                            }}
                        />
                        <button
                            type="button"
                            onClick={() => onOpen(subtask.id)}
                            className="flex-1 truncate text-left text-sm hover:underline"
                        >
                            <span className="mr-2 font-mono text-[11px] text-muted-foreground">{subtask.reference}</span>
                            <span className={cn(core.isFinishedStatus(subtask.statusType) && "text-muted-foreground line-through")}>
                                {subtask.name}
                            </span>
                        </button>
                        <StatusDot color={subtask.statusColor} />
                        <AvatarStack people={subtask.assignees} size={20} />
                    </li>
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
                        onChanged();
                    }}
                />
            )}
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

            {checklists.map((checklist) => {
                const done = checklist.items.filter((item) => item.done).length;
                return (
                    <Card key={checklist.id}>
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
                                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                                        >
                                            <Trash2 className="size-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                            {checklist.items.length > 0 && (
                                <ProgressBar percent={Math.round((done / checklist.items.length) * 100)} />
                            )}

                            <ul className="flex flex-col gap-1">
                                {checklist.items.map((item) => (
                                    <li key={item.id} className="group flex items-center gap-2">
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
                                        <span className={cn("flex-1 text-sm", item.done && "text-muted-foreground line-through")}>
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
                                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                                                >
                                                    <X className="size-3.5" />
                                                </button>
                                            </span>
                                        )}
                                    </li>
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
                );
            })}
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
                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
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
