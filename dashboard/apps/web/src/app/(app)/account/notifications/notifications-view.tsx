"use client";

/**
 * The alert history. The top of the list is the shared live feed, so it stays
 * current while open and any change here is reflected in the bell at once;
 * anything older than the feed holds is paged in from the server on demand.
 *
 * A history is something people come to looking for one thing they half
 * remember, so it is searched rather than only scrolled: the search is fuzzy and
 * runs over what a row actually says - its title, its body and the name of its
 * event - which is what makes a mistyped word still find the row. It is narrowed
 * by what state a row is in, ordered either way round, and rows can be picked
 * off and dealt with together, because clearing thirty of one kind one X at a
 * time is not clearing them.
 *
 * Everything here happens against the rows already loaded. The event filter
 * travels with the "load older" request as well, so a narrowed list can still be
 * answered from the pages behind it.
 */

import Fuse from "fuse.js";
import Link from "next/link";
import { RelativeTime } from "@/components/relative-time";
import { loadNotificationHistoryAction } from "./actions";
import type { NotificationView } from "@/lib/notification-service";
import { NOTIFICATION_EVENTS, notificationEvent } from "@polaris/core";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { Badge, Button, Card, CardBody, Checkbox, Input, Select, cn } from "@polaris/ui";
import { Bell, Check, CheckCheck, ChevronDown, Loader2, Search, Trash2, X } from "lucide-react";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import { NotificationFace } from "@/components/notifications/notification-face";
import { describeAudience } from "@/components/notifications/notification-visuals";

/**
 * The unfiltered choice. Radix forbids an empty-string item value, and event ids
 * are dotted names, so this cannot collide with one.
 */
const ALL_EVENTS = "*";

/** What a row is, beyond which event it came from. */
const STATES = [
    { value: "all", label: "Everything" },
    { value: "unread", label: "Unread" },
    { value: "read", label: "Read" },
    { value: "action", label: "Action needed" }
] as const;

type StateFilter = (typeof STATES)[number]["value"];

const ORDERS = [
    { value: "newest", label: "Newest first" },
    { value: "oldest", label: "Oldest first" },
    { value: "unread", label: "Unread first" }
] as const;

type Order = (typeof ORDERS)[number]["value"];

/** A row with the name of its event folded in, which is what the search reads
 *  and what the row prints. Worked out once: twice is how the two come to
 *  disagree. */
type SearchableRow = NotificationView & { eventLabel: string };

/**
 * Fuzzy search over what a row says.
 *
 * A threshold and field weights rather than the defaults: a title is what people
 * remember and the body is where the detail is, and a search loose enough to
 * forgive a typo is also loose enough to match nothing in particular if it is
 * let run over an id.
 */
function searchIndex(rows: readonly SearchableRow[]): Fuse<SearchableRow> {
    return new Fuse([...rows], {
        threshold: 0.35,
        ignoreLocation: true,
        keys: [
            { name: "title", weight: 3 },
            { name: "body", weight: 2 },
            { name: "eventLabel", weight: 1 }
        ]
    });
}

