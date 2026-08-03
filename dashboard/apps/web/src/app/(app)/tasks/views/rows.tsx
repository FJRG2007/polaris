"use client";

/**
 * The two row-shaped views: List and Table.
 *
 * They share a renderer because they are the same thing seen at two densities.
 * List is grouped and shows the properties people scan for; Table is flat, adds
 * the custom-field columns, and scrolls sideways rather than wrapping - a table
 * that reflows is a table you cannot compare rows in.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import type { ViewProps } from "./shared";
import { toFacts } from "@/lib/tasks/facts";
import { CustomFieldValue } from "../custom-fields";
import { useDisplayFormat } from "@/components/display-format";
import { Ban, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { commandsFor, TaskControls, TaskMenu, TaskStatusMarker, type TaskCommands } from "./task-actions";
import {
    AssigneePicker,
    AvatarStack,
    DueBadge,
    DuePicker,
    PriorityPicker,
    StatusDot,
    TagChip,
    TaskLocation
} from "../pickers";

/** One task as a row. Shared by both views so a task reads the same in either. */
function TaskLine({
    commands,
    depth,
    selected,
    showLocation,
    positioned = true,
    onSelect,
    onDragStart,
    onDropBefore
}: {
    commands: TaskCommands;
    depth: number;
    selected: boolean;
    showLocation?: boolean;
    /** Whether dropping here would actually put the row here. False under a sort
     *  that decides the order itself. */
    positioned?: boolean;
    onSelect: () => void;
    onDragStart?: () => void;
    onDropBefore?: () => void;
}) {
    const format = useDisplayFormat();
    const [over, setOver] = useState(false);
    const { task, canEdit, onOpen } = commands;

    return (
        <TaskMenu commands={commands}>
        <li
            draggable={canEdit && onDragStart !== undefined}
            onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", task.id);
                onDragStart?.();
            }}
            onDragOver={(event) => {
                if (!onDropBefore) return;
                event.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                if (!onDropBefore) return;
                event.preventDefault();
                setOver(false);
                onDropBefore();
            }}
            className={cn(
                "group flex items-center gap-2 border-b border-border px-2 py-1.5 transition-colors hover:bg-muted/50",
                selected && "bg-primary/5",
                over && positioned && "border-t-2 border-t-primary"
            )}
            style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
        >
            <TaskStatusMarker commands={commands} />
            <div className="flex min-w-0 flex-1 flex-col">
                <button
                    type="button"
                    onClick={(event) => (event.metaKey || event.ctrlKey ? onSelect() : onOpen())}
                    className="flex min-w-0 items-center gap-2 text-left"
                >
                    <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{task.reference}</span>
                    <span className={cn("truncate text-sm", core.isFinishedStatus(task.statusType) && "text-muted-foreground")}>
                        {task.name}
                    </span>
                    {task.blocked && <Ban className="size-3.5 shrink-0 text-amber-500" aria-label="Blocked" />}
                    {task.tags.slice(0, 2).map((tag) => (
                        <TagChip key={tag.id} tag={tag} />
                    ))}
                </button>
                {showLocation && <TaskLocation task={task} />}
            </div>

            <span className="hidden items-center gap-1 text-[11px] text-muted-foreground md:flex">
                <StatusDot color={task.statusColor} />
                {task.statusName}
            </span>
            <span className="hidden w-24 justify-end md:flex">
                <DueBadge dueDate={task.dueDate} statusType={task.statusType} timed={task.timed} format={format.date} />
            </span>
            <AvatarStack people={task.assignees} size={20} />
            {/* The editable versions of what the row just showed. They sit at the
                end so the row still reads left to right, and stay out of the way
                until somebody is actually pointing at this task. */}
            <span
                className={cn(
                    "flex shrink-0 items-center transition-opacity focus-within:opacity-100 group-hover:opacity-100",
                    canEdit ? "opacity-0" : "hidden"
                )}
            >
                <TaskControls commands={commands} />
            </span>
        </li>
        </TaskMenu>
    );
}

