"use client";

/**
 * Creating a task, properly.
 *
 * The quick-add on a board column stays where it is - typing a name into a
 * column is the fastest way to capture something and should not cost a dialog.
 * This is the other half: the task you already know the shape of, where filling
 * in the list, the owner and the date now beats opening the card afterwards to
 * do it in four separate writes.
 *
 * Everything is optional except the name and the list, and the form validates
 * against the same schema the server does, so a refusal shows on the field
 * rather than as a sentence at the bottom after a round trip.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import type { PersonRef } from "@/lib/tasks/facts";
import type { StatusView, TagView } from "@/lib/tasks/space-service";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Textarea
} from "@polaris/ui";
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

interface Fields {
    name: string;
    description: string;
    listId: string;
    statusId: string | null;
    priority: core.TaskPriority;
    assigneeIds: string[];
    tagIds: string[];
    startDate: string | null;
    dueDate: string | null;
    timed: boolean;
    timeEstimate: number | null;
    points: number | null;
}

function blank(listId: string, statusId: string | null): Fields {
    return {
        name: "",
        description: "",
        listId,
        statusId,
        priority: "none",
        assigneeIds: [],
        tagIds: [],
        startDate: null,
        dueDate: null,
        timed: false,
        timeEstimate: null,
        points: null
    };
}

/** A labelled row. The label column is fixed so the controls line up down the
 *  panel instead of stepping in and out with the length of each word. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-start gap-3">
            <span className="w-24 shrink-0 pt-1.5 text-xs text-muted-foreground">{label}</span>
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
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
    /** Pre-selected when the dialog was opened from a particular board column. */
    defaultStatusId?: string | null;
    onClose: () => void;
    onCreated: (taskId: string) => void;
}) {
    const firstStatus = defaultStatusId ?? statuses[0]?.id ?? null;
    const [fields, setFields] = useState<Fields>(() => blank(defaultListId, firstStatus));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    // A dialog that reopens holding the last task's details is a dialog that
    // creates the same task twice.
    useEffect(() => {
        if (open) {
            setFields(blank(defaultListId, firstStatus));
            setError("");
        }
    }, [open, defaultListId, firstStatus]);

    const set = <Key extends keyof Fields>(key: Key, value: Fields[Key]) =>
        setFields((current) => ({ ...current, [key]: value }));

    const nameIssue = fields.name.trim() ? core.taskName.safeParse(fields.name).error?.issues[0]?.message : null;
    const canSubmit = fields.name.trim().length > 0 && !nameIssue && !saving;

    const submit = async () => {
        if (!canSubmit) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () =>
                actions.createTaskAction({
                    ...fields,
                    name: fields.name.trim(),
                    description: fields.description.trim()
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
            <DialogContent className="flex max-h-[90vh] w-[min(46rem,95vw)] max-w-[min(46rem,95vw)] flex-col gap-0 overflow-hidden p-0">
                <DialogHeader className="mb-0 border-b border-border py-3 pl-5 pr-14">
                    <DialogTitle>New task</DialogTitle>
                    <DialogDescription>
                        Only a name is required. Anything left blank can be filled in on the task itself.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
                    <div className="flex flex-col gap-1">
                        <Input
                            autoFocus
                            value={fields.name}
                            aria-label="Task name"
                            placeholder="What needs doing?"
                            onChange={(event) => set("name", event.target.value)}
                            onKeyDown={(event) => {
                                // Enter submits from the name box, which is where
                                // most of these are finished.
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    void submit();
                                }
                            }}
                            className="h-10 text-base"
                        />
                        {nameIssue && <p className="text-xs text-danger">{nameIssue}</p>}
                    </div>

                    <Textarea
                        rows={3}
                        value={fields.description}
                        aria-label="Description"
                        placeholder="What does done look like?"
                        onChange={(event) => set("description", event.target.value)}
                    />

                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="List">
                            <Select
                                value={fields.listId}
                                onValueChange={(value) => set("listId", value)}
                                options={lists.map((list) => ({ value: list.id, label: list.name }))}
                                aria-label="List"
                                className="h-9 w-full"
                            />
                        </Field>
                        <Field label="Status">
                            <StatusPicker
                                statuses={statuses}
                                value={fields.statusId}
                                onChange={(statusId) => set("statusId", statusId)}
                            />
                        </Field>
                        <Field label="Assignees">
                            <div className="flex items-center gap-2">
                                <AvatarStack
                                    people={people.filter((person) => fields.assigneeIds.includes(person.id))}
                                />
                                <AssigneePicker
                                    people={people}
                                    selected={fields.assigneeIds}
                                    onChange={(ids) => set("assigneeIds", ids)}
                                />
                            </div>
                        </Field>
                        <Field label="Priority">
                            <div className="flex items-center gap-2">
                                <span className="text-xs">{core.TASK_PRIORITY_LABELS[fields.priority]}</span>
                                <PriorityPicker value={fields.priority} onChange={(priority) => set("priority", priority)} />
                            </div>
                        </Field>
                        <Field label="Start">
                            <DateField
                                label="Start date"
                                value={fields.startDate}
                                timed={fields.timed}
                                onChange={(startDate) => set("startDate", startDate)}
                            />
                        </Field>
                        <Field label="Due">
                            <div className="flex flex-col gap-1.5">
                                <DateField
                                    label="Due date"
                                    value={fields.dueDate}
                                    timed={fields.timed}
                                    onChange={(dueDate) => set("dueDate", dueDate)}
                                />
                                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                    <input
                                        type="checkbox"
                                        checked={fields.timed}
                                        onChange={(event) => set("timed", event.target.checked)}
                                    />
                                    Include a time of day
                                </label>
                            </div>
                        </Field>
                        <Field label="Estimate">
                            <DurationField
                                minutes={fields.timeEstimate}
                                onChange={(minutes) => set("timeEstimate", minutes)}
                            />
                        </Field>
                        <Field label="Points">
                            <input
                                type="number"
                                min={0}
                                max={1000}
                                value={fields.points ?? ""}
                                aria-label="Story points"
                                onChange={(event) =>
                                    set("points", event.target.value === "" ? null : Number(event.target.value))
                                }
                                className="w-24 rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
                            />
                        </Field>
                    </div>

                    <Field label="Tags">
                        <div className="flex flex-wrap items-center gap-1">
                            {tags
                                .filter((tag) => fields.tagIds.includes(tag.id))
                                .map((tag) => (
                                    <TagChip
                                        key={tag.id}
                                        tag={tag}
                                        onRemove={() =>
                                            set(
                                                "tagIds",
                                                fields.tagIds.filter((id) => id !== tag.id)
                                            )
                                        }
                                    />
                                ))}
                            <TagPicker
                                tags={tags}
                                selected={fields.tagIds}
                                onChange={(tagIds) => set("tagIds", tagIds)}
                                // A tag that does not exist yet is created here
                                // rather than sending somebody to the settings
                                // and back with the form half filled in.
                                onCreate={async (name) => {
                                    const created = await runAction(
                                        () => actions.createTagAction(spaceId, name, tagColorFor(name)),
                                        setError
                                    );
                                    return created?.id ?? null;
                                }}
                            />
                        </div>
                    </Field>

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
