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
import { useAutosave } from "./autosave";
import { ShareDialog } from "./task-share";
import { runAction } from "@/lib/run-action";
import { TaskNameField } from "./task-name-field";
import { CopyButton } from "@/components/copy-button";
import { HandToAgent } from "./hand-to-agent";
import type { TaskDetail } from "@/lib/tasks/task-service";
import type { SpaceContext, TaskRow } from "@/lib/tasks/facts";
import { useDisplayFormat } from "@/components/display-format";
import { AttachmentSection, CommitSection } from "./task-files";
import { FieldsSection, PropertyRows } from "./task-properties";
import { ActivityStream, TimeSection } from "./task-conversation";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import { settleTagIds, useTagCreation, withCreatedTags } from "./tag-creation";
import { taskOverlay, useLatest, wouldChange, type TaskOverlay } from "./optimistic";
import { ChecklistSection, DependencySection, SubtaskSection } from "./task-subwork";
import { Bell, BellOff, Loader2, MoreHorizontal, Repeat, Share2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
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
    keepFocusOnClose
} from "@polaris/ui";

/**
 * How a write treats the screen.
 *
 * `picker` - a control that repaints on the click: a status, an assignee, a date.
 *   The value is drawn before the server has agreed to it, and the reload afterwards
 *   is what puts it back if the write was refused.
 * `typing` - a keystroke on its way out, held until typing stopped. Nothing is drawn
 *   ahead of it and the view behind is not told, because a round trip and a refresh
 *   per pause is one per sentence.
 * `typed` - the same field, finished with: the caret left it, or the panel is
 *   closing. The view behind is told, so a name that changed changes on the board.
 */
type WriteMode = "picker" | "typing" | "typed";

/** What a change touches, which is what the autosave holds it under: a later
 *  keystroke in the same field replaces the one before it rather than queuing up
 *  behind it. */
function fieldsOf(input: Record<string, unknown>): string {
    return Object.keys(input).sort().join(",");
}

