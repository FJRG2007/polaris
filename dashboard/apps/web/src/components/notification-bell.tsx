"use client";

/**
 * Top-bar notification bell. Reads the shared live feed, so the badge follows
 * every change immediately - including one made on the notifications page - and
 * new alerts appear without a reload. The dropdown lists the most recent few and
 * links to the full history.
 *
 * Each unread alert can be cleared on its own here, not only all of them at once.
 * Opening one already marks it read, so without this the only way to put down an
 * alert you have read the whole of in the badge - most of them are one line - was
 * to follow it somewhere you did not want to go, or to clear the ones you had not
 * read with it.
 */

import Link from "next/link";
import { useState } from "react";
import { Bell, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { badgeLabel } from "@/lib/notification-badge";
import { RelativeTime } from "@/components/relative-time";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import { NotificationFace } from "@/components/notifications/notification-face";
import { describeAudience } from "@/components/notifications/notification-visuals";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";

/** How many alerts the dropdown previews before sending the user to the page. */
const PREVIEW_COUNT = 8;

export function NotificationBell() {
    const { items, unread, markAllRead, markRead } = useNotificationFeed();
    const badge = badgeLabel(unread);
    const [open, setOpen] = useState(false);
    const router = useRouter();

    return (
        // Controlled and non-modal for the double press below, the same way the
        // account menu is: a modal menu takes the pointer away from everything
        // behind it, its own trigger included, so the second press of a double
        // never reaches the bell it was aimed at.
        <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
            <DropdownMenuTrigger
                className="relative grid size-8 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground "
                aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
                title={
                    unread > 0
                        ? `Notifications (${unread} unread). Press twice to open them.`
                        : "Notifications. Press twice to open them."
                }
                // Straight to the full list, as your own face goes straight to
                // your own account. The dropdown previews eight; anybody pressing
                // twice wants the page, and going through a menu to press the
                // link named after the thing just pressed is a step for nothing.
                onDoubleClick={() => {
                    setOpen(false);
                    router.push("/account/notifications");
                }}
            >
                <Bell className="size-4" />
                {badge ? (
                    <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[0.625rem] font-medium leading-4 text-white">
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
                            const audience = describeAudience(item.audience, item.audienceLabel);
                            return (
                                <div key={item.id} className="flex items-start">
                                    <DropdownMenuItem
                                        asChild
                                        onSelect={() => markRead(item.id)}
                                        className="min-w-0 flex-1"
                                    >
                                        <Link
                                            href={
                                                item.href && item.href.startsWith("/")
                                                    ? item.href
                                                    : "/account/notifications"
                                            }
                                        >
                                            <NotificationFace row={item} className="mt-0.5" />
                                            <span className="min-w-0 flex-1">
                                                <span className="flex items-center gap-1.5">
                                                    {!item.read ? (
                                                        <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                                                    ) : null}
                                                    <span className="truncate text-[0.8125rem]" title={item.title}>{item.title}</span>
                                                </span>
                                                <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                                                    <RelativeTime iso={item.createdAt} />
                                                    <span aria-hidden="true">-</span>
                                                    <span className="truncate" title={audience.text}>{audience.text}</span>
                                                    {item.actionRequired ? (
                                                        <span className="shrink-0 text-warning">
                                                            Action needed
                                                        </span>
                                                    ) : null}
                                                </span>
                                            </span>
                                        </Link>
                                    </DropdownMenuItem>
                                    {!item.read ? (
                                        <DropdownMenuItem
                                            aria-label={`Mark "${item.title}" as read`}
                                            title="Mark as read"
                                            // The menu stays open: this is a
                                            // control over the list itself, and
                                            // closing after each one would make
                                            // clearing three alerts three trips.
                                            onSelect={(event) => {
                                                event.preventDefault();
                                                markRead(item.id);
                                            }}
                                            // Drawn on every unread row rather
                                            // than revealed on hover: a phone has
                                            // no hover, and this is the same
                                            // control the notifications page
                                            // keeps visible on its own rows.
                                            className="mt-1 shrink-0 px-1.5 text-muted-foreground/70 hover:text-success"
                                        >
                                            <Check className="size-3.5" />
                                        </DropdownMenuItem>
                                    ) : null}
                                </div>
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
