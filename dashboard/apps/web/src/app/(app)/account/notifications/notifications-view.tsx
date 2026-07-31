"use client";

/**
 * The alert history. The top of the list is the shared live feed, so it stays
 * current while open and any change here is reflected in the bell at once;
 * anything older than the feed holds is paged in from the server on demand.
 * Each row can be marked read or removed on its own; the list actions cover the
 * whole feed.
 */

import { useMemo, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { Bell, Check, CheckCheck, ChevronDown, Loader2, Trash2, X } from "lucide-react";
import { Badge, Button, Card, CardBody, Select, cn } from "@polaris/ui";
import { NOTIFICATION_EVENTS, notificationEvent } from "@polaris/core";
import { RelativeTime } from "@/components/relative-time";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import { describeAudience, levelStyle } from "@/components/notifications/notification-visuals";
import type { NotificationView } from "@/lib/notification-service";
import { loadNotificationHistoryAction } from "./actions";

export function NotificationsView() {
    const { items, unread, markRead, markAllRead, remove, clearAll } = useNotificationFeed();
    const [older, setOlder] = useState<NotificationView[]>([]);
    const [ended, setEnded] = useState(false);
    const [loading, startLoading] = useTransition();
    const [event, setEvent] = useState("");

    // The live feed owns the recent end of the list, so anything paged in that
    // it also holds is dropped rather than shown twice - and a row deleted from
    // the feed must not reappear from the older page.
    const rows = useMemo(() => {
        const live = new Set(items.map((row) => row.id));
        const merged = [...items, ...older.filter((row) => !live.has(row.id))];
        return event ? merged.filter((row) => row.type === event) : merged;
    }, [items, older, event]);

    function loadOlder() {
        const oldest = rows.at(-1)?.createdAt ?? null;
        startLoading(async () => {
            const page = await loadNotificationHistoryAction({ before: oldest, event: event || null });
            setOlder((current) => [...current, ...page.items]);
            if (!page.cursor) setEnded(true);
        });
    }

    const eventOptions = [
        { value: "", label: "All events" },
        ...NOTIFICATION_EVENTS.map((entry) => ({ value: entry.id, label: entry.label }))
    ];

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-end gap-2">
                <div className="mr-auto w-48">
                    <Select
                        value={event}
                        onValueChange={(value) => {
                            setEvent(value);
                            setOlder([]);
                            setEnded(false);
                        }}
                        options={eventOptions}
                    />
                </div>
                <Button size="sm" variant="ghost" onClick={markAllRead} disabled={unread === 0}>
                    <CheckCheck className="size-4" />
                    Mark all read
                </Button>
                <Button size="sm" variant="ghost" onClick={clearAll} disabled={items.length === 0}>
                    <Trash2 className="size-4" />
                    Clear all
                </Button>
            </div>

            {rows.length === 0 ? (
                <Card>
                    <CardBody className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                        <Bell className="size-6" />
                        {event ? "Nothing of that kind yet." : "You have no notifications."}
                    </CardBody>
                </Card>
            ) : (
                <Card>
                    <ul className="divide-y divide-border">
                        {rows.map((row) => (
                            <NotificationRow
                                key={row.id}
                                row={row}
                                onRead={() => markRead(row.id)}
                                onRemove={() => remove(row.id)}
                            />
                        ))}
                    </ul>
                </Card>
            )}

            {/* Still offered when a filter matched nothing on screen: the older
                pages are exactly where its matches would be. */}
            {!ended && (rows.length > 0 || event !== "") ? (
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
    onRead,
    onRemove
}: {
    row: NotificationView;
    onRead: () => void;
    onRemove: () => void;
}) {
    const { Icon, color } = levelStyle(row.level, row.type);
    const audience = describeAudience(row.audience, row.audienceLabel);
    const label = notificationEvent(row.type)?.label ?? null;

    return (
        <li className={cn("flex items-start gap-2.5 px-3 py-2.5", !row.read && "bg-primary/5")}>
            <Icon className={cn("mt-0.5 size-3.5 shrink-0", color)} />
            <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 text-[13px] font-medium leading-5">
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
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/70">
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
                        <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
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
                "rounded p-1 text-muted-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                className
            )}
        >
            {children}
        </button>
    );
}
