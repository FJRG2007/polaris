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
import type { SpaceContext } from "@/lib/tasks/facts";
import type { TaskBulkEdit, TaskEdit, TaskListRef, ViewProps } from "./shared";
import {
    Archive,
    Ban,
    Check,
    Copy,
    ExternalLink,
    Flag,
    FolderInput,
    Link2,
    Plus,
    Tag,
    Trash2,
    UserPlus
} from "lucide-react";
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
    ContextMenuLabel,
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
    Input,
    MenuSearch,
    menuSearchMatches
} from "@polaris/ui";

export interface TaskCommands {
    readonly task: TaskRow;
    /**
     * Every task a menu opened on this one acts on: the whole selection when
     * this task belongs to it, the way a file manager acts on the highlighted
     * set rather than the row under the pointer, and just this task otherwise.
     * Always holds at least `task`.
     */
    readonly targets: readonly TaskRow[];
    readonly context: SpaceContext;
    readonly lists: readonly TaskListRef[];
    readonly canEdit: boolean;
    readonly onOpen: () => void;
    /** Change this task alone. What the controls on the row itself write. */
    readonly onEdit: (change: TaskEdit) => void;
    /** Change everything in `targets`. What the menu's verbs write. */
    readonly onApply: (change: TaskBulkEdit) => void;
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
    // A right-click inside the selection means the selection; outside it means
    // that one task, and leaves the selection alone.
    const targets = props.selection.has(task.id) && props.selected.length > 0 ? props.selected : [task];

