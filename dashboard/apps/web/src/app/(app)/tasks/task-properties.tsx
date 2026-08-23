"use client";

/**
 * What a task is, as a block of labelled rows at the top of the panel.
 *
 * The order is the one people read in: what state is it in, who has it, when is
 * it due, how urgent, how big, how long has it taken, what is it about. Anything
 * the space itself added comes underneath in its own block, because a workspace
 * with fifteen custom fields must not push the description off the screen - and
 * the empty ones fold away, since a column of dashes is not information.
 */

import { useState } from "react";
import * as pickers from "./pickers";
import * as core from "@polaris/core";
import type { TaskRow } from "@/lib/tasks/facts";
import { AvatarStack } from "@/components/avatar";
import { TimerControl } from "./task-conversation";
import { CustomFieldEditor } from "./custom-fields";
import type { SpaceContext } from "@/lib/tasks/facts";
import {
    Ban,
    CalendarDays,
    ChevronDown,
    ChevronRight,
    CircleDot,
    Signal,
    Hourglass,
    Tag,
    Target,
    Timer,
    UserRound
} from "lucide-react";

/**
 * A labelled row. The icon column is what makes eight rows scannable rather
 * than a wall of grey labels.
 *
 * On a phone the label goes above the value instead of beside it: a fixed
 * eight-rem column takes a third of the width there, and what is left cannot
 * hold two date boxes - the due date used to sit off the edge of the panel with
 * nothing to scroll it back. The value wraps at every width for the same reason.
 */
export function Property({
    icon,
    label,
    children
}: {
    icon: React.ReactNode;
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-start sm:gap-3">
            <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground sm:w-32 sm:pt-1.5">
                <span className="shrink-0 opacity-70">{icon}</span>
                {label}
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
        </div>
    );
}

export function PropertyRows({
    task,
    context,
    running,
    waitingOn,
    timer = true,
    patch,
    hold,
    onChanged,
    onError,
    onCreateTag
}: {
    task: TaskRow;
    context: SpaceContext;
    /** This account has a timer going on this task. */
    running: boolean;
    /** Off while a task is still being drafted: there is nothing to track time
     *  against until it exists. */
    timer?: boolean;
    /** Unfinished tasks this one waits on. Counted rather than listed, since the
     *  list of them is a few rows down under Dependencies. */
    waitingOn: number;
    patch: (input: Record<string, unknown>) => void;
    /** Hold what is being typed into the two fields here that take words rather than
     *  a choice, so it is saved without waiting for the caret to leave. Absent while
     *  a task is still being drafted: there is nothing to save it to yet. */
    hold?: (input: Record<string, unknown>) => void;
    onChanged: () => void;
    onError: (message: string) => void;
    /** Makes a tag that does not exist yet and returns its id. */
    onCreateTag: (name: string) => Promise<string | null>;
}) {
    const disabled = !context.canEdit;

    return (
        <div className="flex flex-col">
            <Property icon={<CircleDot className="size-3.5" />} label="Status">
                <pickers.StatusPicker
                    statuses={context.statuses}
                    value={task.statusId}
                    disabled={disabled}
                    spaceId={context.spaceId}
                    onChange={(statusId) => patch({ statusId })}
                />
            </Property>

            <Property icon={<UserRound className="size-3.5" />} label="Assignees">
                <AvatarStack people={task.assignees} />
                <pickers.AssigneePicker
                    people={context.people}
                    selected={task.assignees.map((person) => person.id)}
                    disabled={disabled}
                    onChange={(assigneeIds) => patch({ assigneeIds })}
                />
                {task.assignees.length === 0 && (
                    <span className="text-xs text-muted-foreground">Nobody yet</span>
                )}
            </Property>

            <Property icon={<CalendarDays className="size-3.5" />} label="Dates">
                <pickers.DateField
                    label="Start date"
                    value={task.startDate}
                    timed={task.timed}
                    disabled={disabled}
                    onChange={(startDate) => patch({ startDate })}
                />
                {/* It reads as a range only while both boxes are on one line; once
                    they stack it is a dash hanging off the end of the first. */}
                <span aria-hidden className="hidden text-xs text-muted-foreground sm:inline">
                    -
                </span>
                <pickers.DateField
                    label="Due date"
                    value={task.dueDate}
                    timed={task.timed}
                    disabled={disabled}
                    onChange={(dueDate) => patch({ dueDate })}
                />
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <input
                        type="checkbox"
                        checked={task.timed}
                        disabled={disabled}
                        onChange={(event) => patch({ timed: event.target.checked })}
                    />
                    Time of day
                </label>
            </Property>

            <Property icon={<Signal className="size-3.5" />} label="Priority">
                {/* The flag and the word are one control: pointing at "Normal"
                    and having nothing happen is the kind of small lie that makes
                    a panel feel unfinished. */}
                <pickers.PriorityPicker
                    value={task.priority}
                    disabled={disabled}
                    onChange={(priority) => patch({ priority })}
                    trigger={
                        <button
                            type="button"
                            aria-label="Priority"
                            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted"
                        >
                            <pickers.PriorityMark priority={task.priority} />
                            {core.TASK_PRIORITY_LABELS[task.priority]}
                        </button>
                    }
                />
            </Property>

            {/* Three things hold work up, and they are recorded in two places
                because only two of them are facts about this task. A blocking
                task is an edge, so it is added under Dependencies and only
                counted here; a date and a reason belong to the task and are
                edited where they are read. */}
            <Property icon={<Ban className="size-3.5" />} label="Blocked">
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <pickers.DateField
                        label="Blocked until"
                        value={task.blockedUntil}
                        timed={false}
                        disabled={disabled}
                        onChange={(blockedUntil) => patch({ blockedUntil })}
                    />
                    <input
                        key={`${task.id}-blocked-note`}
                        defaultValue={task.blockedNote}
                        disabled={disabled}
                        maxLength={200}
                        aria-label="Why this is blocked"
                        placeholder="Why, if it is not a task or a date"
                        onChange={(event) => hold?.({ blockedNote: event.target.value.trim() })}
                        onBlur={(event) => patch({ blockedNote: event.target.value.trim() })}
                        // A floor under it, so a narrow row wraps the box onto its
                        // own line rather than squeezing it down to two letters.
                        className="min-w-[12rem] flex-1 rounded-md border border-border bg-field px-2 py-1 text-xs hover:border-border-strong focus:border-border-strong disabled:opacity-50"
                    />
                    {waitingOn > 0 && (
                        <span className="text-[11px] text-amber-600">
                            Waiting on {waitingOn} unfinished {waitingOn === 1 ? "task" : "tasks"}
                        </span>
                    )}
                </span>
            </Property>

            <Property icon={<Target className="size-3.5" />} label="Points">
                <input
                    type="number"
                    min={0}
                    max={1000}
                    key={`${task.id}-points`}
                    defaultValue={task.points ?? ""}
                    disabled={disabled}
                    aria-label="Story points"
                    placeholder="Empty"
                    onChange={(event) => hold?.({ points: pointsOf(event.target.value) })}
                    onBlur={(event) => patch({ points: pointsOf(event.target.value) })}
                    className="w-20 rounded-md border border-border bg-field px-2 py-1 text-xs hover:border-border-strong focus:border-border-strong"
                />
            </Property>

            <Property icon={<Hourglass className="size-3.5" />} label="Estimate">
                <pickers.DurationField
                    minutes={task.timeEstimate}
                    disabled={disabled}
                    onChange={(timeEstimate) => patch({ timeEstimate })}
                />
            </Property>

            {timer && (
                <Property icon={<Timer className="size-3.5" />} label="Track time">
                    <TimerControl
                        taskId={task.id}
                        trackedSeconds={task.trackedSeconds}
                        running={running}
                        onChanged={onChanged}
                        onError={onError}
                    />
                </Property>
            )}

            <Property icon={<Tag className="size-3.5" />} label="Tags">
                <span className="flex flex-wrap items-center gap-1">
                    {task.tags.map((tag) => (
                        <pickers.TagChip
                            key={tag.id}
                            tag={tag}
                            onRemove={
                                disabled
                                    ? undefined
                                    : () =>
                                          patch({
                                              tagIds: task.tags
                                                  .filter((entry) => entry.id !== tag.id)
                                                  .map((entry) => entry.id)
                                          })
                            }
                        />
                    ))}
                    <pickers.TagPicker
                        tags={context.tags}
                        spaceId={context.spaceId}
                        selected={task.tags.map((tag) => tag.id)}
                        disabled={disabled}
                        onChange={(tagIds) => patch({ tagIds })}
                        onCreate={onCreateTag}
                    />
                </span>
            </Property>
        </div>
    );
}

