"use client";

/**
 * Creating a task, in the panel it will be read in.
 *
 * The quick-add on a board column stays where it is - typing a name into a
 * column is the fastest way to capture something and should not cost a dialog.
 * This is the other half, and it deliberately looks like the task rather than
 * like a form: the same title, the same property rows, the same description
 * surface, in the same places. Somebody filling this in is already looking at
 * the thing they are making, so there is nothing to re-learn when it opens for
 * real a second later.
 *
 * The draft is a task row held locally, patched by exactly the changes the panel
 * sends to the server - which is what lets the property rows be the same
 * component here as there, rather than a second set that drifts.
 *
 * Only the name and the list are required. Everything a task can hold that needs
 * the task to exist first - its thread, its files, its time - is not offered
 * here and is one click away the moment it is created.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { tagColorFor } from "./pickers";
import { taskOverlay, useLatest } from "./optimistic";
import { runAction } from "@/lib/run-action";
import { useTagCreation } from "./tag-creation";
import { PropertyRows } from "./task-properties";
import { useEffect, useMemo, useState } from "react";
import type { StatusView, TagView } from "@/lib/tasks/space-service";
import { RichTextEditor } from "@/components/rich-text/rich-text-editor";
import type { PersonRef, SpaceContext, TaskRow } from "@/lib/tasks/facts";
import {
    Button,
    Dialog,
    DialogContent,
    DialogTitle,
    Select
} from "@polaris/ui";

/** The draft, in the shape every task screen already draws. */
function blank(
    listId: string,
    status: StatusView | null,
    known: { name: string; dueDate: string | null }
): TaskRow {
    return {
        id: "draft",
        reference: "",
        name: known.name,
        description: "",
        spaceId: "",
        spaceName: "",
        listId,
        listName: "",
        folderName: null,
        parentId: null,
        statusId: status?.id ?? null,
        statusName: status?.name ?? "",
        statusColor: status?.color ?? "",
        statusType: status?.type ?? "open",
        priority: "none",
        assignees: [],
        tags: [],
        createdById: null,
        startDate: null,
        dueDate: known.dueDate,
        timed: false,
        timeEstimate: null,
        points: null,
        milestone: false,
        archived: false,
        order: 0,
        sprintId: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subtaskCount: 0,
        commentCount: 0,
        trackedSeconds: 0,
        blocked: false,
        blockedUntil: null,
        blockedNote: "",
        recurring: false,
        customValues: {}
    };
}

