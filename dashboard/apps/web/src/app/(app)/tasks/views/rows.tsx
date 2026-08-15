"use client";

/**
 * The two row-shaped views: List and Table.
 *
 * They share a renderer because they are the same thing seen at two densities.
 * List is grouped and shows the properties people scan for; Table is flat, adds
 * the custom-field columns, and scrolls sideways rather than wrapping - a table
 * that reflows is a table you cannot compare rows in.
 */

import { cn, EmptyState } from "@polaris/ui";
import * as core from "@polaris/core";
import { useMemo, useState } from "react";
import { toFacts } from "@/lib/tasks/facts";
import { CustomFieldValue } from "../custom-fields";
import { useDisplayFormat } from "@/components/display-format";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useRowCursor } from "./row-cursor";
import { clickMode, type SelectMode, type ViewProps } from "./shared";
import {
    commandsFor,
    TaskControls,
    TaskMenu,
    TaskStatusMarker,
    type TaskCommands
} from "./task-actions";
import { PriorityFlag } from "@/components/priority-flag";
import {
    AssigneePicker,
    AvatarStack,
    BlockedMarker,
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
    cursor,
    showStatus,
    showLocation,
    positioned = true,
    onSelect,
    onPoint,
    onRegister,
    onDragStart,
    onDropBefore
}: {
    commands: TaskCommands;
    depth: number;
    selected: boolean;
    /** Whether the keyboard cursor is on this row. Drawn as a rail down the left
     *  edge rather than as a background, so it stays legible on a row that is
     *  also selected - the two mean different things and have to be tellable
     *  apart. */
    cursor: boolean;
    /** Whether the row says what its status is. False when the list is already
     *  grouped by status, where every row in a group would repeat the heading
     *  above it - the widest column on the screen saying nothing. */
    showStatus: boolean;
    showLocation?: boolean;
    /** Whether dropping here would actually put the row here. False while a
     *  search is on, where the rows are ranked by how well they matched. */
    positioned?: boolean;
    onSelect: (mode: SelectMode) => void;
    /** A press anywhere on the row moves the cursor here, so the keyboard picks
     *  up from wherever the reader last looked rather than from the top. */
    onPoint?: () => void;
    onRegister?: (element: HTMLElement | null) => void;
    onDragStart?: () => void;
    onDropBefore?: () => void;
}) {
    const format = useDisplayFormat();
    const [over, setOver] = useState(false);
    const { task, canEdit, onOpen } = commands;

    return (
        <TaskMenu commands={commands}>
            <li
                ref={onRegister}
                onMouseDown={onPoint}
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
                    "group relative flex items-center gap-2 border-b border-border px-2 py-1.5 transition-colors hover:bg-card-hover",
                    selected && "bg-primary/5",
                    cursor &&
                        "bg-card-hover before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary",
                    over && positioned && "border-t-2 border-t-primary"
                )}
                style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
            >
                <TaskStatusMarker commands={commands} />
                <div className="flex min-w-0 flex-1 flex-col">
                    <button
                        type="button"
                        // A shift-click would otherwise drag a text selection across
                        // half the screen on its way to selecting the rows.
                        onMouseDown={(event) =>
                            event.shiftKey ? event.preventDefault() : undefined
                        }
                        onClick={(event) => {
                            const mode = clickMode(event);
                            if (mode) onSelect(mode);
                            else onOpen();
                        }}
                        className="flex min-w-0 items-center gap-2 text-left"
                    >
                        {/* Priority first, because the list is sorted by it out of
                        the box and a list ordered by something it never shows is
                        a list nobody can check. Nothing is drawn for a task with
                        none, so it costs no width in the common case. */}
                        <PriorityFlag priority={task.priority} />
                        <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
                            {task.reference}
                        </span>
                        <span
                            className={cn(
                                "truncate text-sm",
                                core.isFinishedStatus(task.statusType) && "text-muted-foreground"
                            )}
                        >
                            {task.name}
                        </span>
                        <BlockedMarker task={task} format={format.date} />
                        {task.tags.slice(0, 2).map((tag) => (
                            <TagChip key={tag.id} tag={tag} />
                        ))}
                    </button>
                    {showLocation && <TaskLocation task={task} />}
                </div>

                {showStatus && (
                    <span className="hidden items-center gap-1 text-[11px] text-muted-foreground md:flex">
                        <StatusDot color={task.statusColor} />
                        {task.statusName}
                    </span>
                )}
                <span className="hidden w-24 justify-end md:flex">
                    <DueBadge
                        dueDate={task.dueDate}
                        statusType={task.statusType}
                        timed={task.timed}
                        format={format.date}
                    />
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
    const { groups, canEdit, selection, onOpen, onSelect, onMove, onQuickCreate, orderable } =
        props;
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

    /**
     * The rows as the screen is drawing them - every open group in order, each
     * nested the way it renders - which is what a shift-click reaches across. A
     * collapsed group is not on screen, so a range never quietly picks up work
     * nobody can see.
     */
    const rendered = useMemo(
        () =>
            groups
                .filter((group) => !collapsed.has(group.key))
                .flatMap((group) =>
                    core
                        .flattenTree(core.buildTaskTree(group.tasks.map(toFacts)))
                        .map((node) => node.task.id)
                ),
        [groups, collapsed]
    );

    const cursor = useRowCursor(rendered, { onOpen, onSelect });

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
                    <section key={group.key} className="rounded-lg border border-border">
                        {/* Sticky, because a long group scrolls past its own
                            heading and "which status am I looking at" is the one
                            question the heading exists to answer. */}
                        <header className="sticky top-0 z-10 flex items-center gap-2 rounded-t-lg border-b border-border bg-surface px-3 py-2">
                            <button
                                type="button"
                                onClick={() => toggleGroup(group.key)}
                                aria-label={
                                    isCollapsed
                                        ? `Expand ${group.label}`
                                        : `Collapse ${group.label}`
                                }
                                className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                            >
                                {isCollapsed ? (
                                    <ChevronRight className="size-4" />
                                ) : (
                                    <ChevronDown className="size-4" />
                                )}
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
                                    const last = group.tasks
                                        .filter((task) => task.id !== dragging)
                                        .at(-1);
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
                                            cursor={cursor.at === task.id}
                                            showStatus={props.groupBy !== "status"}
                                            showLocation={props.showLocation}
                                            positioned={orderable}
                                            onPoint={() => cursor.moveTo(task.id)}
                                            onRegister={(element) =>
                                                cursor.register(task.id, element)
                                            }
                                            onSelect={(mode) => onSelect(task.id, mode, rendered)}
                                            onDragStart={() => setDragging(task.id)}
                                            onDropBefore={() => {
                                                if (!dragging) return;
                                                const without = group.tasks.filter(
                                                    (entry) => entry.id !== dragging
                                                );
                                                // Only the group is honoured while a
                                                // search is on: the row landed on says
                                                // which one, not where in it.
                                                const index = orderable
                                                    ? without.findIndex(
                                                          (entry) => entry.id === task.id
                                                      )
                                                    : without.length;
                                                onMove({
                                                    taskId: dragging,
                                                    groupKey: group.key,
                                                    position: {
                                                        beforeId: without[index - 1]?.id ?? null,
                                                        afterId: orderable ? task.id : null
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
                                        <li className="px-4 py-4 text-xs text-muted-foreground">
                                            Nothing here yet.
                                        </li>
                                    )
                                )}
                            </ul>
                        )}
                    </section>
                );
            })}

            {groups.length === 0 && (
                <EmptyState
                    title="No tasks match this view."
                    description="Change the filters, or add the first one."
                />
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
    // A table is flat, so the rows themselves are the order a shift-click spans.
    const rendered = useMemo(() => rows.map((task) => task.id), [rows]);
    const cursor = useRowCursor(rendered, { onOpen, onSelect });

    return (
        <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
                <thead className="sticky top-0 z-10">
                    <tr className="border-b border-border bg-surface text-left text-xs text-muted-foreground">
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
                                    ref={(element) => cursor.register(task.id, element)}
                                    onMouseDown={() => cursor.moveTo(task.id)}
                                    className={cn(
                                        "group border-b border-border transition-colors hover:bg-card-hover",
                                        selection.has(task.id) && "bg-primary/5",
                                        cursor.at === task.id &&
                                            "bg-card-hover shadow-[inset_2px_0_0_0_hsl(var(--primary))]"
                                    )}
                                >
                                    <td className="px-2 py-1.5">
                                        <TaskStatusMarker commands={commands} />
                                    </td>
                                    <td className="max-w-xs px-2 py-1.5">
                                        <button
                                            type="button"
                                            onMouseDown={(event) =>
                                                event.shiftKey ? event.preventDefault() : undefined
                                            }
                                            onClick={(event) => {
                                                const mode = clickMode(event);
                                                if (mode) onSelect(task.id, mode, rendered);
                                                else onOpen(task.id);
                                            }}
                                            className="flex w-full items-center gap-2 text-left"
                                        >
                                            <span className="font-mono text-[11px] text-muted-foreground">
                                                {task.reference}
                                            </span>
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
                                                    selected={task.assignees.map(
                                                        (person) => person.id
                                                    )}
                                                    disabled={!props.canEdit}
                                                    onChange={(assigneeIds) =>
                                                        props.onEdit(task, { assigneeIds })
                                                    }
                                                />
                                            </span>
                                        </span>
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-1.5 text-xs">
                                        <span className="inline-flex items-center gap-1.5">
                                            <PriorityPicker
                                                value={task.priority}
                                                disabled={!props.canEdit}
                                                onChange={(priority) =>
                                                    props.onEdit(task, { priority })
                                                }
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
                                                    onChange={(dueDate) =>
                                                        props.onEdit(task, { dueDate })
                                                    }
                                                />
                                            </span>
                                        </span>
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">
                                        {core.formatDurationMinutes(task.timeEstimate) || "-"}
                                    </td>
                                    <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">
                                        {task.trackedSeconds > 0
                                            ? core.formatTrackedSeconds(task.trackedSeconds)
                                            : "-"}
                                    </td>
                                    {columns.map((field) => (
                                        <td
                                            key={field.id}
                                            className="max-w-[12rem] px-2 py-1.5 text-xs"
                                        >
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
                            <td
                                colSpan={8 + columns.length}
                                className="px-4 py-10 text-center text-sm text-muted-foreground"
                            >
                                No tasks match this view.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}
