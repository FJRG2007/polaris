"use client";

/**
 * The task panel: everything about one task, opened over whatever view you were
 * looking at.
 *
 * A dialog rather than a route so the board behind it keeps its scroll position
 * and its filters - opening a card should never cost you your place. Deep links
 * still work: /tasks/t/<id> renders the same panel over the task's own list.
 *
 * Two columns, the way every work manager people arrive from lays this out. The
 * left one is the task: what it is, then what it is made of. The right one is
 * its thread, comments and history together, with the box to write in pinned at
 * the bottom - a task is a conversation about a thing, and reading the last
 * thing said should never mean scrolling past sixteen checklist items.
 *
 * Edits are optimistic. A status change repaints the header immediately and
 * rolls back if the write is refused, because waiting a round trip to see a
 * dropdown close is what makes a task manager feel slow.
 */

import * as actions from "./actions";
import { tagColorFor } from "./pickers";
import { ShareDialog } from "./task-share";
import { runAction } from "@/lib/run-action";
import type { SpaceContext } from "@/lib/tasks/facts";
import { CopyButton } from "@/components/copy-button";
import type { TaskDetail } from "@/lib/tasks/task-service";
import { useDisplayFormat } from "@/components/display-format";
import { AttachmentSection, CommitSection } from "./task-files";
import { FieldsSection, PropertyRows } from "./task-properties";
import { ActivityStream, TimeSection } from "./task-conversation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { ChecklistSection, DependencySection, SubtaskSection } from "./task-subwork";
import { Bell, BellOff, Loader2, MoreHorizontal, Repeat, Share2 } from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Textarea,
    keepFocusOnClose
} from "@polaris/ui";

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
    const [sharing, setSharing] = useState(false);
    const [loading, startLoading] = useTransition();

    useEffect(() => setOpenId(taskId), [taskId]);

    const load = useCallback((id: string) => {
        startLoading(async () => {
            const result = await runAction(() => actions.getTaskDetailAction(id), setError);
            if (result?.detail) setDetail(result.detail);
            else if (result?.error) setError(result.error);
        });
    }, []);

    useEffect(() => {
        if (!openId) {
            setDetail(null);
            return;
        }
        load(openId);
    }, [openId, load]);

    /**
     * Commit whatever is typed but not yet blurred.
     *
     * The free-text fields here - the name, the description, a text custom field -
     * save when they lose focus, and a field that still has focus when the panel
     * goes away is torn off the page without ever blurring: no blur event, no save,
     * and the edit is gone. Blurring it first runs exactly the save the reader would
     * have got by clicking somewhere else, whichever field it was.
     */
    const flushEdits = () => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest("[role='dialog']")) active.blur();
    };

    /** Open another task in this same panel, saving what the current one has open. */
    const openTask = (id: string) => {
        flushEdits();
        setOpenId(id);
    };

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
        <Dialog
            open={openId !== null}
            onOpenChange={(open) => {
                if (open) return;
                // Escape and a click outside close the panel with the caret still
                // in a field, so the edit is saved on the way out.
                flushEdits();
                onClose();
            }}
        >
            {/* max-w has to be set as well as w: DialogContent's own max-w-lg
                caps the width otherwise, and the panel renders at half the size
                its two columns were laid out for. The header keeps clear of the
                dialog's close button rather than sliding under it. */}
            <DialogContent className="flex max-h-[92vh] w-[min(72rem,96vw)] max-w-[min(72rem,96vw)] flex-col gap-0 overflow-hidden p-0">
                {!task && (
                    <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
                        {/* The dialog is announced before its content arrives, so
                            it needs a name while it is still loading - otherwise a
                            screen reader opens an unnamed window. */}
                        <DialogTitle className="sr-only">Task</DialogTitle>
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
                                    onClick={() => openTask(detail.parent!.id)}
                                    className="truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
                                >
                                    in {detail.parent.name}
                                </button>
                            )}
                            <span className="flex-1" />
                            <span className="hidden text-[11px] text-muted-foreground sm:inline">
                                Created {format.date(task.createdAt)}
                            </span>
                            {task.recurring && (
                                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" title="This task repeats">
                                    <Repeat className="size-3.5" /> Repeats
                                </span>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setSharing(true)}>
                                <Share2 className="size-4" />
                                Share
                            </Button>
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
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <button
                                            type="button"
                                            aria-label="More actions"
                                            title="More actions"
                                            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                        >
                                            <MoreHorizontal className="size-4" />
                                        </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-52" onCloseAutoFocus={keepFocusOnClose}>
                                        <DropdownMenuItem
                                            onSelect={async () => {
                                                const result = await runAction(
                                                    () => actions.duplicateTaskAction(task.id),
                                                    setError
                                                );
                                                onChanged();
                                                if (result?.id) openTask(result.id);
                                            }}
                                        >
                                            Duplicate
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onSelect={() => void patch({ milestone: !task.milestone })}>
                                            {task.milestone ? "Not a milestone" : "Mark as a milestone"}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem onSelect={() => void patch({ archived: !task.archived })}>
                                            {task.archived ? "Unarchive" : "Archive"}
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                            className="text-destructive"
                                            onSelect={() => setConfirmDelete(true)}
                                        >
                                            Delete
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}
                        </header>

                        {/* Each column scrolls on its own so a long thread cannot
                            carry the properties off the screen. */}
                        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_24rem] md:overflow-hidden">
                            <div className="flex flex-col gap-6 p-5 md:overflow-y-auto">
                                <DialogTitle asChild>
                                    <input
                                        defaultValue={task.name}
                                        key={task.id}
                                        disabled={!context.canEdit}
                                        aria-label="Task name"
                                        onBlur={(event) => {
                                            const next = event.target.value.trim();
                                            if (next && next !== task.name) void patch({ name: next });
                                        }}
                                        className="w-full bg-transparent text-xl font-semibold outline-none"
                                    />
                                </DialogTitle>

                                {error && (
                                    <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                        {error}
                                    </p>
                                )}

                                <PropertyRows
                                    task={task}
                                    context={context}
                                    running={runningHere}
                                    patch={(input) => void patch(input)}
                                    onChanged={() => {
                                        load(task.id);
                                        onChanged();
                                    }}
                                    onError={setError}
                                    onCreateTag={async (name) => {
                                        const created = await runAction(
                                            () => actions.createTagAction(context.spaceId, name, tagColorFor(name)),
                                            setError
                                        );
                                        if (created?.id) onChanged();
                                        return created?.id ?? null;
                                    }}
                                />

                                <section className="flex flex-col gap-1 border-t border-border pt-4">
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

                                <FieldsSection
                                    task={task}
                                    context={context}
                                    onChange={async (fieldId, value) => {
                                        await runAction(
                                            () => actions.setCustomValueAction(task.id, fieldId, value),
                                            setError
                                        );
                                        load(task.id);
                                        onChanged();
                                    }}
                                />

                                <SubtaskSection
                                    taskId={task.id}
                                    listId={task.listId}
                                    subtasks={detail?.subtasks ?? []}
                                    statuses={context.statuses}
                                    canEdit={context.canEdit}
                                    onOpen={openTask}
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
                                    onOpen={openTask}
                                    onChanged={() => load(task.id)}
                                    onError={setError}
                                />

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

                                <TimeSection
                                    taskId={task.id}
                                    entries={detail?.timeEntries ?? []}
                                    estimate={task.timeEstimate}
                                    currentUserId={context.currentUserId}
                                    canModerate={context.canModerate}
                                    onChanged={() => {
                                        load(task.id);
                                        onChanged();
                                    }}
                                    onError={setError}
                                />
                            </div>

                            <aside className="flex min-h-0 flex-col border-t border-border md:border-l md:border-t-0">
                                <ActivityStream
                                    taskId={task.id}
                                    comments={detail?.comments ?? []}
                                    activity={detail?.activity ?? []}
                                    currentUserId={context.currentUserId}
                                    canModerate={context.canModerate}
                                    onChanged={() => load(task.id)}
                                    onError={setError}
                                />
                            </aside>
                        </div>

                        <ShareDialog
                            taskId={task.id}
                            taskName={task.name}
                            people={context.people}
                            currentUserId={context.currentUserId}
                            open={sharing}
                            onOpenChange={setSharing}
                        />

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
