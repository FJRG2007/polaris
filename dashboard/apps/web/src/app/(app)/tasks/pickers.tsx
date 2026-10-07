"use client";

/**
 * The small controls a task screen is built out of: status, priority, people,
 * tags, dates and durations.
 *
 * They exist as one module because every one of them appears in at least three
 * places - the row, the card, the detail panel and the bulk bar - and a status
 * dot that looks different in the table than on the board is how a workspace
 * stops feeling like one product. Each is uncontrolled about persistence: it
 * reports a value and the caller decides what to write.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { PriorityMark } from "@/components/priority-mark";
import { Avatar, preloadAvatars } from "@/components/avatar";
import { useEffect, useMemo, useRef, useState } from "react";
import { PersonName, PersonRow } from "@/components/person-name";
import { optionLabel } from "./option-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { PersonRef, TagRef, TaskRow } from "@/lib/tasks/facts";
import type { StatusView, TagView } from "@/lib/tasks/space-service";
import { Ban, CalendarPlus, Check, ChevronDown, Plus, Settings2, UserPlus, X } from "lucide-react";
import {
    Badge,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    MenuSearch,
    menuSearchMatches,
    refocusMenuSearch,
    StatusIcon
} from "@polaris/ui";

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * A face is no longer a task control: the same circle is drawn in the people
 * directory, in the account menu and on a profile, and it now has a picture to
 * resolve rather than only initials. It lives in `components/avatar` and is
 * re-exported here so the screens that have always taken their controls from
 * this module keep doing so.
 */
export { Avatar, AvatarStack, preloadAvatars } from "@/components/avatar";