export function NotificationsView() {
    const { items, unread, markRead, markAllRead, remove, clearAll, markManyRead, removeMany } =
        useNotificationFeed();
    const [older, setOlder] = useState<NotificationView[]>([]);
    const [ended, setEnded] = useState(false);
    const [loading, startLoading] = useTransition();
    const [event, setEvent] = useState(ALL_EVENTS);
    const [state, setState] = useState<StateFilter>("all");
    const [order, setOrder] = useState<Order>("newest");
    const [query, setQuery] = useState("");
    const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

    // The live feed owns the recent end of the list, so anything paged in that
    // it also holds is dropped rather than shown twice - and a row deleted from
    // the feed must not reappear from the older page.
    const merged = useMemo<SearchableRow[]>(() => {
        const live = new Set(items.map((row) => row.id));
        return [...items, ...older.filter((row) => !live.has(row.id))].map((row) => ({
            ...row,
            eventLabel: notificationEvent(row.type)?.label ?? ""
        }));
    }, [items, older]);

    const narrowed = useMemo(
        () =>
            merged.filter((row) => {
                if (event !== ALL_EVENTS && row.type !== event) return false;
                if (state === "unread" && row.read) return false;
                if (state === "read" && !row.read) return false;
                if (state === "action" && !row.actionRequired) return false;
                return true;
            }),
        [merged, event, state]
    );

    // A fuzzy search has an order of its own - how well each row matched - and
    // overriding it with "newest" would throw away the only thing that makes a
    // loose match useful. So a search keeps its ranking, and the order picker
    // applies to everything else.
    const fuse = useMemo(() => searchIndex(narrowed), [narrowed]);
    const needle = query.trim();
    const rows = useMemo(() => {
        if (needle) return fuse.search(needle).map((hit) => hit.item);
        const sorted = [...narrowed];
        if (order === "oldest") sorted.reverse();
        // Stable, so the unread keep the order they were already in rather than
        // being shuffled among themselves.
        if (order === "unread") sorted.sort((left, right) => Number(left.read) - Number(right.read));
        return sorted;
    }, [fuse, needle, narrowed, order]);

    // Only what is on screen: an id a filter has since hidden is not something a
    // bulk verb should quietly write to.
    const shown = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
    const selected = useMemo(() => [...picked].filter((id) => shown.has(id)), [picked, shown]);
    const allShownPicked = rows.length > 0 && selected.length === rows.length;
    const narrowing = event !== ALL_EVENTS || state !== "all" || needle !== "";

    function toggle(id: string) {
        setPicked((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    function loadOlder() {
        const oldest = merged.at(-1)?.createdAt ?? null;
        startLoading(async () => {
            const page = await loadNotificationHistoryAction({
                before: oldest,
                event: event === ALL_EVENTS ? null : event
            });
            setOlder((current) => [...current, ...page.items]);
            if (!page.cursor) setEnded(true);
        });
    }

    const eventOptions = [
        { value: ALL_EVENTS, label: "All events" },
        ...NOTIFICATION_EVENTS.map((entry) => ({ value: entry.id, label: entry.label }))
    ];

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
                <label className="relative min-w-0 flex-1 sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={(changed) => setQuery(changed.target.value)}
                        placeholder="Search notifications"
                        aria-label="Search notifications"
                        className="pl-8"
                    />
                </label>
                {/* Event names run long ("Someone locked out of their account"),
                    so the filter gets the room to show one whole on a laptop and
                    the full width of a phone. */}
                <div className="w-full sm:w-64">
                    <Select
                        value={event}
                        onValueChange={(value) => {
                            setEvent(value);
                            setOlder([]);
                            setEnded(false);
                        }}
                        options={eventOptions}
                        aria-label="Filter by event"
                    />
                </div>
                <div className="w-full sm:w-40">
                    <Select
                        value={state}
                        onValueChange={(value) => setState(value as StateFilter)}
                        options={STATES.map((entry) => ({ value: entry.value, label: entry.label }))}
                        aria-label="Filter by state"
                    />
                </div>
                <div className="w-full sm:w-40">
                    <Select
                        value={order}
                        onValueChange={(value) => setOrder(value as Order)}
                        // A search ranks by how well each row matched, so a
                        // position among those rows is not one anybody chose.
                        disabled={needle !== ""}
                        options={ORDERS.map((entry) => ({ value: entry.value, label: entry.label }))}
                        aria-label="Order"
                    />
                </div>
                <Button size="sm" variant="ghost" onClick={markAllRead} disabled={unread === 0}>
                    <CheckCheck className="size-4" />
                    <span className="hidden sm:inline">Mark all read</span>
                </Button>
                <Button size="sm" variant="ghost" onClick={clearAll} disabled={items.length === 0}>
                    <Trash2 className="size-4" />
                    <span className="hidden sm:inline">Clear all</span>
                </Button>
            </div>

            {/* The bar for what is picked. It replaces nothing and hides nothing:
                the two buttons above act on the whole feed and these on the
                selection, and a screen where "Clear all" and "Delete" traded
                places depending on what was ticked is a screen somebody deletes
                the wrong thing from. */}
            {selected.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface/40 px-3 py-2">
                    <span className="text-sm">
                        {selected.length === 1 ? "1 selected" : `${selected.length} selected`}
                    </span>
                    <span className="flex-1" />
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            markManyRead(selected);
                            setPicked(new Set());
                        }}
                    >
                        <Check className="size-4" />
                        Mark read
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                            removeMany(selected);
                            setPicked(new Set());
                        }}
                    >
                        <Trash2 className="size-4" />
                        Delete
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                        <X className="size-4" />
                        Clear selection
                    </Button>
                </div>
            ) : null}

            {rows.length === 0 ? (
                <Card>
                    <CardBody className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                        <Bell className="size-6" />
                        {narrowing ? "Nothing here matches that." : "You have no notifications."}
                    </CardBody>
                </Card>
            ) : (
                <Card>
                    <div className="flex items-center gap-2.5 border-b border-border px-3 py-2">
                        <Checkbox
                            checked={allShownPicked}
                            indeterminate={selected.length > 0 && !allShownPicked}
                            onChange={() =>
                                setPicked(allShownPicked ? new Set() : new Set(rows.map((row) => row.id)))
                            }
                            aria-label={allShownPicked ? "Clear selection" : "Select everything listed"}
                        />
                        <span className="text-xs text-muted-foreground">
                            {rows.length === 1 ? "1 notification" : `${rows.length} notifications`}
                        </span>
                    </div>
                    <ul className="divide-y divide-border">
                        {rows.map((row) => (
                            <NotificationRow
                                key={row.id}
                                row={row}
                                picked={picked.has(row.id)}
                                onPick={() => toggle(row.id)}
                                onRead={() => markRead(row.id)}
                                onRemove={() => remove(row.id)}
                            />
                        ))}
                    </ul>
                </Card>
            )}

            {/* Still offered when the filters matched nothing on screen: the
                older pages are exactly where their matches would be. */}
            {!ended && (rows.length > 0 || narrowing) ? (
                <div className="flex justify-center">
                    <Button size="sm" variant="ghost" onClick={loadOlder} disabled={loading}>
                        {loading ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
                        Load older
                    </Button>
                </div>
            ) : null}
        </div>
    );
}