    return {
        task,
        targets,
        context: props.context,
        lists: props.lists,
        canEdit: props.canEdit,
        onOpen: () => props.onOpen(task.id),
        onEdit: (change) => props.onEdit(task, change),
        onApply: (change) => props.onApply(targets, change),
        onDuplicate: () => props.onDuplicate(task),
        onDelete: () => props.onDelete(targets),
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
                            aria-label={what === "tag" ? "Tag color" : "Status color"}
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

/** The ids every task in a set carries, which is what a tick beside an option
 *  means once the menu is acting on more than one. Half the selection having a
 *  label is not the label being on, and offering it as "on" would turn the next
 *  click into a removal nobody asked for. */
function sharedBy(tasks: readonly TaskRow[], idsOf: (task: TaskRow) => readonly string[]): Set<string> {
    const [first, ...rest] = tasks;
    if (!first) return new Set();
    const shared = new Set(idsOf(first));
    for (const task of rest) {
        const held = new Set(idsOf(task));
        for (const id of shared) if (!held.has(id)) shared.delete(id);
    }
    return shared;
}

/** Right-click anywhere on a task. */
export function TaskMenu({ commands, children }: { commands: TaskCommands; children: React.ReactNode }) {
    const { task, targets, context, canEdit } = commands;
    const baseUrl = useAppUrl();
    const [drafting, setDrafting] = useState<Draft | null>(null);
    /**
     * What has been typed into each submenu that lists things a workspace keeps
     * adding to. Held here rather than inside the submenus because a submenu is
     * kept mounted once opened, and a search that reset every time the pointer
     * crossed it would be no search at all; the field selects what is in it when
     * it comes back, so returning to one and typing replaces the old words.
     */
    const [statusQuery, setStatusQuery] = useState("");
    const [peopleQuery, setPeopleQuery] = useState("");
    const [tagQuery, setTagQuery] = useState("");
    const [listQuery, setListQuery] = useState("");

    // Whether the menu is speaking about a selection rather than the task it was
    // opened on. The verbs are the same either way; what changes is that the ones
    // naming a single task - open it, copy its link, copy its reference - have
    // nothing to name, so they stand down.
    const many = targets.length > 1;

    /**
     * What the submenus are about to show, worked out once instead of on every
     * move between options.
     *
     * A menu unmounts its submenu the moment the pointer leaves it, so hovering
     * back and forth rebuilds the same lists over and over; these are held by the
     * row, which stays put, so they survive the menu itself opening and closing.
     * The faces are warmed the same way one level up - see the open handler.
     */
    const assigned = useMemo(() => sharedBy(targets, (entry) => entry.assignees.map((person) => person.id)), [targets]);
    const tagged = useMemo(() => sharedBy(targets, (entry) => entry.tags.map((tag) => tag.id)), [targets]);
    const priorities = useMemo(() => core.TASK_PRIORITIES.filter((priority) => priority !== "none"), []);
    // Ticked only where the whole set already agrees, for the same reason a tag
    // half the selection carries is not shown as on.
    const sharedStatusId = targets.every((entry) => entry.statusId === task.statusId) ? task.statusId : null;
    const sharedPriority = targets.every((entry) => entry.priority === task.priority) ? task.priority : null;

    /**
     * Where this work can be moved to.
     *
     * A task carries its space, and its status, tags and fields are that space's
     * words - so a move is between lists of one space and nowhere else. A
     * selection spanning two spaces therefore has no destination at all, and the
     * submenu says so rather than offering lists that would be refused.
     */
    const destinations = useMemo(() => {
        const spaces = new Set(targets.map((entry) => entry.spaceId));
        const spaceId = spaces.size === 1 ? [...spaces][0] : null;
        if (!spaceId) return [];
        const held = new Set(targets.map((entry) => entry.listId));
        return commands.lists.filter((list) => list.spaceId === spaceId && !(held.size === 1 && held.has(list.id)));
    }, [targets, commands.lists]);

    // What each search has left on screen. A space keeps adding states, tags and
    // lists, and the people on it only ever grow, so every one of these is a
    // list somebody eventually has to look through rather than read.
    const matchingStatuses = context.statuses.filter((status) => menuSearchMatches(status.name, statusQuery));
    const matchingPeople = context.people.filter((person) => menuSearchMatches(person.name, peopleQuery));
    const matchingTags = context.tags.filter((tag) => menuSearchMatches(tag.name, tagQuery));
    const matchingLists = destinations.filter((list) => menuSearchMatches(list.name, listQuery));

    const create = async (draft: { name: string; type: core.TaskStatusType; color: string }) => {
        if (drafting === "tag") {
            const id = (await commands.onCreateTag?.(draft.name, draft.color)) ?? null;
            if (id) commands.onApply({ addTagIds: [id] });
            return id;
        }
        const id = (await commands.onCreateStatus?.(draft.name, draft.type, draft.color)) ?? null;
        if (id) commands.onApply({ statusId: id });
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
                    {many ? (
                        <ContextMenuLabel>{targets.length} tasks selected</ContextMenuLabel>
                    ) : (
                        <>
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
                        </>
                    )}

                    {canEdit && (
                        <>
                            <ContextMenuSeparator />
                            <ContextMenuSub>
                                <ContextMenuSubTrigger>
                                    <Check className="size-3.5" />
                                    Status
                                </ContextMenuSubTrigger>
                                <ContextMenuSubContent className="w-52 pt-2">
                                    <MenuSearch
                                        value={statusQuery}
                                        onChange={setStatusQuery}
                                        placeholder="Find a status"
                                    />
                                    <div className="max-h-64 overflow-y-auto">
                                        {matchingStatuses.length === 0 && (
                                            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                                No status matches that.
                                            </p>
                                        )}
                                        {matchingStatuses.map((status) => (
                                            <ContextMenuItem
                                                key={status.id}
                                                onSelect={() => commands.onApply({ statusId: status.id })}
                                                className="gap-2"
                                            >
                                                <StatusIcon color={status.color} type={status.type} size={16} />
                                                <span className="flex-1 truncate">{status.name}</span>
                                                {status.id === sharedStatusId && (
                                                    <Check className="size-3.5 text-primary" />
                                                )}
                                            </ContextMenuItem>
                                        ))}
                                    </div>
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
                                            onSelect={() => commands.onApply({ priority })}
                                            className="gap-2"
                                        >
                                            <Flag
                                                className="size-3.5"
                                                fill={core.TASK_PRIORITY_COLORS[priority]}
                                                style={{ color: core.TASK_PRIORITY_COLORS[priority] }}
                                            />
                                            <span className="flex-1">{core.TASK_PRIORITY_LABELS[priority]}</span>
                                            {sharedPriority === priority && <Check className="size-3.5 text-primary" />}
                                        </ContextMenuItem>
                                    ))}
                                    <ContextMenuItem
                                        onSelect={() => commands.onApply({ priority: "none" })}
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
                                <ContextMenuSubContent className="w-56 pt-2">
                                    {context.people.length > 0 && (
                                        <MenuSearch
                                            value={peopleQuery}
                                            onChange={setPeopleQuery}
                                            placeholder="Find someone"
                                        />
                                    )}
                                    <div className="max-h-64 overflow-y-auto">
                                        {context.people.length === 0 && (
                                            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                                Nobody is on this space yet.
                                            </p>
                                        )}
                                        {context.people.length > 0 && matchingPeople.length === 0 && (
                                            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                                Nobody matches that.
                                            </p>
                                        )}
                                        {matchingPeople.map((person) => {
                                            const on = assigned.has(person.id);
                                            return (
                                                <ContextMenuItem
                                                    key={person.id}
                                                    className="gap-2"
                                                    onSelect={() =>
                                                        commands.onApply(
                                                            on
                                                                ? { removeAssigneeIds: [person.id] }
                                                                : { addAssigneeIds: [person.id] }
                                                        )
                                                    }
                                                >
                                                    {/* The same face the row and
                                                        the directory draw: a list
                                                        of names is slower to pick
                                                        from than a list of
                                                        people. */}
                                                    <Avatar person={person} size={20} />
                                                    <span className="flex-1 truncate">{person.name}</span>
                                                    {on && <Check className="size-3.5 text-primary" />}
                                                </ContextMenuItem>
                                            );
                                        })}
                                    </div>
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
                                    <ContextMenuSubContent className="w-56 pt-2">
                                        {context.tags.length > 0 && (
                                            <MenuSearch
                                                value={tagQuery}
                                                onChange={setTagQuery}
                                                placeholder="Find a tag"
                                            />
                                        )}
                                        <div className="max-h-64 overflow-y-auto">
                                            {context.tags.length > 0 && matchingTags.length === 0 && (
                                                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                                    No tag matches that.
                                                </p>
                                            )}
                                            {matchingTags.map((tag) => {
                                                const on = tagged.has(tag.id);
                                                return (
                                                    <ContextMenuItem
                                                        key={tag.id}
                                                        className="gap-2"
                                                        onSelect={() =>
                                                            commands.onApply(
                                                                on
                                                                    ? { removeTagIds: [tag.id] }
                                                                    : { addTagIds: [tag.id] }
                                                            )
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
                                        </div>
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

                            {/* Only where the screen knows what lists exist. The
                                work inside a task answers to this menu too, and
                                a subtask has no list of its own to be moved
                                between. */}
                            {commands.lists.length > 0 && (
                                <ContextMenuSub>
                                    <ContextMenuSubTrigger>
                                        <FolderInput className="size-3.5" />
                                        Move to
                                    </ContextMenuSubTrigger>
                                    <ContextMenuSubContent className="w-56 pt-2">
                                        {destinations.length > 0 && (
                                            <MenuSearch
                                                value={listQuery}
                                                onChange={setListQuery}
                                                placeholder="Find a list"
                                            />
                                        )}
                                        <div className="max-h-64 overflow-y-auto">
                                            {destinations.length === 0 && (
                                                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                                    {many
                                                        ? "Work only moves between lists of one space, and this selection spans more than one."
                                                        : "This space has nowhere else to put it."}
                                                </p>
                                            )}
                                            {destinations.length > 0 && matchingLists.length === 0 && (
                                                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                                    No list matches that.
                                                </p>
                                            )}
                                            {matchingLists.map((list) => (
                                                <ContextMenuItem
                                                    key={list.id}
                                                    className="gap-2"
                                                    onSelect={() => commands.onApply({ listId: list.id })}
                                                >
                                                    <span className="flex-1 truncate">{list.name}</span>
                                                </ContextMenuItem>
                                            ))}
                                        </div>
                                    </ContextMenuSubContent>
                                </ContextMenuSub>
                            )}

                            <ContextMenuSeparator />
                            {!many && (
                                <ContextMenuItem onSelect={commands.onDuplicate}>
                                    <Copy className="size-3.5" />
                                    Duplicate
                                </ContextMenuItem>
                            )}
                            {/* Archiving is how work leaves a board without being
                                destroyed, so it sits above the delete rather than
                                beside it. */}
                            <ContextMenuItem onSelect={() => commands.onApply({ archived: true })}>
                                <Archive className="size-3.5" />
                                Archive
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem variant="danger" onSelect={commands.onDelete}>
                                <Trash2 className="size-3.5" />
                                {many ? `Delete ${targets.length} tasks` : "Delete"}
                            </ContextMenuItem>
                        </>
                    )}
                </ContextMenuContent>
            </ContextMenu>
        </>
    );
}