export function AssigneePicker({
    people,
    selected,
    onChange,
    disabled,
    trigger
}: {
    people: readonly PersonRef[];
    selected: readonly string[];
    onChange: (ids: string[]) => void;
    disabled?: boolean;
    trigger?: React.ReactNode;
}) {
    const t = useTranslations("tasks");
    const [query, setQuery] = useState("");
    const matches = useMemo(
        () => people.filter((person) => menuSearchMatches(person.name, query)),
        [people, query]
    );

    /** Picking somebody empties the field and gives it the keyboard back, so a
     *  second name is typed straight after the first instead of the menu having
     *  to be re-aimed by hand between the two. */
    const toggle = (id: string, from: EventTarget | null) => {
        onChange(
            selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]
        );
        setQuery("");
        refocusMenuSearch(from);
    };

    return (
        // The faces are asked for as the menu opens rather than as it draws, so
        // the list is readable the moment it appears instead of filling in.
        <DropdownMenu onOpenChange={(open) => (open ? preloadAvatars(people) : undefined)}>
            <DropdownMenuTrigger asChild disabled={disabled}>
                {trigger ?? (
                    <button
                        type="button"
                        aria-label={t("pickers.assignees")}
                        title={t("pickers.assign")}
                        // Always the plus, never the faces. Every caller already
                        // draws the people it has; a trigger that drew them too
                        // showed everybody assigned to the task twice.
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <UserPlus className="size-3.5" />
                    </button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 pt-2">
                {people.length > 0 && (
                    <MenuSearch
                        value={query}
                        onChange={setQuery}
                        placeholder={t("pickers.findSomeone")}
                    />
                )}
                <div className="max-h-64 overflow-y-auto overscroll-contain">
                    {matches.length === 0 && (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                            {people.length === 0
                                ? t("pickers.nobodyYet")
                                : t("pickers.nobodyMatches")}
                        </p>
                    )}
                    {matches.map((person) => (
                        <PersonRow
                            as={DropdownMenuItem}
                            key={person.id}
                            personId={person.id}
                            onSelect={(event: Event) => {
                                event.preventDefault();
                                toggle(person.id, event.currentTarget);
                            }}
                            className="gap-2"
                        >
                            <Avatar person={person} size={20} />
                            <span className="flex-1 truncate">
                                <PersonName id={person.id} name={person.name} />
                            </span>
                            {selected.includes(person.id) && (
                                <Check className="size-3.5 text-primary" />
                            )}
                        </PersonRow>
                    ))}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// ---------------------------------------------------------------------------
// Where a task lives
// ---------------------------------------------------------------------------

/**
 * The trail to a task: its space, the folder people use as the project, and its
 * list. Any screen that mixes work from more than one list needs it - a task
 * called "Fix the header" says nothing about which piece of work it belongs to
 * until you can see where it came from. The space and the list are links,
 * because the next thing somebody wants is usually the rest of that list.
 */
export function TaskLocation({
    task,
    className
}: {
    task: Pick<TaskRow, "spaceId" | "spaceName" | "listId" | "listName" | "folderName">;
    className?: string;
}) {
    const trail = [task.spaceName, task.folderName, task.listName].filter(Boolean).join(" / ");
    return (
        <span
            title={trail}
            className={cn(
                "flex min-w-0 items-center gap-1 text-[0.6875rem] text-muted-foreground",
                className
            )}
        >
            <Link
                href={`/tasks/s/${task.spaceId}`}
                className="truncate transition-colors hover:text-foreground hover:underline"
            >
                {task.spaceName}
            </Link>
            {task.folderName && (
                <>
                    <span aria-hidden>/</span>
                    <span className="truncate">{task.folderName}</span>
                </>
            )}
            <span aria-hidden>/</span>
            <Link
                href={`/tasks/l/${task.listId}`}
                className="truncate transition-colors hover:text-foreground hover:underline"
            >
                {task.listName}
            </Link>
        </span>
    );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function StatusDot({ color, className }: { color: string; className?: string }) {
    return (
        <span
            aria-hidden
            className={cn("inline-block size-2.5 shrink-0 rounded-full", className)}
            style={{ backgroundColor: color }}
        />
    );
}

/** Drawn in `@polaris/ui`, where the Calendar draws the same mark on its tasks;
 *  re-exported so this board's own callers are unchanged. */
export { StatusIcon };

export function StatusPicker({
    statuses,
    value,
    onChange,
    disabled,
    compact,
    trigger,
    spaceId
}: {
    statuses: readonly StatusView[];
    value: string | null;
    onChange: (statusId: string) => void;
    disabled?: boolean;
    compact?: boolean;
    /** Replaces the default pill - a row uses the state marker as its trigger. */
    trigger?: React.ReactNode;
    /** Offers the way to a space's own statuses. A workspace outgrows the ones
     *  it started with, and the moment to add "On hold" is the moment somebody
     *  went looking for it. */
    spaceId?: string;
}) {
    const t = useTranslations("tasks");
    const [query, setQuery] = useState("");
    const current = statuses.find((status) => status.id === value);
    // A space names its own states and keeps adding them, so the list is as long
    // as the workspace has made it.
    const matches = statuses.filter((status) => menuSearchMatches(status.name, query));

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                {trigger ?? (
                    <button
                        type="button"
                        aria-label={t("pickers.status")}
                        className={cn(
                            "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-muted",
                            compact && "border-transparent px-1.5"
                        )}
                        style={current ? { color: current.color } : undefined}
                    >
                        <StatusIcon
                            color={current?.color ?? "#64748b"}
                            type={current?.type ?? "open"}
                            progress={core.statusProgress(statuses, value)}
                            size={14}
                        />
                        <span className="truncate">{current?.name ?? t("groups.noStatus")}</span>
                        {!compact && <ChevronDown className="size-3 opacity-60" />}
                    </button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 pt-2">
                <MenuSearch
                    value={query}
                    onChange={setQuery}
                    placeholder={t("pickers.findStatus")}
                />
                <div className="max-h-64 overflow-y-auto overscroll-contain">
                    {matches.length === 0 && (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                            {t("pickers.noStatusMatches")}
                        </p>
                    )}
                    {matches.map((status) => (
                        <DropdownMenuItem
                            key={status.id}
                            onSelect={() => onChange(status.id)}
                            className="gap-2"
                        >
                            <StatusIcon
                                color={status.color}
                                type={status.type}
                                progress={core.statusProgress(statuses, status.id)}
                                size={16}
                            />
                            <span className="flex-1 truncate">{status.name}</span>
                            {status.id === value ? (
                                <Check className="size-3.5 text-primary" />
                            ) : (
                                <span className="text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                                    {optionLabel(t, "statusType", status.type)}
                                </span>
                            )}
                        </DropdownMenuItem>
                    ))}
                </div>
                {spaceId && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild className="gap-2 text-muted-foreground">
                            <Link href={`/tasks/s/${spaceId}?tab=Statuses`}>
                                <Settings2 className="size-3.5" />
                                {t("pickers.editStatuses")}
                            </Link>
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * The marker a row carries and the way its state is changed: one click, and the
 * states this space actually uses. A plain checkbox only ever says finished or
 * not, so moving something to "In review" meant opening the task to do it - and
 * a board with five columns is a workspace that already decided a task has more
 * than two states.
 */
export function StatusMarker({
    statuses,
    statusId,
    statusColor,
    statusType,
    statusName,
    onChange,
    disabled,
    spaceId
}: {
    statuses: readonly StatusView[];
    statusId: string | null;
    statusColor: string;
    statusType: core.TaskStatusType;
    statusName: string;
    onChange: (statusId: string) => void;
    disabled?: boolean;
    spaceId?: string;
}) {
    const t = useTranslations("tasks");
    return (
        <StatusPicker
            statuses={statuses}
            value={statusId}
            onChange={onChange}
            disabled={disabled}
            spaceId={spaceId}
            trigger={
                <button
                    type="button"
                    title={statusName}
                    aria-label={t("pickers.statusNamed", { name: statusName })}
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded transition-colors duration-fast hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <StatusIcon
                        color={statusColor}
                        type={statusType}
                        progress={core.statusProgress(statuses, statusId)}
                    />
                </button>
            }
        />
    );
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

/** Re-exported from where it lives, so the board's own callers are unchanged and
 *  the Overview does not have to import this module to draw one flag. */
export { PriorityMark };

export function PriorityPicker({
    value,
    onChange,
    disabled,
    trigger
}: {
    /** Null when there is no one answer to tick - a selection of several tasks. */
    value: core.TaskPriority | null;
    onChange: (priority: core.TaskPriority) => void;
    disabled?: boolean;
    trigger?: React.ReactNode;
}) {
    const t = useTranslations("tasks");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                {trigger ?? (
                    <button
                        type="button"
                        aria-label={t("pickers.priority")}
                        title={optionLabel(t, "priority", value ?? "none")}
                        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground data-[state=open]:bg-muted"
                    >
                        <PriorityMark priority={value ?? "none"} />
                    </button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
                <p className="px-2 pb-1 text-[0.625rem] uppercase tracking-wide text-muted-foreground">
                    {t("pickers.priority")}
                </p>
                {/* Every priority, "none" included and in its own place at the
                    bottom of the scale. It used to be a "Clear" row with a
                    crossed-out circle on it, which reads as an action rather
                    than as the answer it is - and left the menu unable to show
                    that no priority is what this task currently has. */}
                {core.TASK_PRIORITIES.map((priority) => (
                    <DropdownMenuItem
                        key={priority}
                        onSelect={() => onChange(priority)}
                        className="gap-2"
                    >
                        <PriorityMark priority={priority} />
                        <span className="flex-1">{optionLabel(t, "priority", priority)}</span>
                        {value === priority && <Check className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * The colour a tag gets when it is born in a picker rather than in the settings.
 *
 * Derived from the name, so the same tag typed in two places comes out the same
 * colour, and a workspace does not end up with six tags in the same blue because
 * they were all created first. Any of them can be recoloured afterwards.
 */
const TAG_PALETTE = [
    "#3b82f6",
    "#8b5cf6",
    "#ec4899",
    "#f97316",
    "#eab308",
    "#22c55e",
    "#14b8a6",
    "#64748b"
] as const;

export function tagColorFor(name: string): string {
    let hash = 0;
    for (let index = 0; index < name.length; index += 1)
        hash = (hash * 31 + name.charCodeAt(index)) % 997;
    return TAG_PALETTE[hash % TAG_PALETTE.length] as string;
}

export function TagChip({ tag, onRemove }: { tag: TagRef | TagView; onRemove?: () => void }) {
    const t = useTranslations("tasks");
    return (
        <Badge
            variant="neutral"
            // A tag is named by whoever needed it, in a hurry, and nothing stops
            // that name being one long word. Capped at the width of whatever is
            // showing it rather than allowed out through the side of a card.
            className="max-w-full gap-1 border-transparent text-[0.6875rem]"
            style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
        >
            <span className="truncate" title={tag.name}>
                {tag.name}
            </span>
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={t("pickers.remove", { name: tag.name })}
                    className="opacity-70 hover:opacity-100"
                >
                    <X className="size-3" />
                </button>
            )}
        </Badge>
    );
}

export function TagPicker({
    tags,
    selected,
    onChange,
    onCreate,
    spaceId,
    disabled
}: {
    tags: readonly TagView[];
    selected: readonly string[];
    onChange: (ids: string[]) => void;
    /** Offered when the typed name matches nothing, so a tag can be born where
     *  it is needed instead of in a settings screen. */
    onCreate?: (name: string) => Promise<string | null>;
    /**
     * Offers the way to a space's own tags, as the status picker does.
     *
     * It is the way out of the mess this picker can make: a tag is created here,
     * in a hurry, under whatever was being typed, so the screen that renames one
     * and takes one away has to be reachable from the place that makes them.
     * Absent on a view spanning several spaces, where there is no single place
     * to send anybody.
     */
    spaceId?: string;
    disabled?: boolean;
}) {
    const t = useTranslations("tasks");
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    // The same guard as `creating`, readable in the tick it is set. State is not:
    // two enters in one tick - a key held down, an enter that reaches both the
    // field and the highlighted item - would both see "not creating yet" and make
    // the tag twice, and the second one comes back refused because the name is
    // now taken.
    const busy = useRef(false);
    const needle = query.trim().toLowerCase();
    const matches = tags.filter((tag) => menuSearchMatches(tag.name, query));
    const existing = tags.find((tag) => tag.name.toLowerCase() === needle);

    /** As the assignee picker does: the field is emptied and handed the keyboard
     *  back, so the tag after this one is typed rather than aimed at. */
    const toggle = (id: string, from: EventTarget | null) => {
        onChange(
            selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]
        );
        setQuery("");
        refocusMenuSearch(from);
    };

    /**
     * Type a name, press enter, get that tag: it is put on the task if it
     * already exists and made first if it does not. Reaching for the mouse to
     * confirm a name you have just finished typing is the kind of step that
     * stops people tagging anything at all.
     *
     * Only an exact name counts as "it exists". Typing "back" while a "backend"
     * exists means "back", and picking the near miss is what leaves work filed
     * under a tag nobody meant.
     */
    const submit = async () => {
        const name = query.trim();
        if (!name || busy.current) return;
        if (existing) {
            if (!selected.includes(existing.id)) onChange([...selected, existing.id]);
            setQuery("");
            return;
        }
        if (!onCreate) return;
        busy.current = true;
        setCreating(true);
        try {
            const id = await onCreate(name);
            if (!id) return;
            onChange([...selected, id]);
            setQuery("");
        } finally {
            busy.current = false;
            setCreating(false);
        }
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                <button
                    type="button"
                    aria-label={t("pickers.tags")}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <Plus className="size-3.5" /> {t("pickers.tag")}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 pt-2">
                {(tags.length > 0 || onCreate) && (
                    <MenuSearch
                        value={query}
                        onChange={setQuery}
                        onSubmit={() => void submit()}
                        placeholder={onCreate ? t("pickers.findOrCreateTag") : t("pickers.findTag")}
                    />
                )}
                <div className="max-h-56 overflow-y-auto overscroll-contain">
                    {matches.length === 0 && !onCreate && (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                            {t("pickers.noTagMatches")}
                        </p>
                    )}
                    {matches.map((tag) => (
                        <DropdownMenuItem
                            key={tag.id}
                            onSelect={(event) => {
                                event.preventDefault();
                                toggle(tag.id, event.currentTarget);
                            }}
                            className="gap-2"
                        >
                            <StatusDot color={tag.color} />
                            <span className="flex-1 truncate">{tag.name}</span>
                            {selected.includes(tag.id) && (
                                <Check className="size-3.5 text-primary" />
                            )}
                        </DropdownMenuItem>
                    ))}
                    {onCreate && needle.length > 0 && !existing && (
                        <DropdownMenuItem
                            disabled={creating}
                            onSelect={(event) => {
                                event.preventDefault();
                                void submit();
                            }}
                            className="gap-2"
                        >
                            <Plus className="size-3.5" />
                            <span className="flex-1 truncate">
                                {t("pickers.createTag", { name: query.trim() })}
                            </span>
                            <span className="text-[0.625rem] text-muted-foreground">
                                {t("pickers.enterKey")}
                            </span>
                        </DropdownMenuItem>
                    )}
                </div>
                {spaceId && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild className="gap-2 text-muted-foreground">
                            <Link href={`/tasks/s/${spaceId}?tab=Tags`}>
                                <Settings2 className="size-3.5" />
                                {t("pickers.editTags")}
                            </Link>
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// ---------------------------------------------------------------------------
// Dates and durations
// ---------------------------------------------------------------------------

/** An ISO instant as the value a date input wants, in local time. */
export function toDateInput(iso: string | null, withTime: boolean): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (value: number) => String(value).padStart(2, "0");
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return withTime ? `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

/**
 * What a date input gives back, as an ISO instant.
 *
 * A day on its own is read in local time, the way `toDateInput` writes one back:
 * `new Date("2026-08-10")` is UTC midnight, which is the evening of the ninth for
 * everybody west of Greenwich, so the round trip would hand the field back a date
 * nobody picked. A day with a time on it is already local by the same rule.
 */
export function fromDateInput(value: string): string | null {
    if (!value) return null;
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!day) {
        const timed = new Date(value);
        return Number.isNaN(timed.getTime()) ? null : timed.toISOString();
    }
    const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const parsed = new Date(year, month - 1, date);
    // Built from parts rather than parsed, so a day the calendar does not have is
    // read back rather than trusted: the thirty-first of February rolls forward
    // into March instead of failing the way a parse would.
    const real =
        parsed.getFullYear() === year &&
        parsed.getMonth() === month - 1 &&
        parsed.getDate() === date;
    return real ? parsed.toISOString() : null;
}

export function DateField({
    value,
    timed,
    onChange,
    label,
    disabled
}: {
    value: string | null;
    timed: boolean;
    onChange: (iso: string | null) => void;
    label: string;
    disabled?: boolean;
}) {
    const t = useTranslations("tasks");
    return (
        <div className="flex items-center gap-1">
            {/* Two date boxes stack on a phone, and stacked they are two identical
                boxes: which is the start and which is the due date is only in the
                label a mouse never reaches on one. */}
            <span className="w-16 shrink-0 text-[0.6875rem] text-muted-foreground sm:hidden">
                {label}
            </span>
            <input
                type={timed ? "datetime-local" : "date"}
                aria-label={label}
                disabled={disabled}
                value={toDateInput(value, timed)}
                onChange={(event) => onChange(fromDateInput(event.target.value))}
                className="rounded-md border border-border bg-field px-2 py-1 text-xs text-foreground hover:border-border-strong focus:border-border-strong disabled:opacity-50"
            />
            {value && !disabled && (
                <button
                    type="button"
                    onClick={() => onChange(null)}
                    aria-label={t("pickers.clearField", { label: label.toLowerCase() })}
                    title={t("pickers.clearField", { label: label.toLowerCase() })}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <X className="size-3.5" />
                </button>
            )}
        </div>
    );
}

/**
 * An estimate box that speaks the way people write estimates. It holds the raw
 * text while it is being typed and only reports a value once the text parses, so
 * "2h 3" is not read as three minutes on its way to "2h 30m".
 */
export function DurationField({
    minutes,
    onChange,
    disabled,
    placeholder = "2h 30m"
}: {
    minutes: number | null;
    onChange: (minutes: number | null) => void;
    disabled?: boolean;
    placeholder?: string;
}) {
    const t = useTranslations("tasks");
    const [text, setText] = useState(core.formatDurationMinutes(minutes));
    const lastCommitted = useRef(minutes);

    // Follow the task when it changes underneath (another tab, an automation),
    // but never while the box is mid-edit.
    useEffect(() => {
        if (lastCommitted.current !== minutes) {
            lastCommitted.current = minutes;
            setText(core.formatDurationMinutes(minutes));
        }
    }, [minutes]);

    const invalid = text.trim() !== "" && core.parseDurationMinutes(text) === null;

    const commit = () => {
        const trimmed = text.trim();
        if (trimmed === "") {
            lastCommitted.current = null;
            onChange(null);
            return;
        }
        const parsed = core.parseDurationMinutes(trimmed);
        if (parsed === null) {
            setText(core.formatDurationMinutes(lastCommitted.current));
            return;
        }
        lastCommitted.current = parsed;
        setText(core.formatDurationMinutes(parsed));
        onChange(parsed);
    };

    return (
        <div>
            <Input
                value={text}
                disabled={disabled}
                placeholder={placeholder}
                onChange={(event) => setText(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                aria-invalid={invalid}
                className="h-8 w-28 text-xs"
            />
            {invalid && (
                <p className="mt-1 text-[0.6875rem] text-danger">{t("pickers.durationHint")}</p>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

/** A due date rendered with the urgency it actually has. */
export function DueBadge({
    dueDate,
    statusType,
    timed,
    format
}: {
    dueDate: string | null;
    statusType: core.TaskStatusType;
    timed: boolean;
    format: (iso: string) => string;
}) {
    const t = useTranslations("tasks");
    if (!dueDate) return null;
    const bucket = core.dueBucket({ dueDate: new Date(dueDate), statusType, timed }, new Date());
    const tone =
        bucket === "overdue"
            ? "text-danger"
            : bucket === "today"
              ? "text-warning"
              : "text-muted-foreground";
    return (
        <span
            className={cn("whitespace-nowrap text-xs", tone)}
            title={optionLabel(t, "dueBucket", bucket)}
        >
            {format(dueDate)}
        </span>
    );
}

/**
 * The marker on a row that is held up, and what is holding it.
 *
 * A flag on its own only says "go and open this to find out", which is the trip
 * the board exists to save. The reason is one short line by construction, so it
 * goes in the label - and since three different things can hold work, the marker
 * names whichever of them apply rather than guessing at one.
 */
export function BlockedMarker({
    task,
    format
}: {
    task: Pick<TaskRow, "blocked" | "blockedUntil" | "blockedNote">;
    format: (iso: string) => string;
}) {
    const t = useTranslations("tasks");
    if (!task.blocked) return null;
    const reasons = [
        task.blockedNote || null,
        task.blockedUntil ? t("pickers.until", { date: format(task.blockedUntil) }) : null
    ].filter((reason): reason is string => reason !== null);
    // Nothing written down and no date means the block is an unfinished task,
    // which the panel lists and a row has no room for.
    const label =
        reasons.length > 0
            ? t("pickers.blockedReasons", { reasons: reasons.join(" - ") })
            : t("pickers.blockedByWork");

    return (
        <span className="inline-flex shrink-0" title={label} aria-label={label} role="img">
            <Ban aria-hidden className="size-3.5 shrink-0 text-warning" />
        </span>
    );
}

export function ProgressBar({ percent, className }: { percent: number; className?: string }) {
    return (
        <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
            <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
            />
        </div>
    );
}

/**
 * Setting a due date without leaving the row. The date input lives in a menu
 * rather than in the row itself, because a row full of empty date boxes is a row
 * nobody can read - the affordance appears where the date would be.
 */
export function DuePicker({
    dueDate,
    timed,
    onChange,
    disabled,
    trigger
}: {
    dueDate: string | null;
    timed: boolean;
    onChange: (iso: string | null) => void;
    disabled?: boolean;
    trigger?: React.ReactNode;
}) {
    const t = useTranslations("tasks");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                {trigger ?? (
                    <button
                        type="button"
                        aria-label={t("pickers.dueDate")}
                        title={t("pickers.setDueDate")}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <CalendarPlus className="size-3.5" />
                    </button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto p-2">
                <div className="flex items-center gap-2">
                    <input
                        autoFocus
                        type={timed ? "datetime-local" : "date"}
                        aria-label={t("pickers.dueDate")}
                        value={toDateInput(dueDate, timed)}
                        onChange={(event) => onChange(fromDateInput(event.target.value))}
                        className="rounded-md border border-border bg-field px-2 py-1 text-xs text-foreground hover:border-border-strong focus:border-border-strong"
                    />
                    {dueDate && (
                        <button
                            type="button"
                            onClick={() => onChange(null)}
                            aria-label={t("pickers.clearDueDate")}
                            title={t("pickers.clearDueDate")}
                            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <X className="size-3.5" />
                        </button>
                    )}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
