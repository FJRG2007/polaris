"use client";

/**
 * Header notification bell. Polls the current user's notifications on a slow
 * interval, shows an unread count on the icon, and lists the most recent items in
 * a dropdown. Opening the menu marks everything read (clearing the badge). Items
 * that carry a deep link navigate; the rest are informational. Silent on any
 * error - a failed poll must never disrupt the chrome.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bell, Info } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";

interface NotificationItem {
    id: string;
    type: string;
    title: string;
    body: string | null;
    data: { href?: string } | null;
    read: boolean;
    createdAt: string;
}

/** Re-poll every 60s; cheap count query, so this stays quiet in the background. */
const POLL_INTERVAL_MS = 60 * 1000;

/** Pick an icon for a notification type (security alerts stand out). */
function iconFor(type: string) {
    if (type.startsWith("security")) return AlertTriangle;
    return Info;
}

export function NotificationBell() {
    const [items, setItems] = useState<NotificationItem[]>([]);
    const [unread, setUnread] = useState(0);

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/notifications");
            if (!res.ok) return;
            const body = (await res.json()) as { notifications: NotificationItem[]; unread: number };
            setItems(body.notifications);
            setUnread(body.unread);
        } catch {
            // Leave the current state; the next poll retries.
        }
    }, []);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [load]);

    async function markAllRead() {
        if (unread === 0) return;
        setUnread(0);
        setItems((prev) => prev.map((item) => ({ ...item, read: true })));
        try {
            await fetch("/api/notifications/read", { method: "POST", body: "{}" });
        } catch {
            // Optimistic; the next poll reconciles if the write failed.
        }
    }

    function onOpenChange(open: boolean) {
        if (open) void markAllRead();
    }

    return (
        <DropdownMenu onOpenChange={onOpenChange}>
            <DropdownMenuTrigger
                className="relative grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
            >
                <Bell className="size-[18px]" />
                {unread > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-medium leading-4 text-white">
                        {unread > 9 ? "9+" : unread}
                    </span>
                ) : null}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel>Notifications</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {items.length === 0 ? (
                    <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                        You&apos;re all caught up.
                    </p>
                ) : (
                    <div className="max-h-96 overflow-y-auto">
                        {items.map((item) => {
                            const Icon = iconFor(item.type);
                            const href = item.data?.href;
                            const content = (
                                <div className="flex items-start gap-2 px-2 py-2">
                                    <Icon
                                        className={`mt-0.5 size-4 shrink-0 ${
                                            item.type.startsWith("security") ? "text-danger" : "text-muted-foreground"
                                        }`}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-foreground">{item.title}</p>
                                        {item.body ? (
                                            <p className="text-xs text-muted-foreground">{item.body}</p>
                                        ) : null}
                                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                                            <RelativeTime iso={item.createdAt} />
                                        </p>
                                    </div>
                                    {!item.read ? (
                                        <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                                    ) : null}
                                </div>
                            );
                            return href ? (
                                <a key={item.id} href={href} className="block rounded-md hover:bg-muted">
                                    {content}
                                </a>
                            ) : (
                                <div key={item.id} className="rounded-md">
                                    {content}
                                </div>
                            );
                        })}
                    </div>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
