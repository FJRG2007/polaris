"use client";

/**
 * The notifications list. Renders newest-first, colors each row by severity, and
 * lets the user open a linked notification (marking it read), mark everything
 * read, or clear the list. Optimistic: local state updates immediately and the
 * server action reconciles behind it.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, Bell, CheckCheck, Info, ShieldAlert, ShieldCheck, Trash2, X } from "lucide-react";
import { Button, Card, CardBody, cn } from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import type { NotificationView } from "@/lib/notification-service";
import {
    clearNotificationsAction,
    deleteNotificationAction,
    markAllNotificationsReadAction,
    markNotificationReadAction
} from "./actions";

/** Icon and accent color for a notification level. */
function levelStyle(level: NotificationView["level"], type: string) {
    if (level === "danger") return { Icon: ShieldAlert, color: "text-danger" };
    if (level === "warning") return { Icon: AlertTriangle, color: "text-amber-500" };
    if (level === "success") return { Icon: type.startsWith("scan") ? ShieldCheck : CheckCheck, color: "text-success" };
    return { Icon: Info, color: "text-muted-foreground" };
}

export function NotificationsView({ items }: { items: NotificationView[] }) {
    const [rows, setRows] = useState(items);
    const [, startTransition] = useTransition();

    function markRead(id: string) {
        setRows((prev) => prev.map((row) => (row.id === id ? { ...row, read: true } : row)));
        startTransition(() => markNotificationReadAction(id));
    }

    function markAll() {
        setRows((prev) => prev.map((row) => ({ ...row, read: true })));
        startTransition(() => markAllNotificationsReadAction());
    }

    function remove(id: string) {
        setRows((prev) => prev.filter((row) => row.id !== id));
        startTransition(() => deleteNotificationAction(id));
    }

    function clearAll() {
        setRows([]);
        startTransition(() => clearNotificationsAction());
    }

    if (rows.length === 0) {
        return (
            <Card>
                <CardBody className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                    <Bell className="size-6" />
                    You have no notifications.
                </CardBody>
            </Card>
        );
    }

    const hasUnread = rows.some((row) => !row.read);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={markAll} disabled={!hasUnread}>
                    <CheckCheck className="size-4" />
                    Mark all read
                </Button>
                <Button size="sm" variant="ghost" onClick={clearAll}>
                    <Trash2 className="size-4" />
                    Clear all
                </Button>
            </div>
            {rows.map((row) => {
                const { Icon, color } = levelStyle(row.level, row.type);
                const body = (
                    <div className="flex items-start gap-3">
                        <Icon className={cn("mt-0.5 size-4 shrink-0", color)} />
                        <div className="min-w-0 flex-1">
                            <p className="flex items-center gap-2 text-sm font-medium">
                                {!row.read ? <span className="size-2 shrink-0 rounded-full bg-primary" /> : null}
                                <span className="truncate">{row.title}</span>
                            </p>
                            {row.body ? <p className="mt-0.5 text-xs text-muted-foreground">{row.body}</p> : null}
                            <p className="mt-1 text-xs text-muted-foreground/70">
                                <RelativeTime iso={row.createdAt} />
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={(event) => {
                                event.preventDefault();
                                remove(row.id);
                            }}
                            className="rounded p-1 text-muted-foreground hover:text-danger"
                            aria-label="Dismiss"
                        >
                            <X className="size-4" />
                        </button>
                    </div>
                );
                return (
                    <Card key={row.id} className={cn(!row.read && "border-primary/40")}>
                        <CardBody className="p-3">
                            {row.href ? (
                                row.href.startsWith("/") ? (
                                    <Link href={row.href} onClick={() => markRead(row.id)}>
                                        {body}
                                    </Link>
                                ) : (
                                    <a
                                        href={row.href}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        onClick={() => markRead(row.id)}
                                    >
                                        {body}
                                    </a>
                                )
                            ) : (
                                <button type="button" className="w-full text-left" onClick={() => markRead(row.id)}>
                                    {body}
                                </button>
                            )}
                        </CardBody>
                    </Card>
                );
            })}
        </div>
    );
}
