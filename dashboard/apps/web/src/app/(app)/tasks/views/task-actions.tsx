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
import { useMemo, useState } from "react";
import { useAppUrl } from "@/components/app-url";
import type { TaskRow } from "@/lib/tasks/facts";
import type { TaskEdit, ViewProps } from "./shared";
import type { SpaceContext } from "@/lib/tasks/facts";
import { Ban, Check, Copy, ExternalLink, Flag, Link2, Plus, Tag, Trash2, UserPlus } from "lucide-react";
import {
    AssigneePicker,
    Avatar,
    DuePicker,
    PriorityPicker,
    preloadAvatars,
    StatusIcon,
    StatusMarker,
    TagPicker,
    tagColorFor
} from "../pickers";
import {
    Button,
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
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
    /** Creating a status, when the reader may change the space's own. */
    readonly onCreateStatus?: (name: string, type: core.TaskStatusType, color: string) => Promise<string | null>;
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
        onCreateTag: props.onCreateTag,
        onCreateStatus: props.onCreateStatus
    };
}

/** The link to a task, absolute and on the address Polaris hands out, so what
 *  lands in somebody's clipboard is what they can paste into a chat - the tab's
 *  own hostname may be the LAN name, which resolves nowhere else. */
function taskLink(baseUrl: string, taskId: string): string {
    return `${baseUrl}/tasks/t/${taskId}`;
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

/** What the menu is in the middle of making, or nothing. */
type Draft = "tag" | "status";

/**
 * Making a tag or a status from the task that needs it.
 *
 * The alternative is leaving the menu, finding the space's settings, adding the
 * thing, coming back and finding the task again - by which point the reason for
 * the tag has usually been forgotten. A dialog rather than a field inside the
 * menu because a status is not just a name: its kind is what decides whether
 * work sitting in it counts as finished, and guessing that from the word
 * somebody typed is how a board ends up reporting the wrong thing.
 */
function CreateDialog({
    what,
    onClose,
    onCreate
}: {
    what: Draft;
    onClose: () => void;
    onCreate: (draft: { name: string; type: core.TaskStatusType; color: string }) => Promise<string | null>;
}) {
    const [name, setName] = useState("");
    const [type, setType] = useState<core.TaskStatusType>("open");
    const [picked, setPicked] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const trimmed = name.trim();
    // Until somebody picks one, a tag takes the colour its name always gets, so
    // the same tag made here and made from the picker comes out the same.
    const color = picked ?? (what === "tag" ? tagColorFor(trimmed || "tag") : "#64748b");

    const submit = async () => {
        if (!trimmed || busy) return;
        setBusy(true);
        const id = await onCreate({ name: trimmed, type, color });
        setBusy(false);
        if (id) onClose();
    };

    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{what === "tag" ? "New tag" : "New status"}</DialogTitle>
                    <DialogDescription>
                        {what === "tag"
                            ? "Added to this space and put on this task."
                            : "Added to this space and set on this task."}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Name
                        <Input
                            autoFocus
                            value={name}
                            placeholder={what === "tag" ? "backend" : "On hold"}
                            onChange={(event) => setName(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                void submit();
                            }}
                        />
                    </label>

                    {what === "status" && (
                        <div className="flex flex-col gap-1 text-sm">
                            Kind
                            <div className="flex flex-wrap gap-1">
                                {core.TASK_STATUS_TYPES.map((entry) => (
                                    <button
                                        key={entry}
                                        type="button"
                                        onClick={() => setType(entry)}
                                        aria-pressed={type === entry}
                                        className={cn(
                                            "rounded-md border px-2 py-1 text-xs transition-colors",
                                            type === entry
                                                ? "border-primary bg-primary/10 text-foreground"
                                                : "border-border text-muted-foreground hover:text-foreground"
                                        )}
                                    >
                                        {core.TASK_STATUS_TYPE_LABELS[entry]}
                                    </button>
                                ))}
                            </div>
                            <p className="text-xs text-muted-foreground">{core.TASK_STATUS_TYPE_HINTS[type]}</p>
                        </div>
                    )}

                    <label className="flex items-center gap-2 text-sm">
                        Colour
                        <input
                            type="color"
                            value={color}
                            aria-label={what === "tag" ? "Tag colour" : "Status colour"}
                            onChange={(event) => setPicked(event.target.value)}
                            className="size-8 cursor-pointer rounded border border-border bg-transparent"
                        />
                    </label>

                    <div className="flex justify-end gap-2">
                        <Button variant="secondary" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button disabled={!trimmed || busy} onClick={() => void submit()}>
                            {busy ? "Adding..." : "Add"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

/** Right-click anywhere on a task. */
export function TaskMenu({ commands, children }: { commands: TaskCommands; children: React.ReactNode }) {
    const { task, context, canEdit } = commands;
    const baseUrl = useAppUrl();
    const [drafting, setDrafting] = useState<Draft | null>(null);

    /**
     * What the submenus are about to show, worked out once instead of on every
     * move between options.
     *
     * A menu unmounts its submenu the moment the pointer leaves it, so hovering
     * back and forth rebuilds the same lists over and over; these are held by the
     * row, which stays put, so they survive the menu itself opening and closing.
     * The faces are warmed the same way one level up - see the open handler.
     */
    const assigned = useMemo(() => new Set(task.assignees.map((entry) => entry.id)), [task.assignees]);
    const tagged = useMemo(() => new Set(task.tags.map((entry) => entry.id)), [task.tags]);
    const priorities = useMemo(() => core.TASK_PRIORITIES.filter((priority) => priority !== "none"), []);

    const create = async (draft: { name: string; type: core.TaskStatusType; color: string }) => {
        if (drafting === "tag") {
            const id = (await commands.onCreateTag?.(draft.name, draft.color)) ?? null;
            if (id) commands.onEdit({ tagIds: [...task.tags.map((tag) => tag.id), id] });
            return id;
        }
        const id = (await commands.onCreateStatus?.(draft.name, draft.type, draft.color)) ?? null;
        if (id) commands.onEdit({ statusId: id });
        return id;
    };

    return (
        <>
            {drafting && <CreateDialog what={drafting} onClose={() => setDrafting(null)} onCreate={create} />}
            {/* The people this space can assign are fetched the moment the menu
                opens rather than when the Assign submenu does, so their faces are
                already in the browser by the time anybody reaches them. */}
            <ContextMenu onOpenChange={(open) => (open ? preloadAvatars(context.people) : undefined)}>
                <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                    <ContextMenuItem onSelect={commands.onOpen}>
                        <ExternalLink className="size-3.5" />
                        Open
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void copy(taskLink(baseUrl, task.id))}>
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
                                            {status.id === task.statusId && (
                                                <Check className="size-3.5 text-primary" />
                                            )}
                                        </ContextMenuItem>
                                    ))}
                                    {commands.onCreateStatus && (
                                        <>
                                            <ContextMenuSeparator />
                                            <ContextMenuItem
                                                className="gap-2"
                                                onSelect={() => setDrafting("status")}
                                            >
                                                <Plus className="size-3.5" />
                                                New status
                                            </ContextMenuItem>
                                        </>
                                    )}
                                </ContextMenuSubContent>
                            </ContextMenuSub>

                            <ContextMenuSub>
                                <ContextMenuSubTrigger>
                                    <Flag className="size-3.5" />
                                    Priority
                                </ContextMenuSubTrigger>
                                <ContextMenuSubContent className="w-44">
                                    {priorities.map((priority) => (
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
                                        const on = assigned.has(person.id);
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
                                                {/* The same face the row and the
                                                    directory draw: a list of names
                                                    is slower to pick from than a
                                                    list of people. */}
                                                <Avatar person={person} size={20} />
                                                <span className="flex-1 truncate">{person.name}</span>
                                                {on && <Check className="size-3.5 text-primary" />}
                                            </ContextMenuItem>
                                        );
                                    })}
                                </ContextMenuSubContent>
                            </ContextMenuSub>

                            {/* Offered even with nothing to pick yet: an empty
                                Tags submenu that only says "create one" is how
                                somebody discovers tags exist at all. */}
                            {(context.tags.length > 0 || commands.onCreateTag) && (
                                <ContextMenuSub>
                                    <ContextMenuSubTrigger>
                                        <Tag className="size-3.5" />
                                        Tags
                                    </ContextMenuSubTrigger>
                                    <ContextMenuSubContent className="max-h-64 w-56 overflow-y-auto">
                                        {context.tags.map((tag) => {
                                            const on = tagged.has(tag.id);
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
                                        {commands.onCreateTag && (
                                            <>
                                                {context.tags.length > 0 && <ContextMenuSeparator />}
                                                <ContextMenuItem
                                                    className="gap-2"
                                                    onSelect={() => setDrafting("tag")}
                                                >
                                                    <Plus className="size-3.5" />
                                                    New tag
                                                </ContextMenuItem>
                                            </>
                                        )}
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
        </>
    );
}
