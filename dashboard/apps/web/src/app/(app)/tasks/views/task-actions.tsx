"use client";

/**
 * What a task can be done to without opening it.
 *
 * Two shapes of the same set. `TaskControls` is the strip that appears on a row
 * under the pointer - status, people, date, priority - because those four are
 * what somebody changes twenty times a day, and making each of them cost a
 * dialog is what turns a task manager into paperwork. `TaskMenu` is the same
 * things plus the rarer ones on a right-click, where people already look for
 * duplicate, copy and delete.
 *
 * They live together so a task offers the same verbs in a list, on a board and
 * in a table, and so adding one adds it everywhere at once.
 */

import * as core from "@polaris/core";
import type { TaskRow } from "@/lib/tasks/facts";
import type { TaskEdit, ViewProps } from "./shared";
import type { SpaceContext } from "@/lib/tasks/facts";
import { Ban, Check, Copy, ExternalLink, Flag, Link2, Tag, Trash2, UserPlus } from "lucide-react";
import { AssigneePicker, DuePicker, PriorityPicker, StatusIcon, StatusMarker, TagPicker, tagColorFor } from "../pickers";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger
} from "@polaris/ui";

export interface TaskCommands {
    readonly task: TaskRow;
    readonly context: SpaceContext;
    readonly canEdit: boolean;
    readonly onOpen: () => void;
    readonly onEdit: (change: TaskEdit) => void;
    readonly onDuplicate: () => void;
    readonly onDelete: () => void;
    /** Creating a tag from the picker, when the screen offers that. */
    readonly onCreateTag?: (name: string, color: string) => Promise<string | null>;
}

/** Bind one task to what a view can do with it. Every view builds its commands
 *  the same way, so a verb added here reaches all five at once. */
export function commandsFor(props: ViewProps, task: TaskRow): TaskCommands {
    return {
        task,
        context: props.context,
        canEdit: props.canEdit,
        onOpen: () => props.onOpen(task.id),
        onEdit: (change) => props.onEdit(task, change),
        onDuplicate: () => props.onDuplicate(task),
        onDelete: () => props.onDelete(task),
        onCreateTag: props.onCreateTag
    };
}

/** The link to a task, absolute, so what lands in somebody's clipboard is what
 *  they can paste into a chat. */
function taskLink(taskId: string): string {
    return typeof window === "undefined" ? `/tasks/t/${taskId}` : `${window.location.origin}/tasks/t/${taskId}`;
}

async function copy(value: string): Promise<void> {
    if (!navigator.clipboard) return;
    try {
        await navigator.clipboard.writeText(value);
    } catch {
        // Refused on an insecure origin or an unfocused document. Nothing to say.
    }
}

/**
 * The controls that appear on a row under the pointer. Anything already set
 * stays visible - a due date nobody can see is a due date nobody meets - and
 * only the empty affordances fade in on hover.
 */
export function TaskControls({ commands }: { commands: TaskCommands }) {
    const { task, context, canEdit } = commands;
    const assigned = context.people.filter((person) => task.assignees.some((entry) => entry.id === person.id));

    return (
        <>
            <PriorityPicker
                value={task.priority}
                disabled={!canEdit}
                onChange={(priority) => commands.onEdit({ priority })}
            />
            <DuePicker
                dueDate={task.dueDate}
                timed={task.timed}
                disabled={!canEdit}
                onChange={(dueDate) => commands.onEdit({ dueDate })}
            />
            <AssigneePicker
                people={context.people}
                selected={assigned.map((person) => person.id)}
                disabled={!canEdit}
                onChange={(assigneeIds) => commands.onEdit({ assigneeIds })}
            />
            <TagPicker
                tags={context.tags}
                selected={task.tags.map((tag) => tag.id)}
                disabled={!canEdit}
                onChange={(tagIds) => commands.onEdit({ tagIds })}
                onCreate={
                    commands.onCreateTag
                        ? async (name) => {
                              const id = await commands.onCreateTag?.(name, tagColorFor(name));
                              if (id) commands.onEdit({ tagIds: [...task.tags.map((tag) => tag.id), id] });
                              return id ?? null;
                          }
                        : undefined
                }
            />
        </>
    );
}

/** The status marker a row leads with: one click, and the states this space uses. */
export function TaskStatusMarker({ commands }: { commands: TaskCommands }) {
    const { task, context, canEdit } = commands;
    return (
        <StatusMarker
            statuses={context.statuses}
            statusId={task.statusId}
            statusColor={task.statusColor}
            statusType={task.statusType}
            statusName={task.statusName}
            spaceId={context.spaceId}
            disabled={!canEdit}
            onChange={(statusId) => commands.onEdit({ statusId })}
        />
    );
}

