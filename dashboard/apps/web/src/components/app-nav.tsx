"use client";

/** Wraps the app switcher, marking the active app from the current path. Which
 *  apps are listed is decided on the server from what this account may open, so
 *  an account whose role reaches nothing sees an empty switcher rather than a row
 *  of links that turn it away.
 *
 *  `guestAppIds` names the entries this account only reaches through a subject
 *  the app carries rather than through the app itself - a member reaching Inbox
 *  inside Management - which are drawn under that subject's name and lead to it.
 *  Calling it Management would offer them a page that turns them away. */

import Link from "next/link";
import { AppSwitcher } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { POLARIS_APPS, resolveActiveApp } from "@/lib/apps";

export function AppNav({ appIds, guestAppIds = [] }: { appIds: string[]; guestAppIds?: string[] }) {
    const pathname = usePathname();
    const allowed = new Set(appIds);
    const asGuest = new Set(guestAppIds);
    const apps = POLARIS_APPS.filter((app) => allowed.has(app.id)).map((app) =>
        asGuest.has(app.id) && app.guest
            ? { ...app, label: app.guest.label, description: app.guest.description, href: app.guest.href }
            : app
    );
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
        />
    );
}
