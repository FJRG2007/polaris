"use client";

/**
 * The task panel: everything about one task, opened over whatever view you were
 * looking at.
 *
 * A dialog rather than a route so the board behind it keeps its scroll position
 * and its filters - opening a card should never cost you your place. Deep links
 * still work: /tasks/t/<id> renders the same panel over the task's own list.
 *
 * Edits are optimistic. A status change repaints the header immediately and
 * rolls back if the write is refused, because waiting a round trip to see a
 * dropdown close is what makes a task manager feel slow.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { CustomFieldEditor } from "./custom-fields";
import type { SpaceContext } from "@/lib/tasks/facts";
import { CopyButton } from "@/components/copy-button";
import type { TaskDetail } from "@/lib/tasks/task-service";
import { useDisplayFormat } from "@/components/display-format";
import { AttachmentSection, CommitSection } from "./task-files";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Bell, BellOff, Copy, Loader2, Repeat, Trash2 } from "lucide-react";
import { ActivitySection, CommentSection, TimeSection } from "./task-conversation";
import { ChecklistSection, DependencySection, SubtaskSection } from "./task-subwork";
import { ConfirmDeleteDialog, Dialog, DialogContent, DialogTitle, Button, Textarea, cn } from "@polaris/ui";
import {
    AssigneePicker,
    AvatarStack,
    DateField,
    DurationField,
    PriorityPicker,
    StatusPicker,
    TagChip,
    TagPicker,
    tagColorFor
} from "./pickers";

/** A labelled row in the properties block. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start gap-3 py-1.5">
            <span className="w-28 shrink-0 pt-1 text-xs text-muted-foreground">{label}</span>
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

export function TaskPanel({
    taskId,
    context,
    onClose,
    onChanged
}: {
    taskId: string | null;
    context: SpaceContext;
    onClose: () => void;
    /** Told after any write, so the view behind can refresh its rows. */
    onChanged: () => void;
}) {
    const format = useDisplayFormat();
    const [detail, setDetail] = useState<TaskDetail | null>(null);
    const [error, setError] = useState("");
    const [openId, setOpenId] = useState<string | null>(taskId);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [loading, startLoading] = useTransition();

    useEffect(() => setOpenId(taskId), [taskId]);

    const load = useCallback(
        (id: string) => {
            startLoading(async () => {
                const result = await runAction(() => actions.getTaskDetailAction(id), setError);
                if (result?.detail) setDetail(result.detail);
                else if (result?.error) setError(result.error);
            });
        },
        []
    );

    useEffect(() => {
        if (!openId) {
            setDetail(null);
            return;
        }
        load(openId);
    }, [openId, load]);

    /** Apply a change locally, then persist it. A refused write reloads the task
     *  rather than leaving the screen showing something that did not happen. */
    const patch = async (input: Record<string, unknown>) => {
        if (!detail || !openId) return;
        setError("");
        const result = await runAction(() => actions.updateTaskAction({ taskId: openId, ...input }), setError);
        if (result?.error) setError(result.error);
        load(openId);
        onChanged();
    };

    const task = detail?.task;
    const watching = detail?.watchers.some((person) => person.id === context.currentUserId) ?? false;
    const runningHere = detail?.timeEntries.some((entry) => entry.running && entry.userId === context.currentUserId) ?? false;

    return (
        <Dialog open={openId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
            {/* max-w has to be set as well as w: DialogContent's own max-w-lg
                caps the width otherwise, and the panel renders at half the size
                its two columns were laid out for. The header keeps clear of the
                dialog's close button rather than sliding under it. */}
            <DialogContent className="flex max-h-[92vh] w-[min(64rem,96vw)] max-w-[min(64rem,96vw)] flex-col gap-0 overflow-hidden p-0">
                {!task && (
                    <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                        {loading ? <Loader2 className="size-5 animate-spin" /> : (error || "Loading the task")}
                    </div>
                )}

                {task && (
                    <>
                        <header className="flex flex-wrap items-center gap-2 border-b border-border py-3 pl-5 pr-14">
                            <span className="font-mono text-xs text-muted-foreground">{task.reference}</span>
                            {/* The same copy control the rest of Polaris uses,
                                acknowledgement included - a reference people
                                quote in chat is a reference they copy. */}
                            <CopyButton value={task.reference} label="the task reference" />
                            {detail?.parent && (
                                <button
                                    type="button"
                                    onClick={() => setOpenId(detail.parent!.id)}
                                    className="truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
                                >
                                    in {detail.parent.name}
                                </button>
                            )}
                            <span className="flex-1" />
                            {task.recurring && (
                                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title="This task repeats">
                                    <Repeat className="size-3.5" /> Repeats
                                </span>
                            )}
                            <button
                                type="button"
                                aria-label={watching ? "Stop watching" : "Watch this task"}
                                title={watching ? "Stop watching" : "Watch this task"}
                                onClick={async () => {
                                    await runAction(() => actions.setWatchingAction(task.id, !watching), setError);
                                    load(task.id);
                                }}
                                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                {watching ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                            </button>
                            {context.canEdit && (
                                <>
                                    <button
                                        type="button"
                                        aria-label="Duplicate task"
                                        title="Duplicate task"
                                        onClick={async () => {
                                            const result = await runAction(
                                                () => actions.duplicateTaskAction(task.id),
                                                setError
                                            );
                                            onChanged();
                                            if (result?.id) setOpenId(result.id);
                                        }}
                                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <Copy className="size-4" />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label="Delete task"
                                        title="Delete task"
                                        onClick={() => setConfirmDelete(true)}
                                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                                    >
                                        <Trash2 className="size-4" />
                                    </button>
                                </>
                            )}
                        </header>

                        {/* Each column scrolls on its own so a long comment
                            thread cannot carry the properties off the screen. */}
                        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_21rem] md:overflow-hidden">
                            <div className="flex flex-col gap-6 p-5 md:overflow-y-auto">
                                <div>
                                    <DialogTitle asChild>
                                        <input
                                            defaultValue={task.name}
                                            disabled={!context.canEdit}
                                            aria-label="Task name"
                                            onBlur={(event) => {
                                                const next = event.target.value.trim();
                                                if (next && next !== task.name) void patch({ name: next });
                                            }}
                                            className="w-full bg-transparent text-lg font-semibold outline-none"
                                        />
                                    </DialogTitle>
                                </div>

                                {error && (
                                    <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                        {error}
                                    </p>
                                )}

                                <section className="flex flex-col gap-1">
                                    <h3 className="text-sm font-medium">Description</h3>
                                    <Textarea
                                        key={task.id}
                                        defaultValue={task.description}
                                        rows={4}
                                        disabled={!context.canEdit}
                                        placeholder="What needs doing, and what does done look like?"
                                        onBlur={(event) => {
                                            if (event.target.value !== task.description) {
                                                void patch({ description: event.target.value });
                                            }
                                        }}
                                    />
                                </section>

                                <AttachmentSection
                                    taskId={task.id}
                                    attachments={detail?.attachments ?? []}
                                    canEdit={context.canEdit}
                                    onChanged={() => load(task.id)}
                                    onError={setError}
                                />

                                <CommitSection
                                    taskId={task.id}
                                    links={detail?.commits ?? []}
                                    canEdit={context.canEdit}
                                    onChanged={() => load(task.id)}
                                    onError={setError}
                                />

                                <SubtaskSection
                                    taskId={task.id}
                                    listId={task.listId}
                                    subtasks={detail?.subtasks ?? []}
                                    statuses={context.statuses}
                                    canEdit={context.canEdit}
                                    onOpen={setOpenId}
                                    onChanged={() => {
                                        load(task.id);
                                        onChanged();
                                    }}
                                    onError={setError}
                                />

                                <ChecklistSection
                                    taskId={task.id}
                                    checklists={detail?.checklists ?? []}
                                    canEdit={context.canEdit}
                                    onChanged={() => load(task.id)}
                                    onError={setError}
                                />

                                <DependencySection
                                    taskId={task.id}
                                    dependencies={detail?.dependencies ?? []}
                                    candidates={context.siblings}
                                    canEdit={context.canEdit}
                                    onOpen={setOpenId}
                                    onChanged={() => load(task.id)}
                                    onError={setError}
                                />

                                <TimeSection
                                    taskId={task.id}
                                    entries={detail?.timeEntries ?? []}
                                    estimate={task.timeEstimate}
                                    timerRunningHere={runningHere}
                                    currentUserId={context.currentUserId}
                                    canModerate={context.canModerate}
                                    onChanged={() => {
                                        load(task.id);
                                        onChanged();
                                    }}
                                    onError={setError}
                                />

                                <CommentSection
                                    taskId={task.id}
                                    comments={detail?.comments ?? []}
                                    currentUserId={context.currentUserId}
                                    canModerate={context.canModerate}
                                    onChanged={() => load(task.id)}
                                    onError={setError}
                                />

                                <ActivitySection activity={detail?.activity ?? []} />
                            </div>

                            <aside className="flex flex-col gap-1 border-t border-border p-5 md:overflow-y-auto md:border-l md:border-t-0">
                                <Field label="Status">
                                    <StatusPicker
                                        statuses={context.statuses}
                                        value={task.statusId}
                                        disabled={!context.canEdit}
                                        spaceId={context.spaceId}
                                        onChange={(statusId) => void patch({ statusId })}
                                    />
                                </Field>
                                <Field label="Assignees">
                                    <div className="flex items-center gap-2">
                                        <AvatarStack people={task.assignees} />
                                        <AssigneePicker
                                            people={context.people}
                                            selected={task.assignees.map((person) => person.id)}
                                            disabled={!context.canEdit}
                                            onChange={(assigneeIds) => void patch({ assigneeIds })}
                                        />
                                    </div>
                                </Field>
                                <Field label="Priority">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs">{core.TASK_PRIORITY_LABELS[task.priority]}</span>
                                        <PriorityPicker
                                            value={task.priority}
                                            disabled={!context.canEdit}
                                            onChange={(priority) => void patch({ priority })}
                                        />
                                    </div>
                                </Field>
                                <Field label="Dates">
                                    <div className="flex flex-col gap-1.5">
                                        <DateField
                                            label="Start date"
                                            value={task.startDate}
                                            timed={task.timed}
                                            disabled={!context.canEdit}
                                            onChange={(startDate) => void patch({ startDate })}
                                        />
                                        <DateField
                                            label="Due date"
                                            value={task.dueDate}
                                            timed={task.timed}
                                            disabled={!context.canEdit}
                                            onChange={(dueDate) => void patch({ dueDate })}
                                        />
                                        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                            <input
                                                type="checkbox"
                                                checked={task.timed}
                                                disabled={!context.canEdit}
                                                onChange={(event) => void patch({ timed: event.target.checked })}
                                            />
                                            Include a time of day
                                        </label>
                                    </div>
                                </Field>
                                <Field label="Estimate">
                                    <DurationField
                                        minutes={task.timeEstimate}
                                        disabled={!context.canEdit}
                                        onChange={(timeEstimate) => void patch({ timeEstimate })}
                                    />
                                </Field>
                                <Field label="Points">
                                    <input
                                        type="number"
                                        min={0}
                                        max={1000}
                                        defaultValue={task.points ?? ""}
                                        disabled={!context.canEdit}
                                        aria-label="Story points"
                                        onBlur={(event) => {
                                            const raw = event.target.value.trim();
                                            const points = raw === "" ? null : Number(raw);
                                            if (points !== task.points) void patch({ points });
                                        }}
                                        className="w-20 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
                                    />
                                </Field>
                                <Field label="Tags">
                                    <div className="flex flex-wrap items-center gap-1">
                                        {task.tags.map((tag) => (
                                            <TagChip
                                                key={tag.id}
                                                tag={tag}
                                                onRemove={
                                                    context.canEdit
                                                        ? () =>
                                                              void patch({
                                                                  tagIds: task.tags
                                                                      .filter((entry) => entry.id !== tag.id)
                                                                      .map((entry) => entry.id)
                                                              })
                                                        : undefined
                                                }
                                            />
                                        ))}
                                        <TagPicker
                                            tags={context.tags}
                                            selected={task.tags.map((tag) => tag.id)}
                                            disabled={!context.canEdit}
                                            onChange={(tagIds) => void patch({ tagIds })}
                                            onCreate={async (name) => {
                                                const created = await runAction(
                                                    () =>
                                                        actions.createTagAction(
                                                            context.spaceId,
                                                            name,
                                                            tagColorFor(name)
                                                        ),
                                                    setError
                                                );
                                                if (created?.id) onChanged();
                                                return created?.id ?? null;
                                            }}
                                        />
                                    </div>
                                </Field>
                                <Field label="Milestone">
                                    <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                        <input
                                            type="checkbox"
                                            checked={task.milestone}
                                            disabled={!context.canEdit}
                                            onChange={(event) => void patch({ milestone: event.target.checked })}
                                        />
                                        Mark as a milestone on the timeline
                                    </label>
                                </Field>

                                {context.fields.length > 0 && (
                                    <div className="mt-2 border-t border-border pt-2">
                                        {context.fields.map((field) => (
                                            <Field key={field.id} label={field.name}>
                                                <CustomFieldEditor
                                                    field={field}
                                                    value={task.customValues[field.id] ?? ""}
                                                    people={context.people}
                                                    disabled={!context.canEdit}
                                                    onChange={async (value) => {
                                                        await runAction(
                                                            () => actions.setCustomValueAction(task.id, field.id, value),
                                                            setError
                                                        );
                                                        load(task.id);
                                                        onChanged();
                                                    }}
                                                />
                                            </Field>
                                        ))}
                                    </div>
                                )}

                                <p className="mt-3 text-[11px] text-muted-foreground">
                                    Created {format.dateTime(task.createdAt)}
                                </p>
                                <div className={cn("flex gap-2", !context.canEdit && "hidden")}>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => void patch({ archived: !task.archived })}
                                    >
                                        {task.archived ? "Unarchive" : "Archive"}
                                    </Button>
                                </div>
                            </aside>
                        </div>

                        <ConfirmDeleteDialog
                            open={confirmDelete}
                            onOpenChange={setConfirmDelete}
                            name={task.name}
                            kind="task"
                            // One row of many, deleted several times a day. Making
                            // somebody retype its name is a toll on the common
                            // case, not a safeguard; that belongs on the things
                            // that hold other people's work.
                            requireTyping={false}
                            description="Comments, checklists and tracked time go with it. Archiving keeps all of that and takes it off the board."
                            confirmLabel="Delete task"
                            onConfirm={async () => {
                                await runAction(() => actions.deleteTaskAction(task.id), setError);
                                setConfirmDelete(false);
                                onChanged();
                                onClose();
                            }}
                        />
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}
