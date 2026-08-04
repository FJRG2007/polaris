"use client";

/**
 * Top-bar notification bell. Reads the shared live feed, so the badge follows
 * every change immediately - including one made on the notifications page - and
 * new alerts appear without a reload. The dropdown lists the most recent few and
 * links to the full history.
 */

import Link from "next/link";
import { Bell } from "lucide-react";
import { badgeLabel } from "@/lib/notification-badge";
import { RelativeTime } from "@/components/relative-time";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import { describeAudience, levelStyle } from "@/components/notifications/notification-visuals";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    cn
} from "@polaris/ui";

/** How many alerts the dropdown previews before sending the user to the page. */
const PREVIEW_COUNT = 8;

export function NotificationBell() {
    const { items, unread, markAllRead, markRead } = useNotificationFeed();
    const badge = badgeLabel(unread);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                className="relative grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
            >
                <Bell className="size-4" />
                {badge ? (
                    <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-medium leading-4 text-white">
                        {badge}
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
                                markAllRead();
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
                        {items.slice(0, PREVIEW_COUNT).map((item) => {
                            const { Icon, color } = levelStyle(item.level, item.type);
                            const audience = describeAudience(item.audience, item.audienceLabel);
                            return (
                                <DropdownMenuItem key={item.id} asChild onSelect={() => markRead(item.id)}>
                                    <Link
                                        href={
                                            item.href && item.href.startsWith("/")
                                                ? item.href
                                                : "/account/notifications"
                                        }
                                    >
                                        <Icon className={cn("mt-0.5 size-3.5 shrink-0", color)} />
                                        <span className="min-w-0 flex-1">
                                            <span className="flex items-center gap-1.5">
                                                {!item.read ? (
                                                    <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                                                ) : null}
                                                <span className="truncate text-[13px]">{item.title}</span>
                                            </span>
                                            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                                <RelativeTime iso={item.createdAt} />
                                                <span aria-hidden="true">-</span>
                                                <span className="truncate">{audience.text}</span>
                                                {item.actionRequired ? (
                                                    <span className="shrink-0 text-warning">Action needed</span>
                                                ) : null}
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
                    <Link href="/account/notifications" className="justify-center text-sm text-muted-foreground">
                        View all
                    </Link>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