export function TaskPanel({
    taskId,
    context: space,
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
    const auto = useAutosave();
    const [detail, setDetail] = useState<TaskDetail | null>(null);
    const [error, setError] = useState("");

    // A tag made in one of this panel's pickers is put on the task at once, so the
    // panel has to be able to draw it before the space's list has been read again -
    // see `useTagCreation`. `context` below is the space with those tags in it.
    const tagBook = useTagCreation(space.spaceId, space.tags);
    const context = useMemo<SpaceContext>(
        () => ({ ...space, tags: tagBook.tags }),
        [space, tagBook.tags]
    );
    // Read when the edit is applied, not when the picker was drawn - see `useLatest`.
    const directory = useLatest(context);
    const [openId, setOpenId] = useState<string | null>(taskId);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [sharing, setSharing] = useState(false);
    const [loading, startLoading] = useTransition();
    /**
     * The task as the server last confirmed it, which is what an edit is measured
     * against. The screen is often ahead of it - a picker repaints before the write
     * lands, and a field being typed into is ahead of both - and measuring against
     * the screen would make a write the server refused look like one it had taken,
     * so the panel would stop trying to save it.
     */
    const saved = useRef<TaskRow | null>(null);
    /** The task the panel is on now, so an answer for the one it was on a moment ago
     *  is dropped rather than drawn under the new one's id. */
    const wanted = useRef<string | null>(taskId);
    /** A close or a switch is already waiting on the writes; a second Escape must not
     *  start its own. */
    const leaving = useRef(false);
    /** A write was refused on the way out and the panel stayed. The next attempt to
     *  leave asks about abandoning it rather than refusing again. */
    const stuck = useRef(false);
    /** Where the panel was going when it was asked whether to leave the edit behind. */
    const [discarding, setDiscarding] = useState<{ next: string | null } | null>(null);

    useEffect(() => setOpenId(taskId), [taskId]);

    const load = useCallback((id: string) => {
        startLoading(async () => {
            const result = await runAction(() => actions.getTaskDetailAction(id), setError);
            if (wanted.current !== id) return;
            if (result?.detail) {
                saved.current = result.detail.task;
                setDetail(result.detail);
            } else if (result?.error) setError(result.error);
        });
    }, []);

    useEffect(() => {
        wanted.current = openId;
        stuck.current = false;
        if (!openId) {
            saved.current = null;
            setDetail(null);
            return;
        }
        load(openId);
    }, [openId, load]);

    /** Draw a change over the task on screen. */
    const paint = (overlay: TaskOverlay) =>
        setDetail((current) =>
            current ? { ...current, task: { ...current.task, ...overlay } } : current
        );

    /**
     * Persist a change to the open task.
     *
     * Only the fields a change resolves to are drawn; anything the server derives -
     * a completion time, a rollup, the next occurrence of a recurrence - arrives with
     * the reload.
     */
    const commit = async (input: Record<string, unknown>, mode: WriteMode): Promise<boolean> => {
        const task = saved.current;
        if (!task || !openId) return true;
        // A task with no name is not a task. A field halfway through being cleared is
        // not an edit yet, and its blur puts the name the task has back into it.
        if ("name" in input && !input.name) return true;
        if (!wouldChange(input, task)) return true;

        setError("");
        const overlay = taskOverlay(input, withCreatedTags(directory.current));
        // A picker has to repaint on the click: waiting a round trip to see a status
        // move is what makes a task manager feel slow. A field being typed into is
        // already showing what was typed, and drawing over it takes the caret with it.
        if (mode === "picker") paint(overlay);

        // A tag the picker invented an id for becomes a real one on the way out.
        const written = Array.isArray(input.tagIds)
            ? { ...input, tagIds: await settleTagIds(input.tagIds as readonly string[]) }
            : input;
        const result = await runAction(
            () => actions.updateTaskAction({ taskId: openId, ...written }),
            setError
        );
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            // The screen is showing something the server did not take. A picker is put
            // back by the reload; a typed field keeps what was typed and stays an
            // unsaved edit, so the next pause - or the panel closing - sends it again
            // instead of closing over it.
            if (mode === "picker") load(openId);
            return false;
        }

        saved.current = { ...task, ...overlay };
        if (mode === "picker") {
            load(openId);
            onChanged();
            return true;
        }
        paint(overlay);
        // A write made while somebody is still typing stays quiet: reloading the task
        // and the view behind it on every pause is a round trip per sentence.
        if (mode === "typing") return true;
        // Finished with, so the thread catches up - unless the panel is on its way
        // out, where the answer would arrive at a screen that has gone.
        if (!leaving.current) load(openId);
        onChanged();
        return true;
    };

    /** One of the space's own fields, which is stored beside the task rather than on
     *  it and so takes a write of its own. */
    const commitField = async (
        fieldId: string,
        value: string,
        settled: boolean
    ): Promise<boolean> => {
        const task = saved.current;
        if (!task || !openId) return true;

        let row = task;
        if ((task.customValues[fieldId] ?? "") !== value) {
            setError("");
            const result = await runAction(
                () => actions.setCustomValueAction(openId, fieldId, value),
                setError
            );
            if (!result || result.error) {
                if (result?.error) setError(result.error);
                return false;
            }
            row = { ...task, customValues: { ...task.customValues, [fieldId]: value } };
            saved.current = row;
        }

        // Not drawn while it is still being typed into. The box already shows what
        // was typed, and repainting it is what reshuffles the fields around the one
        // holding the caret. The keystroke that stopped is the one that draws.
        if (!settled) return true;
        paint({ customValues: row.customValues });
        if (!leaving.current) load(openId);
        onChanged();
        return true;
    };

    /** Write a change now, the way a control that repaints on the click does. */
    const patch = (input: Record<string, unknown>) =>
        auto.save(fieldsOf(input), () => commit(input, "picker"));

    /** Hold a keystroke, and write it once typing stops. */
    const hold = (input: Record<string, unknown>) =>
        auto.queue(fieldsOf(input), () => commit(input, "typing"));

    /** Write what was typed now: the caret left the field, or the panel is closing. */
    const save = (input: Record<string, unknown>) =>
        auto.save(fieldsOf(input), () => commit(input, "typed"));

    /**
     * Turn the lines somebody selected into subtasks.
     *
     * Written in order and one at a time, because the order is the point - a list
     * of steps pasted in as three parallel writes comes back in whichever order
     * the database finished them. Answers false if any of them was refused, and
     * the editor then leaves the list where it is: a list deleted after a failed
     * write is work that no longer exists anywhere.
     */
    const toSubtasks = async (parentId: string, listId: string, items: readonly string[]) => {
        setError("");
        for (const name of items) {
            const result = await runAction(
                () => actions.createTaskAction({ listId, name, parentId }),
                setError
            );
            if (!result || result.error) {
                if (result?.error) setError(result.error);
                load(parentId);
                return false;
            }
        }
        load(parentId);
        return true;
    };

    /**
     * Commit whatever has focus but has not been committed.
     *
     * Every field here either holds what is typed into it or saves when it loses
     * focus, and the second kind is torn off the page without ever blurring when the
     * panel goes away. Blurring it first runs exactly the save the reader would have
     * got by clicking somewhere else, whichever field it was.
     */
    const blurEdits = () => {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest("[role='dialog']")) active.blur();
    };

    /**
     * Send everything held and wait for it, before the panel shows something else.
     *
     * This is where an edit is lost: somebody writes a description and reaches
     * straight for the close button, a keystroke ahead of the save. A refused write
     * answers `refused` and the panel stays where it is, with the text still in it
     * and the reason on the screen - going away anyway would be losing it quietly,
     * which is worse than not going away at all.
     *
     * `waiting` is a second Escape on a close already under way, and it is not a
     * refusal: nothing about the edit has been answered yet.
     */
    const settle = async (): Promise<"kept" | "refused" | "waiting"> => {
        if (leaving.current) return "waiting";
        leaving.current = true;
        try {
            blurEdits();
            return (await auto.flush()) ? "kept" : "refused";
        } finally {
            // A blur handler that throws, or a write that throws where it should have
            // answered, would otherwise latch this and the panel could never be closed
            // or switched again.
            leaving.current = false;
        }
    };

    /**
     * Take the panel where it was going, once what is held has been written.
     *
     * A refusal holds it the first time and says why. The second attempt is somebody
     * telling us the first answer was read and they still want out, so that one
     * offers to leave the edit behind: a write the server will not take - a lost
     * connection as much as a rejected value - would otherwise trap the panel for the
     * rest of the session, with no way to close it and no way to abandon it.
     */
    const leave = async (next: string | null) => {
        const outcome = await settle();
        if (outcome === "kept") {
            stuck.current = false;
            if (next === null) onClose();
            else setOpenId(next);
            return;
        }
        if (outcome !== "refused") return;
        if (stuck.current) setDiscarding({ next });
        else stuck.current = true;
    };

    /** Open another task in this same panel, keeping what the current one has open. */
    const openTask = (id: string) => leave(id);

    /** A tag born where it is needed - in a picker or a menu - instead of in the
     *  space's settings, which is where the reason for it gets forgotten. It is on
     *  the task before the server has answered; the write that follows is what
     *  turns its id into a real one. */
    const createTag = (name: string, color: string) => tagBook.create(name, color);

    const task = detail?.task;
    const watching =
        detail?.watchers.some((person) => person.id === context.currentUserId) ?? false;
    const runningHere =
        detail?.timeEntries.some(
            (entry) => entry.running && entry.userId === context.currentUserId
        ) ?? false;

    return (
        <Dialog
            open={openId !== null}
            onOpenChange={(open) => {
                if (open) return;
                // Escape, the close button and a click outside all pull the panel
                // away with the caret still in a field. The dialog is controlled, so
                // it goes nowhere until what was typed has been written and taken.
                void leave(null);
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
                        {loading ? (
                            <Loader2 className="size-5 animate-spin" />
                        ) : (
                            error || "Loading the task"
                        )}
                    </div>
                )}

                {task && (
                    <>
                        <header className="flex flex-wrap items-center gap-2 border-b border-border py-3 pl-5 pr-14">
                            <span className="font-mono text-xs text-muted-foreground">
                                {task.reference}
                            </span>
                            {/* The same copy control the rest of Polaris uses,
                                acknowledgement included - a reference people
                                quote in chat is a reference they copy. */}
                            <CopyButton value={task.reference} label="the task reference" />
                            {detail?.parent && (
                                <button
                                    type="button"
                                    onClick={() => void openTask(detail.parent!.id)}
                                    className="min-w-0 truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
                                >
                                    in {detail.parent.name}
                                </button>
                            )}
                            {/* The actions are a group of their own rather than a
                                spacer and a run of siblings: on a phone the row
                                wraps, and a spacer that wrapped with them left them
                                floating in the middle of the second line. */}
                            <div className="ml-auto flex items-center gap-2">
                                {/* Somebody who typed something and reached for the close
                                    button is owed an answer about where it went, and this
                                    is also what the panel is waiting on before it goes. */}
                                {auto.busy && !error && (
                                    <span
                                        role="status"
                                        className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground"
                                    >
                                        <Loader2
                                            className="size-3.5 shrink-0 animate-spin"
                                            aria-hidden="true"
                                        />
                                        Saving
                                    </span>
                                )}
                                <span className="hidden text-[0.6875rem] text-muted-foreground sm:inline">
                                    Created {format.date(task.createdAt)}
                                </span>
                                {task.recurring && (
                                    <span
                                        className="inline-flex items-center gap-1 text-[0.6875rem] text-muted-foreground"
                                        title="This task repeats"
                                        aria-label="This task repeats"
                                    >
                                        <Repeat className="size-3.5" />
                                        <span className="hidden sm:inline">Repeats</span>
                                    </span>
                                )}
                                {/* Icon-only on a phone, the way every other toolbar
                                    here narrows: the row already carries four controls
                                    and the reference beside them. */}
                                {/* Handing the work to an agent belongs next to
                                    handing it to a person: a task already says what
                                    needs doing, and retyping it into an agent is
                                    transcription. */}
                                <HandToAgent
                                    taskId={task.id}
                                    reference={task.reference}
                                    name={task.name}
                                    description={task.description}
                                />
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    title="Share"
                                    aria-label="Share"
                                    onClick={() => setSharing(true)}
                                >
                                    <Share2 className="size-4" />
                                    <span className="hidden sm:inline">Share</span>
                                </Button>
                                <button
                                    type="button"
                                    aria-label={watching ? "Stop watching" : "Watch this task"}
                                    title={watching ? "Stop watching" : "Watch this task"}
                                    onClick={async () => {
                                        await runAction(
                                            () => actions.setWatchingAction(task.id, !watching),
                                            setError
                                        );
                                        load(task.id);
                                    }}
                                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                    {watching ? (
                                        <Bell className="size-4" />
                                    ) : (
                                        <BellOff className="size-4" />
                                    )}
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
                                        <DropdownMenuContent
                                            align="end"
                                            className="w-52"
                                            onCloseAutoFocus={keepFocusOnClose}
                                        >
                                            <DropdownMenuItem
                                                onSelect={async () => {
                                                    const result = await runAction(
                                                        () => actions.duplicateTaskAction(task.id),
                                                        setError
                                                    );
                                                    onChanged();
                                                    if (result?.id) void openTask(result.id);
                                                }}
                                            >
                                                Duplicate
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onSelect={() =>
                                                    void patch({ milestone: !task.milestone })
                                                }
                                            >
                                                {task.milestone
                                                    ? "Not a milestone"
                                                    : "Mark as a milestone"}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onSelect={() =>
                                                    void patch({ archived: !task.archived })
                                                }
                                            >
                                                {task.archived ? "Unarchive" : "Archive"}
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                variant="danger"
                                                onSelect={() => setConfirmDelete(true)}
                                            >
                                                Delete
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                )}
                            </div>
                        </header>

                        {/* Each column scrolls on its own so a long thread cannot
                            carry the properties off the screen. */}
                        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_24rem] md:overflow-hidden">
                            <div className="flex flex-col gap-6 p-5 md:overflow-y-auto">
                                <DialogTitle asChild>
                                    <TaskNameField
                                        defaultValue={task.name}
                                        key={task.id}
                                        disabled={!context.canEdit}
                                        aria-label="Task name"
                                        // Held while it is being typed and written
                                        // once typing stops, so a name only ever
                                        // exists on the screen for a moment.
                                        onChange={(event) =>
                                            hold({ name: event.target.value.trim() })
                                        }
                                        onEnter={(element) => element.blur()}
                                        onBlur={(event) => {
                                            const next = event.target.value.trim();
                                            // A task cannot be nameless: an emptied
                                            // field goes back to the name the task
                                            // still has rather than leaving a blank
                                            // heading over it.
                                            if (next) void save({ name: next });
                                            else event.target.value = task.name;
                                        }}
                                    />
                                </DialogTitle>

                                {error && (
                                    <p
                                        role="alert"
                                        className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
                                    >
                                        {error}
                                    </p>
                                )}

                                <PropertyRows
                                    task={task}
                                    context={context}
                                    running={runningHere}
                                    waitingOn={
                                        detail?.dependencies.filter(
                                            (edge) =>
                                                edge.direction === "waitingOn" && !edge.finished
                                        ).length ?? 0
                                    }
                                    patch={(input) => void patch(input)}
                                    hold={hold}
                                    onChanged={() => {
                                        load(task.id);
                                        onChanged();
                                    }}
                                    onError={setError}
                                    onCreateTag={(name) => createTag(name, tagColorFor(name))}
                                />

                                <section className="flex flex-col gap-1 border-t border-border pt-4">
                                    <h3 className="text-sm font-medium">Description</h3>
                                    <RichTextEditor
                                        key={task.id}
                                        value={task.description}
                                        disabled={!context.canEdit}
                                        placeholder="What needs doing, and what does done look like? Type / for a block, @ for somebody, # for a task."
                                        // Held while it is being written and saved
                                        // once writing stops, the way every other
                                        // free-text field here is. This is the one
                                        // people lose work in: a paragraph typed and
                                        // the panel closed on the same breath.
                                        onChange={(description) => hold({ description })}
                                        onBlur={(description) => void save({ description })}
                                        // A list in a description is work written
                                        // as prose. Selecting it and choosing this
                                        // makes each line a subtask and takes the
                                        // list out of the text - which is the one
                                        // thing somebody was going to do by hand.
                                        listAction={
                                            context.canEdit
                                                ? {
                                                      label: "Move to subtasks",
                                                      run: (items) =>
                                                          toSubtasks(task.id, task.listId, items)
                                                  }
                                                : undefined
                                        }
                                    />
                                </section>

                                <FieldsSection
                                    task={task}
                                    context={context}
                                    hold={(fieldId, value) =>
                                        auto.queue(`field:${fieldId}`, () =>
                                            commitField(fieldId, value, false)
                                        )
                                    }
                                    onChange={(fieldId, value) =>
                                        void auto.save(`field:${fieldId}`, () =>
                                            commitField(fieldId, value, true)
                                        )
                                    }
                                />

                                <SubtaskSection
                                    taskId={task.id}
                                    listId={task.listId}
                                    subtasks={detail?.subtasks ?? []}
                                    context={context}
                                    onOpen={openTask}
                                    onChanged={() => {
                                        load(task.id);
                                        onChanged();
                                    }}
                                    onError={setError}
                                    onCreateTag={createTag}
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
                            open={discarding !== null}
                            onOpenChange={(open) => !open && setDiscarding(null)}
                            name={task.name}
                            kind="change"
                            requireTyping={false}
                            title="Leave the change behind?"
                            description={error || "The last change could not be saved."}
                            question="Everything else stays as it was saved. What is still in the boxes goes."
                            confirmLabel="Leave it behind"
                            onConfirm={() => {
                                const next = discarding?.next ?? null;
                                auto.discard();
                                stuck.current = false;
                                setDiscarding(null);
                                setError("");
                                if (next === null) onClose();
                                else setOpenId(next);
                            }}
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
