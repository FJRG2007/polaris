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

import * as core from "@polaris/core";
import type { PersonRef, TagRef } from "@/lib/tasks/facts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { StatusView, TagView } from "@/lib/tasks/space-service";
import { Check, ChevronDown, Flag, Plus, Search, X } from "lucide-react";
import { Badge, Checkbox, cn, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Input } from "@polaris/ui";

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Initials from a display name, for an account with no picture. */
function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    return (parts.length === 1 ? parts[0]!.slice(0, 2) : `${parts[0]![0]}${parts[1]![0]}`).toUpperCase();
}

export function Avatar({ person, size = 24 }: { person: PersonRef; size?: number }) {
    return (
        <span
            title={person.name}
            className="inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-1 ring-border"
            style={{ width: size, height: size }}
        >
            {person.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- avatars come from arbitrary external URLs.
                <img src={person.image} alt="" className="size-full rounded-full object-cover" />
            ) : (
                initials(person.name)
            )}
        </span>
    );
}

/** Up to three faces and a "+n", which is as many as a row can carry legibly. */
export function AvatarStack({ people, size = 24 }: { people: readonly PersonRef[]; size?: number }) {
    if (people.length === 0) return null;
    const shown = people.slice(0, 3);
    return (
        <span className="flex items-center -space-x-1.5">
            {shown.map((person) => (
                <Avatar key={person.id} person={person} size={size} />
            ))}
            {people.length > shown.length && (
                <span
                    className="inline-flex items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground ring-1 ring-border"
                    style={{ width: size, height: size }}
                >
                    +{people.length - shown.length}
                </span>
            )}
        </span>
    );
}

/** A menu that filters as you type once the list stops being scannable. */
function MenuSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
    return (
        <div className="flex items-center gap-2 border-b border-border px-2 pb-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
                autoFocus
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
        </div>
    );
}

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
        () => people.filter((person) => person.name.toLowerCase().includes(query.trim().toLowerCase())),
        [people, query]
    );

    const toggle = (id: string) =>
        onChange(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                {trigger ?? (
                    <button
                        type="button"
                        aria-label="Assignees"
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        {selected.length === 0 ? (
                            <Plus className="size-3.5" />
                        ) : (
                            <AvatarStack people={people.filter((person) => selected.includes(person.id))} size={20} />
                        )}
                    </button>
                )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 pt-2">
                {people.length > 6 && <MenuSearch value={query} onChange={setQuery} placeholder="Find someone" />}
                <div className="max-h-64 overflow-y-auto">
                    {matches.length === 0 && (
                        <p className="px-2 py-3 text-center text-xs text-muted-foreground">Nobody matches that.</p>
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

export function StatusPicker({
    statuses,
    value,
    onChange,
    disabled,
    compact
}: {
    statuses: readonly StatusView[];
    value: string | null;
    onChange: (statusId: string) => void;
    disabled?: boolean;
    compact?: boolean;
}) {
    const current = statuses.find((status) => status.id === value);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                <button
                    type="button"
                    className={cn(
                        "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-muted",
                        compact && "border-transparent px-1.5"
                    )}
                    style={current ? { color: current.color } : undefined}
                >
                    <StatusDot color={current?.color ?? "#64748b"} />
                    <span className="truncate">{current?.name ?? "No status"}</span>
                    {!compact && <ChevronDown className="size-3 opacity-60" />}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
                {statuses.map((status) => (
                    <DropdownMenuItem key={status.id} onSelect={() => onChange(status.id)} className="gap-2">
                        <StatusDot color={status.color} />
                        <span className="flex-1 truncate">{status.name}</span>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {core.TASK_STATUS_TYPE_LABELS[status.type]}
                        </span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

export function PriorityFlag({ priority, className }: { priority: core.TaskPriority; className?: string }) {
    if (priority === "none") return null;
    return (
        <Flag
            className={cn("size-3.5 shrink-0", className)}
            style={{ color: core.TASK_PRIORITY_COLORS[priority] }}
            aria-label={core.TASK_PRIORITY_LABELS[priority]}
        />
    );
}

export function PriorityPicker({
    value,
    onChange,
    disabled
}: {
    value: core.TaskPriority;
    onChange: (priority: core.TaskPriority) => void;
    disabled?: boolean;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
                <button
                    type="button"
                    aria-label="Priority"
                    className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    {value === "none" ? <Flag className="size-3.5 opacity-50" /> : <PriorityFlag priority={value} />}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
                {core.TASK_PRIORITIES.map((priority) => (
                    <DropdownMenuItem key={priority} onSelect={() => onChange(priority)} className="gap-2">
                        <Flag className="size-3.5" style={{ color: core.TASK_PRIORITY_COLORS[priority] }} />
                        <span className="flex-1">{core.TASK_PRIORITY_LABELS[priority]}</span>
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
    disabled
}: {
    tags: readonly TagView[];
    selected: readonly string[];
    onChange: (ids: string[]) => void;
    /** Offered when the typed name matches nothing, so a tag can be born where
     *  it is needed instead of in a settings screen. */
    onCreate?: (name: string) => Promise<string | null>;
    disabled?: boolean;
}) {
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const needle = query.trim().toLowerCase();
    const matches = tags.filter((tag) => tag.name.toLowerCase().includes(needle));
    const exact = tags.some((tag) => tag.name.toLowerCase() === needle);

    const toggle = (id: string) =>
        onChange(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);

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
                <MenuSearch value={query} onChange={setQuery} placeholder="Find or create a tag" />
                <div className="max-h-56 overflow-y-auto">
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
                    {onCreate && needle.length > 0 && !exact && (
                        <DropdownMenuItem
                            disabled={creating}
                            onSelect={async (event) => {
                                event.preventDefault();
                                setCreating(true);
                                const id = await onCreate(query.trim());
                                setCreating(false);
                                if (id) {
                                    onChange([...selected, id]);
                                    setQuery("");
                                }
                            }}
                            className="gap-2"
                        >
                            <Plus className="size-3.5" />
                            <span className="truncate">Create &ldquo;{query.trim()}&rdquo;</span>
                        </DropdownMenuItem>
                    )}
                </div>
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

/** What a date input gives back, as an ISO instant. */
export function fromDateInput(value: string): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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
                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
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
            {invalid && <p className="mt-1 text-[11px] text-destructive">Try 2h 30m, 1d or 90</p>}
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
            ? "text-destructive"
            : bucket === "today"
              ? "text-amber-500"
              : "text-muted-foreground";
    return (
        <span className={cn("whitespace-nowrap text-xs", tone)} title={core.DUE_BUCKET_LABELS[bucket]}>
            {format(dueDate)}
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

/** A checkbox that completes a task, which is the single most-used control in
 *  the whole app and therefore gets to be one click everywhere. */
export function CompleteToggle({
    statusType,
    onToggle,
    disabled
}: {
    statusType: core.TaskStatusType;
    onToggle: (complete: boolean) => void;
    disabled?: boolean;
}) {
    const done = core.isFinishedStatus(statusType);
    return (
        <Checkbox
            checked={done}
            disabled={disabled}
            aria-label={done ? "Reopen task" : "Complete task"}
            onChange={(event) => onToggle(event.target.checked)}
        />
    );
}