/** An empty box means the task has not been sized, not that it is worth nothing. */
function pointsOf(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const points = Number(trimmed);
    return Number.isNaN(points) ? null : points;
}

/**
 * The space's own fields. Collapsed empties: a field nobody filled in says
 * nothing, and hiding it is what keeps this block from burying the work.
 */
export function FieldsSection({
    task,
    context,
    hold,
    onChange
}: {
    task: TaskRow;
    context: SpaceContext;
    /** Hold what is being typed into a field that takes words or a number, so it is
     *  saved without waiting for the caret to leave. */
    hold?: (fieldId: string, value: string) => void;
    onChange: (fieldId: string, value: string) => void;
}) {
    const [open, setOpen] = useState(true);
    const [showEmpty, setShowEmpty] = useState(false);

    if (context.fields.length === 0) return null;

    const empty = context.fields.filter((field) => (task.customValues[field.id] ?? "") === "");
    // The space's own order, not filled ones first: these save themselves while
    // somebody is typing, and an order read off the values reshuffles the moment a
    // field stops being empty - which moves the box out from under the caret that
    // is still writing in it.
    const shown = showEmpty
        ? context.fields
        : context.fields.filter((field) => (task.customValues[field.id] ?? "") !== "");

    return (
        <section className="flex flex-col gap-1">
            <button
                type="button"
                onClick={() => setOpen((current) => !current)}
                className="flex w-fit items-center gap-1 text-sm font-medium"
            >
                {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                Fields
            </button>

            {open && (
                <div className="flex flex-col">
                    {shown.map((field) => (
                        <Property
                            key={field.id}
                            icon={<span className="inline-block size-3.5" />}
                            label={field.name}
                        >
                            <CustomFieldEditor
                                field={field}
                                value={task.customValues[field.id] ?? ""}
                                people={context.people}
                                disabled={!context.canEdit}
                                onEdit={hold && ((value) => hold(field.id, value))}
                                onChange={(value) => onChange(field.id, value)}
                            />
                        </Property>
                    ))}
                    {empty.length > 0 && (
                        <button
                            type="button"
                            onClick={() => setShowEmpty((current) => !current)}
                            className="w-fit py-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                            {showEmpty
                                ? `Hide ${empty.length} empty ${empty.length === 1 ? "field" : "fields"}`
                                : `Show ${empty.length} empty ${empty.length === 1 ? "field" : "fields"}`}
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}