export function ListView(props: ViewProps) {
    const { groups, canEdit, selection, onSelect, onMove, onQuickCreate, manualOrder } = props;
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
    const [dragging, setDragging] = useState<string | null>(null);
    const [addingTo, setAddingTo] = useState<string | null>(null);
    const [draft, setDraft] = useState("");

    const toggleGroup = (key: string) => {
        const next = new Set(collapsed);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setCollapsed(next);
    };

    return (
        <div className="flex flex-col gap-4">
            {groups.map((group) => {
                const isCollapsed = collapsed.has(group.key);
                // Nest subtasks under the parent they belong to, when both are in
                // this group. The engine works in facts, so the rows are mapped
                // in and looked back up by id when they are drawn.
                const byId = new Map(group.tasks.map((task) => [task.id, task]));
                const rows = core.flattenTree(core.buildTaskTree(group.tasks.map(toFacts)));

                return (
                    <section key={group.key} className="overflow-hidden rounded-lg border border-border">
                        <header className="flex items-center gap-2 bg-muted/40 px-3 py-2">
                            <button
                                type="button"
                                onClick={() => toggleGroup(group.key)}
                                aria-label={isCollapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
                                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                            >
                                {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                            </button>
                            {group.color && <StatusDot color={group.color} />}
                            <h3 className="text-sm font-medium">{group.label}</h3>
                            <span className="rounded bg-background px-1.5 text-[11px] text-muted-foreground">
                                {group.tasks.length}
                            </span>
                            <span className="flex-1" />
                            {canEdit && (
                                <button
                                    type="button"
                                    aria-label={`Add a task to ${group.label}`}
                                    title="Add a task"
                                    onClick={() => {
                                        setAddingTo(group.key);
                                        setDraft("");
                                    }}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                                >
                                    <Plus className="size-3.5" />
                                </button>
                            )}
                        </header>

                        {!isCollapsed && (
                            <ul
                                onDragOver={(event) => event.preventDefault()}
                                onDrop={() => {
                                    if (!dragging) return;
                                    const last = group.tasks.filter((task) => task.id !== dragging).at(-1);
                                    onMove({
                                        taskId: dragging,
                                        groupKey: group.key,
                                        position: { beforeId: last?.id ?? null, afterId: null }
                                    });
                                    setDragging(null);
                                }}
                            >
                                {rows.map((node) => {
                                    const task = byId.get(node.task.id);
                                    if (!task) return null;
                                    return (
                                        <TaskLine
                                            key={task.id}
                                            commands={commandsFor(props, task)}
                                            depth={node.depth}
                                            selected={selection.has(task.id)}
                                            showLocation={props.showLocation}
                                            positioned={manualOrder}
                                            onSelect={() => onSelect(task.id)}
                                            onDragStart={() => setDragging(task.id)}
                                            onDropBefore={() => {
                                                if (!dragging) return;
                                                const without = group.tasks.filter((entry) => entry.id !== dragging);
                                                // Only the group is honoured when the
                                                // sort owns the order; the row landed on
                                                // says which one, not where in it.
                                                const index = manualOrder
                                                    ? without.findIndex((entry) => entry.id === task.id)
                                                    : without.length;
                                                onMove({
                                                    taskId: dragging,
                                                    groupKey: group.key,
                                                    position: {
                                                        beforeId: without[index - 1]?.id ?? null,
                                                        afterId: manualOrder ? task.id : null
                                                    }
                                                });
                                                setDragging(null);
                                            }}
                                        />
                                    );
                                })}

                                {addingTo === group.key ? (
                                    <li className="px-2 py-1.5">
                                        <input
                                            autoFocus
                                            value={draft}
                                            placeholder="Task name, then enter"
                                            onChange={(event) => setDraft(event.target.value)}
                                            onBlur={() => setAddingTo(null)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Escape") setAddingTo(null);
                                                if (event.key === "Enter" && draft.trim()) {
                                                    onQuickCreate(group.key, draft.trim());
                                                    setDraft("");
                                                }
                                            }}
                                            className="w-full rounded-md border border-primary bg-background px-2 py-1 text-sm outline-none"
                                        />
                                    </li>
                                ) : (
                                    group.tasks.length === 0 && (
                                        <li className="px-4 py-4 text-xs text-muted-foreground">Nothing here yet.</li>
                                    )
                                )}
                            </ul>
                        )}
                    </section>
                );
            })}

            {groups.length === 0 && (
                <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                    No tasks match this view. Change the filters, or add the first one.
                </p>
            )}
        </div>
    );
}

export function TableView(props: ViewProps) {
    const { rows, context, selection, onOpen, onSelect } = props;
    const format = useDisplayFormat();
    // Every custom field gets a column here: being able to compare them side by
    // side is the whole reason to look at a table rather than a list.
    const columns = context.fields;

    return (
        <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
                <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                        <th className="w-8 px-2 py-2" />
                        <th className="px-2 py-2 font-medium">Task</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium">Assignees</th>
                        <th className="px-2 py-2 font-medium">Priority</th>
                        <th className="px-2 py-2 font-medium">Due</th>
                        <th className="px-2 py-2 font-medium">Estimate</th>
                        <th className="px-2 py-2 font-medium">Tracked</th>
                        {columns.map((field) => (
                            <th key={field.id} className="px-2 py-2 font-medium">
                                {field.name}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((task) => {
                        const commands = commandsFor(props, task);
                        return (
                        <TaskMenu key={task.id} commands={commands}>
                        <tr
                            className={cn(
                                "group border-b border-border transition-colors hover:bg-muted/40",
                                selection.has(task.id) && "bg-primary/5"
                            )}
                        >
                            <td className="px-2 py-1.5">
                                <TaskStatusMarker commands={commands} />
                            </td>
                            <td className="max-w-xs px-2 py-1.5">
                                <button
                                    type="button"
                                    onClick={(event) => (event.metaKey || event.ctrlKey ? onSelect(task.id) : onOpen(task.id))}
                                    className="flex w-full items-center gap-2 text-left"
                                >
                                    <span className="font-mono text-[11px] text-muted-foreground">{task.reference}</span>
                                    <span className="truncate">{task.name}</span>
                                </button>
                                {props.showLocation && <TaskLocation task={task} />}
                            </td>
                            <td className="whitespace-nowrap px-2 py-1.5">
                                <span className="inline-flex items-center gap-1.5 text-xs">
                                    <StatusDot color={task.statusColor} />
                                    {task.statusName}
                                </span>
                            </td>
                            <td className="px-2 py-1.5">
                                <span className="flex items-center gap-1">
                                    <AvatarStack people={task.assignees} size={20} />
                                    <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                                        <AssigneePicker
                                            people={context.people}
                                            selected={task.assignees.map((person) => person.id)}
                                            disabled={!props.canEdit}
                                            onChange={(assigneeIds) => props.onEdit(task, { assigneeIds })}
                                        />
                                    </span>
                                </span>
                            </td>
                            <td className="whitespace-nowrap px-2 py-1.5 text-xs">
                                <span className="inline-flex items-center gap-1.5">
                                    <PriorityPicker
                                        value={task.priority}
                                        disabled={!props.canEdit}
                                        onChange={(priority) => props.onEdit(task, { priority })}
                                    />
                                    {core.TASK_PRIORITY_LABELS[task.priority]}
                                </span>
                            </td>
                            <td className="whitespace-nowrap px-2 py-1.5">
                                <span className="inline-flex items-center gap-1">
                                    <DueBadge
                                        dueDate={task.dueDate}
                                        statusType={task.statusType}
                                        timed={task.timed}
                                        format={format.date}
                                    />
                                    <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                                        <DuePicker
                                            dueDate={task.dueDate}
                                            timed={task.timed}
                                            disabled={!props.canEdit}
                                            onChange={(dueDate) => props.onEdit(task, { dueDate })}
                                        />
                                    </span>
                                </span>
                            </td>
                            <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">
                                {core.formatDurationMinutes(task.timeEstimate) || "-"}
                            </td>
                            <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">
                                {task.trackedSeconds > 0 ? core.formatTrackedSeconds(task.trackedSeconds) : "-"}
                            </td>
                            {columns.map((field) => (
                                <td key={field.id} className="max-w-[12rem] px-2 py-1.5 text-xs">
                                    <CustomFieldValue
                                        field={field}
                                        value={task.customValues[field.id] ?? ""}
                                        people={context.people}
                                    />
                                </td>
                            ))}
                        </tr>
                        </TaskMenu>
                        );
                    })}
                    {rows.length === 0 && (
                        <tr>
                            <td colSpan={8 + columns.length} className="px-4 py-10 text-center text-sm text-muted-foreground">
                                No tasks match this view.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}