export function TaskCreateDialog({
    open,
    spaceId,
    statuses,
    tags,
    people,
    lists,
    defaultListId,
    defaultStatusId,
    defaultName = "",
    defaultDueDate = null,
    onClose,
    onCreated
}: {
    open: boolean;
    /** The space the vocabulary belongs to, so a tag can be created here. */
    readonly spaceId: string;
    statuses: readonly StatusView[];
    tags: readonly TagView[];
    people: readonly PersonRef[];
    lists: readonly { id: string; name: string }[];
    defaultListId: string;
    /** Pre-selected when the dialog was opened from a particular board column.
     *  Null leaves it unset on purpose, which is what a screen spanning several
     *  spaces has to do: the list decides, once it is chosen. */
    defaultStatusId?: string | null;
    /** What was already typed or clicked elsewhere, so opening this does not
     *  lose it - a name typed into a column, the day picked on a calendar. */
    defaultName?: string;
    defaultDueDate?: string | null;
    onClose: () => void;
    onCreated: (taskId: string) => void;
}) {
    const firstStatusId = defaultStatusId === undefined ? (statuses[0]?.id ?? null) : defaultStatusId;
    const firstStatus = statuses.find((status) => status.id === firstStatusId) ?? null;
    const [draft, setDraft] = useState<TaskRow>(() =>
        blank(defaultListId, firstStatus, { name: defaultName, dueDate: defaultDueDate })
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    // A dialog that reopens holding the last task's details is a dialog that
    // creates the same task twice.
    useEffect(() => {
        if (!open) return;
        setDraft(blank(defaultListId, firstStatus, { name: defaultName, dueDate: defaultDueDate }));
        setError("");
        // The status object is rebuilt on every render; its id is what changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, defaultListId, firstStatusId, defaultName, defaultDueDate]);

    // A tag created here is on the task the moment it exists, so it has to be
    // among the tags this dialog draws against - see `useTagCreation`.
    const tagBook = useTagCreation(spaceId, tags, setError);

    /** What the property rows are drawn against. The space's own fields and the
     *  sibling tasks are left out: neither can be set before the task exists. */
    const context: SpaceContext = useMemo(
        () => ({
            spaceId,
            statuses,
            tags: tagBook.tags,
            fields: [],
            people,
            canEdit: true,
            canModerate: false,
            currentUserId: "",
            siblings: []
        }),
        [spaceId, statuses, tagBook.tags, people]
    );

    // Read at the moment an edit is applied, so a tag created in a picker is
    // already among them by the time the picker hands its id back.
    const directory = useLatest(context);

    /** The same input the panel sends the server, applied to the draft instead. */
    const patch = (input: Record<string, unknown>) =>
        setDraft((current) => ({ ...current, ...taskOverlay(input, tagBook.resolve(directory.current)) }));

    const nameIssue = draft.name.trim() ? core.taskName.safeParse(draft.name).error?.issues[0]?.message : null;
    const canSubmit = draft.name.trim().length > 0 && !nameIssue && Boolean(draft.listId) && !saving;

    const submit = async () => {
        if (!canSubmit) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () =>
                actions.createTaskAction({
                    name: draft.name.trim(),
                    description: draft.description,
                    listId: draft.listId,
                    statusId: draft.statusId,
                    priority: draft.priority,
                    assigneeIds: draft.assignees.map((person) => person.id),
                    tagIds: draft.tags.map((tag) => tag.id),
                    startDate: draft.startDate,
                    dueDate: draft.dueDate,
                    timed: draft.timed,
                    timeEstimate: draft.timeEstimate,
                    points: draft.points,
                    blockedUntil: draft.blockedUntil,
                    blockedNote: draft.blockedNote
                }),
            setError
        );
        setSaving(false);
        if (result?.error) {
            setError(result.error);
            return;
        }
        onClose();
        if (result?.id) onCreated(result.id);
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
            {/* Both widths are set: DialogContent's own max-w-lg would otherwise
                cap this at a third of what the rows were laid out for. */}
            <DialogContent className="flex max-h-[92vh] w-[min(56rem,96vw)] max-w-[min(56rem,96vw)] flex-col gap-0 overflow-hidden p-0">
                <header className="flex flex-wrap items-center gap-2 border-b border-border py-3 pl-5 pr-14">
                    <DialogTitle className="text-sm font-medium">New task</DialogTitle>
                    <span className="text-xs text-muted-foreground">in</span>
                    <Select
                        value={draft.listId}
                        onValueChange={(listId) => setDraft((current) => ({ ...current, listId }))}
                        options={lists.map((list) => ({ value: list.id, label: list.name }))}
                        aria-label="List"
                        className="h-7 w-48 text-xs"
                    />
                </header>

                <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-5">
                    <div className="flex flex-col gap-1">
                        <input
                            autoFocus
                            value={draft.name}
                            aria-label="Task name"
                            placeholder="What needs doing?"
                            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                            onKeyDown={(event) => {
                                // Enter finishes from the name box, which is where
                                // most of these are done.
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    void submit();
                                }
                            }}
                            className="w-full bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground"
                        />
                        {nameIssue && <p className="text-xs text-danger">{nameIssue}</p>}
                    </div>

                    <PropertyRows
                        task={draft}
                        context={context}
                        running={false}
                        waitingOn={0}
                        // Nothing has been tracked against a task that does not
                        // exist, and offering to start a timer on one is a button
                        // that cannot do what it says.
                        timer={false}
                        patch={patch}
                        onChanged={() => undefined}
                        onError={setError}
                        // A tag belongs to one space, so a screen that spans them
                        // all offers finding rather than creating.
                        onCreateTag={(name) => (spaceId ? tagBook.create(name, tagColorFor(name)) : Promise.resolve(null))}
                    />

                    <section className="flex flex-col gap-1 border-t border-border pt-4">
                        <h3 className="text-sm font-medium">Description</h3>
                        <RichTextEditor
                            value={draft.description}
                            placeholder="What does done look like? Type / for a block, @ for somebody, # for a task."
                            onChange={(description) => setDraft((current) => ({ ...current, description }))}
                        />
                    </section>

                    {error && (
                        <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>

                <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        Cancel
                    </Button>
                    <Button onClick={() => void submit()} disabled={!canSubmit}>
                        {saving ? "Creating" : "Create task"}
                    </Button>
                </footer>
            </DialogContent>
        </Dialog>
    );
}