/** Right-click anywhere on a task. */
export function TaskMenu({ commands, children }: { commands: TaskCommands; children: React.ReactNode }) {
    const { task, context, canEdit } = commands;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-56">
                <ContextMenuItem onSelect={commands.onOpen}>
                    <ExternalLink className="size-3.5" />
                    Open
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void copy(taskLink(task.id))}>
                    <Link2 className="size-3.5" />
                    Copy link
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void copy(task.reference)}>
                    <Copy className="size-3.5" />
                    Copy {task.reference}
                </ContextMenuItem>

                {canEdit && (
                    <>
                        <ContextMenuSeparator />
                        <ContextMenuSub>
                            <ContextMenuSubTrigger>
                                <Check className="size-3.5" />
                                Status
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent className="w-52">
                                {context.statuses.map((status) => (
                                    <ContextMenuItem
                                        key={status.id}
                                        onSelect={() => commands.onEdit({ statusId: status.id })}
                                        className="gap-2"
                                    >
                                        <StatusIcon color={status.color} type={status.type} size={16} />
                                        <span className="flex-1 truncate">{status.name}</span>
                                        {status.id === task.statusId && <Check className="size-3.5 text-primary" />}
                                    </ContextMenuItem>
                                ))}
                            </ContextMenuSubContent>
                        </ContextMenuSub>

                        <ContextMenuSub>
                            <ContextMenuSubTrigger>
                                <Flag className="size-3.5" />
                                Priority
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent className="w-44">
                                {core.TASK_PRIORITIES.filter((priority) => priority !== "none").map((priority) => (
                                    <ContextMenuItem
                                        key={priority}
                                        onSelect={() => commands.onEdit({ priority })}
                                        className="gap-2"
                                    >
                                        <Flag
                                            className="size-3.5"
                                            fill={core.TASK_PRIORITY_COLORS[priority]}
                                            style={{ color: core.TASK_PRIORITY_COLORS[priority] }}
                                        />
                                        <span className="flex-1">{core.TASK_PRIORITY_LABELS[priority]}</span>
                                        {task.priority === priority && <Check className="size-3.5 text-primary" />}
                                    </ContextMenuItem>
                                ))}
                                <ContextMenuItem
                                    onSelect={() => commands.onEdit({ priority: "none" })}
                                    className="gap-2 text-muted-foreground"
                                >
                                    <Ban className="size-3.5" />
                                    Clear
                                </ContextMenuItem>
                            </ContextMenuSubContent>
                        </ContextMenuSub>

                        <ContextMenuSub>
                            <ContextMenuSubTrigger>
                                <UserPlus className="size-3.5" />
                                Assign
                            </ContextMenuSubTrigger>
                            <ContextMenuSubContent className="max-h-64 w-56 overflow-y-auto">
                                {context.people.length === 0 && (
                                    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                        Nobody is on this space yet.
                                    </p>
                                )}
                                {context.people.map((person) => {
                                    const on = task.assignees.some((entry) => entry.id === person.id);
                                    return (
                                        <ContextMenuItem
                                            key={person.id}
                                            className="gap-2"
                                            onSelect={() =>
                                                commands.onEdit({
                                                    assigneeIds: on
                                                        ? task.assignees
                                                              .filter((entry) => entry.id !== person.id)
                                                              .map((entry) => entry.id)
                                                        : [...task.assignees.map((entry) => entry.id), person.id]
                                                })
                                            }
                                        >
                                            <span className="flex-1 truncate">{person.name}</span>
                                            {on && <Check className="size-3.5 text-primary" />}
                                        </ContextMenuItem>
                                    );
                                })}
                            </ContextMenuSubContent>
                        </ContextMenuSub>

                        {context.tags.length > 0 && (
                            <ContextMenuSub>
                                <ContextMenuSubTrigger>
                                    <Tag className="size-3.5" />
                                    Tags
                                </ContextMenuSubTrigger>
                                <ContextMenuSubContent className="max-h-64 w-56 overflow-y-auto">
                                    {context.tags.map((tag) => {
                                        const on = task.tags.some((entry) => entry.id === tag.id);
                                        return (
                                            <ContextMenuItem
                                                key={tag.id}
                                                className="gap-2"
                                                onSelect={() =>
                                                    commands.onEdit({
                                                        tagIds: on
                                                            ? task.tags
                                                                  .filter((entry) => entry.id !== tag.id)
                                                                  .map((entry) => entry.id)
                                                            : [...task.tags.map((entry) => entry.id), tag.id]
                                                    })
                                                }
                                            >
                                                <span
                                                    aria-hidden
                                                    className="inline-block size-2.5 shrink-0 rounded-full"
                                                    style={{ backgroundColor: tag.color }}
                                                />
                                                <span className="flex-1 truncate">{tag.name}</span>
                                                {on && <Check className="size-3.5 text-primary" />}
                                            </ContextMenuItem>
                                        );
                                    })}
                                </ContextMenuSubContent>
                            </ContextMenuSub>
                        )}

                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={commands.onDuplicate}>
                            <Copy className="size-3.5" />
                            Duplicate
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem variant="danger" onSelect={commands.onDelete}>
                            <Trash2 className="size-3.5" />
                            Delete
                        </ContextMenuItem>
                    </>
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}
