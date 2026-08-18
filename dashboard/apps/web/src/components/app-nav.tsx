"use client";

/** Wraps the app switcher, marking the active app from the current path. Which
 *  apps are listed is decided on the server from what this account may open, so
 *  an account whose role reaches nothing sees an empty switcher rather than a row
 *  of links that turn it away.
 *
 *  `guestAppIds` names the entries this account only reaches through a subject
 *  the app carries rather than through the app itself - a member reaching Inbox
 *  inside Management - which are drawn under that subject's name and lead to it.
 *  Calling it Management would offer them a page that turns them away.
 *
 *  Chat carries a count of what is waiting, and the trigger a dot when it does.
 *  On a phone the trigger is the whole of the navigation, so without the dot a
 *  message was invisible to anybody who was not already in Chat - which is
 *  everybody who is working. */

import Link from "next/link";
import { AppSwitcher } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { POLARIS_APPS, resolveActiveApp } from "@/lib/apps";
import { badgeLabel } from "@/lib/notification-badge";
import { useChatUnread } from "@/components/chat-unread";

export function AppNav({ appIds, guestAppIds = [] }: { appIds: string[]; guestAppIds?: string[] }) {
    const pathname = usePathname();
    const allowed = new Set(appIds);
    const asGuest = new Set(guestAppIds);
    const waiting = useChatUnread();
    const unread = badgeLabel(waiting.messages);
    const apps = POLARIS_APPS.filter((app) => allowed.has(app.id)).map((app) => {
        const entry =
            asGuest.has(app.id) && app.guest
                ? { ...app, label: app.guest.label, description: app.guest.description, href: app.guest.href }
                : app;
        return app.id === "chat" && unread ? { ...entry, badge: unread } : entry;
    });
    const current = resolveActiveApp(pathname);
    return (
        <AppSwitcher
            apps={apps}
            currentAppId={current.id}
            currentApp={current.hidden ? current : undefined}
            // Moving between apps keeps the page. An anchor here reloaded the
            // whole dashboard, which among other things hung up on whoever was
            // on the other end of a call.
            linkAs={Link}
            alert={Boolean(unread)}
        />
    );
}
