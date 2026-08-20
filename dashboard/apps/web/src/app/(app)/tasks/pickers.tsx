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
import { Avatar, preloadAvatars } from "@/components/avatar";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PersonRef, TagRef, TaskRow } from "@/lib/tasks/facts";
import type { StatusView, TagView } from "@/lib/tasks/space-service";
import { PriorityFlag } from "@/components/priority-flag";
import { Ban, CalendarPlus, Check, ChevronDown, Flag, Plus, Settings2, UserPlus, X } from "lucide-react";
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
    menuSearchMatches
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
    const [query, setQuery] = useState("");
    const matches = useMemo(
        () => people.filter((person) => menuSearchMatches(person.name, query)),
        [people, query]
    );

    const toggle = (id: string) =>
        onChange(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);

    return (
        // The faces are asked for as the menu opens rather than as it draws, so
        // the list is readable the moment it appears instead of filling in.
        <DropdownMenu onOpenChange={(open) => (open ? preloadAvatars(people) : undefined)}>
            <DropdownMenuTrigger asChild disabled={disabled}>
                {trigger ?? (
                    <button
                        type="button"
                        aria-label="Assignees"
                        title="Assign somebody"
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
                {people.length > 0 && <MenuSearch value={query} onChange={setQuery} placeholder="Find someone" />}
                <div className="max-h-64 overflow-y-auto">
                    {matches.length === 0 && (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                            {people.length === 0 ? "Nobody is on this space yet." : "Nobody matches that."}
                        </p>
                    )}
                    {matches.map((person) => (
                        <DropdownMenuItem
                            key={person.id}
                            onSelect={(event) => {
                                event.preventDefault();
                                toggle(person.id);
                            }}
                            className="gap-2"
                        >
                            <Avatar person={person} size={20} />
                            <span className="flex-1 truncate">{person.name}</span>
                            {selected.includes(person.id) && <Check className="size-3.5 text-primary" />}
                        </DropdownMenuItem>
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
            className={cn("flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground", className)}
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

/**
 * What a state looks like, as a shape rather than only a colour.
 *
 * One shape per stage of the work, so a row is readable at a glance and stays
 * readable to somebody who cannot tell the colours apart:
 *
 *   - not started: a broken ring, open and clearly empty
 *   - under way: a ring with the middle filled in
 *   - held up: a ring with the middle barred, the way a hold reads everywhere
 *   - finished: a solid disc with a tick
 *
 * Drawn rather than composed out of borders because a dashed CSS border on a
 * 20px circle renders as an uneven smudge, and the tick has to sit dead centre
 * at every size a row, a card and a menu use.
 */
export function StatusIcon({
    color,
    type,
    size = 20,
    className
}: {
    color: string;
    type: core.TaskStatusType;
    size?: number;
    className?: string;
}) {
    const finished = core.isFinishedStatus(type);
    return (
        <svg
            aria-hidden
            viewBox="0 0 20 20"
            width={size}
            height={size}
            className={cn("shrink-0", className)}
            style={{ color }}
        >
            {finished ? (
                <>
                    <circle cx="10" cy="10" r="9" fill="currentColor" />
                    <path
                        d="M5.8 10.3l2.7 2.7 5.7-5.7"
                        fill="none"
                        stroke="#fff"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                </>
            ) : (
                <>
                    <circle
                        cx="10"
                        cy="10"
                        r="8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        // Eight even dashes around the circumference: work that
                        // has not started reads as an outline somebody has yet
                        // to close, not as a state of its own.
                        {...(type === "open"
                            ? { strokeDasharray: "3.6 2.7", strokeLinecap: "round" as const }
                            : {})}
                    />
                    {core.isBlockedStatus(type) ? (
                        <path
                            d="M6.4 10h7.2"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                        />
                    ) : (
                        type !== "open" && <circle cx="10" cy="10" r="4" fill="currentColor" />
                    )}
                </>
            )}
        </svg>
    );
}

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
                        aria-label="Status"
                        className={cn(
                            "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-muted",
                            compact && "border-transparent px-1.5"
                        )}
                        style={current ? { color: current.color } : undefined}
                    >
                        <StatusIcon color={current?.color ?? "#64748b"} type={current?.type ?? "open"} size={14} />
                        <span className="truncate">{current?.name ?? "No status"}</span>
                        {!compact && <ChevronDown className="size-3 opacity-60" />}
                    </button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 pt-2">
                <MenuSearch value={query} onChange={setQuery} placeholder="Find a status" />
                <div className="max-h-64 overflow-y-auto">
                    {matches.length === 0 && (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">No status matches that.</p>
                    )}
                    {matches.map((status) => (
                        <DropdownMenuItem key={status.id} onSelect={() => onChange(status.id)} className="gap-2">
                            <StatusIcon color={status.color} type={status.type} size={16} />
                            <span className="flex-1 truncate">{status.name}</span>
                            {status.id === value ? (
                                <Check className="size-3.5 text-primary" />
                            ) : (
                                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {core.TASK_STATUS_TYPE_LABELS[status.type]}
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
                                Edit statuses
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
                    aria-label={`Status: ${statusName}`}
                    className="inline-flex size-5 shrink-0 items-center justify-center transition-transform hover:scale-110 disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <StatusIcon color={statusColor} type={statusType} />
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
export { PriorityFlag };

export function PriorityPicker({
    value,
    onChange,
    disabled,
    trigger
}: {
    value: core.TaskPriority;
    onChange: (priority: core.TaskPriority) => void;
    disabled?: boolean;
    trigger?: React.ReactNode;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                {trigger ?? (
                    <button
                        type="button"
                        aria-label="Priority"
                        title={core.TASK_PRIORITY_LABELS[value]}
                        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        {value === "none" ? <Flag className="size-3.5 opacity-50" /> : <PriorityFlag priority={value} />}
                    </button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
                <p className="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Priority</p>
                {core.TASK_PRIORITIES.filter((priority) => priority !== "none").map((priority) => (
                    <DropdownMenuItem key={priority} onSelect={() => onChange(priority)} className="gap-2">
                        <Flag
                            className="size-3.5"
                            fill={core.TASK_PRIORITY_COLORS[priority]}
                            style={{ color: core.TASK_PRIORITY_COLORS[priority] }}
                        />
                        <span className="flex-1">{core.TASK_PRIORITY_LABELS[priority]}</span>
                        {value === priority && <Check className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                ))}
                {/* "No priority" is the absence of the others, so it reads as the
                    way out of the menu rather than a fifth thing to pick. */}
                <DropdownMenuItem onSelect={() => onChange("none")} className="gap-2 text-muted-foreground">
                    <Ban className="size-3.5" />
                    <span className="flex-1">Clear</span>
                    {value === "none" && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
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
const TAG_PALETTE = ["#3b82f6", "#8b5cf6", "#ec4899", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#64748b"] as const;

export function tagColorFor(name: string): string {
    let hash = 0;
    for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) % 997;
    return TAG_PALETTE[hash % TAG_PALETTE.length] as string;
}

export function TagChip({ tag, onRemove }: { tag: TagRef | TagView; onRemove?: () => void }) {
    return (
        <Badge
            variant="neutral"
            className="gap-1 border-transparent text-[11px]"
            style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
        >
            {tag.name}
            {onRemove && (
                <button type="button" onClick={onRemove} aria-label={`Remove ${tag.name}`} className="opacity-70 hover:opacity-100">
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
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const needle = query.trim().toLowerCase();
    const matches = tags.filter((tag) => menuSearchMatches(tag.name, query));
    const existing = tags.find((tag) => tag.name.toLowerCase() === needle);

    const toggle = (id: string) =>
        onChange(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);

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
        if (!name || creating) return;
        if (existing) {
            if (!selected.includes(existing.id)) onChange([...selected, existing.id]);
            setQuery("");
            return;
        }
        if (!onCreate) return;
        setCreating(true);
        const id = await onCreate(name);
        setCreating(false);
        if (!id) return;
        onChange([...selected, id]);
        setQuery("");
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                <button
                    type="button"
                    aria-label="Tags"
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <Plus className="size-3.5" /> Tag
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 pt-2">
                {(tags.length > 0 || onCreate) && (
                    <MenuSearch
                        value={query}
                        onChange={setQuery}
                        onSubmit={() => void submit()}
                        placeholder={onCreate ? "Find or create a tag" : "Find a tag"}
                    />
                )}
                <div className="max-h-56 overflow-y-auto">
                    {matches.length === 0 && !onCreate && (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">No tag matches that.</p>
                    )}
                    {matches.map((tag) => (
                        <DropdownMenuItem
                            key={tag.id}
                            onSelect={(event) => {
                                event.preventDefault();
                                toggle(tag.id);
                            }}
                            className="gap-2"
                        >
                            <StatusDot color={tag.color} />
                            <span className="flex-1 truncate">{tag.name}</span>
                            {selected.includes(tag.id) && <Check className="size-3.5 text-primary" />}
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
                            <span className="flex-1 truncate">Create &ldquo;{query.trim()}&rdquo;</span>
                            <span className="text-[10px] text-muted-foreground">Enter</span>
                        </DropdownMenuItem>
                    )}
                </div>
                {spaceId && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild className="gap-2 text-muted-foreground">
                            <Link href={`/tasks/s/${spaceId}?tab=Tags`}>
                                <Settings2 className="size-3.5" />
                                Edit tags
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
    const real = parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === date;
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
    return (
        <div className="flex items-center gap-1">
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
                    aria-label={`Clear ${label.toLowerCase()}`}
                    title={`Clear ${label.toLowerCase()}`}
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
            {invalid && <p className="mt-1 text-[11px] text-danger">Try 2h 30m, 1d or 90</p>}
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
    if (!dueDate) return null;
    const bucket = core.dueBucket(
        { dueDate: new Date(dueDate), statusType, timed },
        new Date()
    );
    const tone =
        bucket === "overdue"
            ? "text-danger"
            : bucket === "today"
              ? "text-amber-500"
              : "text-muted-foreground";
    return (
        <span className={cn("whitespace-nowrap text-xs", tone)} title={core.DUE_BUCKET_LABELS[bucket]}>
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
    if (!task.blocked) return null;
    const reasons = [
        task.blockedNote || null,
        task.blockedUntil ? `until ${format(task.blockedUntil)}` : null
    ].filter((reason): reason is string => reason !== null);
    // Nothing written down and no date means the block is an unfinished task,
    // which the panel lists and a row has no room for.
    const label = reasons.length > 0 ? `Blocked ${reasons.join(" - ")}` : "Blocked by unfinished work";

    return (
        <span className="inline-flex shrink-0" title={label} aria-label={label} role="img">
            <Ban aria-hidden className="size-3.5 shrink-0 text-amber-500" />
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
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                {trigger ?? (
                    <button
                        type="button"
                        aria-label="Due date"
                        title="Set a due date"
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
                        aria-label="Due date"
                        value={toDateInput(dueDate, timed)}
                        onChange={(event) => onChange(fromDateInput(event.target.value))}
                        className="rounded-md border border-border bg-field px-2 py-1 text-xs text-foreground hover:border-border-strong focus:border-border-strong"
                    />
                    {dueDate && (
                        <button
                            type="button"
                            onClick={() => onChange(null)}
                            aria-label="Clear the due date"
                            title="Clear the due date"
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