function NotificationRow({
    row,
    picked,
    onPick,
    onRead,
    onRemove
}: {
    row: NotificationView;
    picked: boolean;
    onPick: () => void;
    onRead: () => void;
    onRemove: () => void;
}) {
    const audience = describeAudience(row.audience, row.audienceLabel);
    const label = notificationEvent(row.type)?.label ?? null;

    return (
        <li
            className={cn(
                "flex items-start gap-2.5 px-3 py-2.5",
                !row.read && "bg-primary/5",
                picked && "bg-primary/10"
            )}
        >
            <Checkbox
                checked={picked}
                onChange={onPick}
                className="mt-0.5"
                aria-label={`Select ${row.title}`}
            />
            <NotificationFace row={row} className="mt-0.5" />
            <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-[0.8125rem] font-medium leading-5">
                    {!row.read ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
                    {row.href ? (
                        <NotificationLink href={row.href} onOpen={onRead}>
                            {row.title}
                        </NotificationLink>
                    ) : (
                        <span className="truncate">{row.title}</span>
                    )}
                </p>
                {row.body ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{row.body}</p> : null}
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground/70">
                    <RelativeTime iso={row.createdAt} />
                    <span aria-hidden="true">-</span>
                    <span title={audience.hint}>{audience.text}</span>
                    {label ? (
                        <>
                            <span aria-hidden="true">-</span>
                            <span>{label}</span>
                        </>
                    ) : null}
                    {row.actionRequired ? (
                        <Badge variant="warning" className="px-1.5 py-0 text-[0.625rem]">
                            Action needed
                        </Badge>
                    ) : null}
                </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
                {!row.read ? (
                    <RowAction label="Mark as read" onClick={onRead} className="hover:text-success">
                        <Check className="size-3.5" />
                    </RowAction>
                ) : null}
                <RowAction label="Delete" onClick={onRemove} className="hover:text-danger">
                    <X className="size-3.5" />
                </RowAction>
            </div>
        </li>
    );
}

/** The title as a link, internal or external, that marks the row read on open. */
function NotificationLink({
    href,
    onOpen,
    children
}: {
    href: string;
    onOpen: () => void;
    children: string;
}) {
    const className = "truncate hover:underline";
    if (href.startsWith("/")) {
        return (
            <Link href={href} onClick={onOpen} className={className}>
                {children}
            </Link>
        );
    }
    return (
        <a href={href} target="_blank" rel="noreferrer noopener" onClick={onOpen} className={className}>
            {children}
        </a>
    );
}

/** An icon-only row control. Repeated per row, so it carries no text label. */
function RowAction({
    label,
    onClick,
    className,
    children
}: {
    label: string;
    onClick: () => void;
    className?: string;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className={cn(
                "rounded p-1 text-muted-foreground transition-colors ",
                className
            )}
        >
            {children}
        </button>
    );
}
