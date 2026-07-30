"use client";

/**
 * The notifications list. Reads the shared live feed, so it stays current while
 * open and any change here is reflected in the bell at once. Each row can be
 * marked read or removed on its own; the list actions cover the whole feed.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { Bell, Check, CheckCheck, Trash2, X } from "lucide-react";
import { Badge, Button, Card, CardBody, cn } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import { describeAudience, levelStyle } from "@/components/notifications/notification-visuals";

export function NotificationsView() {
    const { items, unread, markRead, markAllRead, remove, clearAll } = useNotificationFeed();

    if (items.length === 0) {
        return (
            <Card>
                <CardBody className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                    <Bell className="size-6" />
                    You have no notifications.
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={markAllRead} disabled={unread === 0}>
                    <CheckCheck className="size-4" />
                    Mark all read
                </Button>
                <Button size="sm" variant="ghost" onClick={clearAll}>
                    <Trash2 className="size-4" />
                    Clear all
                </Button>
            </div>
            <Card>
                <ul className="divide-y divide-border">
                    {items.map((row) => {
                        const { Icon, color } = levelStyle(row.level, row.type);
                        const audience = describeAudience(row.audience, row.audienceLabel);
                        return (
                            <li
                                key={row.id}
                                className={cn("flex items-start gap-2.5 px-3 py-2.5", !row.read && "bg-primary/5")}
                            >
                                <Icon className={cn("mt-0.5 size-3.5 shrink-0", color)} />
                                <div className="min-w-0 flex-1">
                                    <p className="flex items-center gap-1.5 text-[13px] font-medium leading-5">
                                        {!row.read ? (
                                            <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                                        ) : null}
                                        {row.href ? (
                                            <NotificationLink href={row.href} onOpen={() => markRead(row.id)}>
                                                {row.title}
                                            </NotificationLink>
                                        ) : (
                                            <span className="truncate">{row.title}</span>
                                        )}
                                    </p>
                                    {row.body ? (
                                        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{row.body}</p>
                                    ) : null}
                                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground/70">
                                        <RelativeTime iso={row.createdAt} />
                                        <span aria-hidden="true">-</span>
                                        <span title={audience.hint}>{audience.text}</span>
                                        {row.actionRequired ? (
                                            <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                                                Action needed
                                            </Badge>
                                        ) : null}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-0.5">
                                    {!row.read ? (
                                        <RowAction
                                            label="Mark as read"
                                            onClick={() => markRead(row.id)}
                                            className="hover:text-success"
                                        >
                                            <Check className="size-3.5" />
                                        </RowAction>
                                    ) : null}
                                    <RowAction
                                        label="Delete"
                                        onClick={() => remove(row.id)}
                                        className="hover:text-danger"
                                    >
                                        <X className="size-3.5" />
                                    </RowAction>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            </Card>
        </div>
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
