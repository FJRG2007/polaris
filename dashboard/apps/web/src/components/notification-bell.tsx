"use client";

/**
 * Top-bar notification bell. Polls the feed for the unread count and the latest
 * items, shows a badge, and opens a dropdown of recent alerts with a link to the
 * full page. Polling (not websockets) keeps it simple and works behind any proxy;
 * the interval is coarse because notifications here are not time-critical.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bell, Info, ShieldAlert, ShieldCheck } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    cn
} from "@polaris/ui";
import { RelativeTime } from "@/components/relative-time";
import { markAllNotificationsReadAction } from "@/app/(app)/notifications/actions";

interface FeedItem {
    id: string;
    type: string;
    title: string;
    body: string | null;
    href: string | null;
    level: "info" | "success" | "warning" | "danger";
    read: boolean;
    createdAt: string;
}

function levelIcon(level: FeedItem["level"]) {
    if (level === "danger") return { Icon: ShieldAlert, color: "text-danger" };
    if (level === "warning") return { Icon: AlertTriangle, color: "text-amber-500" };
    if (level === "success") return { Icon: ShieldCheck, color: "text-success" };
    return { Icon: Info, color: "text-muted-foreground" };
}

export function NotificationBell() {
    const [unread, setUnread] = useState(0);
    const [items, setItems] = useState<FeedItem[]>([]);

    async function refresh() {
        try {
            const res = await fetch("/api/notifications", { cache: "no-store" });
            if (!res.ok) return;
            const body = (await res.json()) as { unread?: number; items?: FeedItem[] };
            setUnread(body.unread ?? 0);
            setItems(body.items ?? []);
        } catch {
            // Transient fetch failure: keep the last known state and retry next tick.
        }
    }

    useEffect(() => {
        void refresh();
        const timer = setInterval(() => void refresh(), 60000);
        return () => clearInterval(timer);
    }, []);

    async function markAll() {
        setUnread(0);
        setItems((prev) => prev.map((item) => ({ ...item, read: true })));
        await markAllNotificationsReadAction();
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                className="relative grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
            >
                <Bell className="size-4" />
                {unread > 0 ? (
                    <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-medium leading-4 text-white">
                        {unread > 9 ? "9+" : unread}
                    </span>
                ) : null}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
                <div className="flex items-center justify-between px-2 py-1.5">
                    <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
                    {unread > 0 ? (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.preventDefault();
                                void markAll();
                            }}
                            className="text-xs text-primary hover:underline"
                        >
                            Mark all read
                        </button>
                    ) : null}
                </div>
                <DropdownMenuSeparator />
                {items.length === 0 ? (
                    <p className="px-2 py-6 text-center text-xs text-muted-foreground">You&apos;re all caught up.</p>
                ) : (
                    <div className="max-h-80 overflow-auto">
                        {items.slice(0, 8).map((item) => {
                            const { Icon, color } = levelIcon(item.level);
                            return (
                                <DropdownMenuItem key={item.id} asChild>
                                    <Link href={item.href && item.href.startsWith("/") ? item.href : "/notifications"}>
                                        <Icon className={cn("mt-0.5 size-4 shrink-0", color)} />
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-1.5">
                                                {!item.read ? (
                                                    <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                                                ) : null}
                                                <span className="truncate text-sm">{item.title}</span>
                                            </span>
                                            <span className="block truncate text-xs text-muted-foreground">
                                                <RelativeTime iso={item.createdAt} />
                                            </span>
                                        </span>
                                    </Link>
                                </DropdownMenuItem>
                            );
                        })}
                    </div>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link href="/notifications" className="justify-center text-sm text-muted-foreground">
                        View all
                    </Link>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
