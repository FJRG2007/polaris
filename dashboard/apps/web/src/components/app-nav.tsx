"use client";

/** Wraps the app switcher, marking the active app from the current path. Which
 *  apps are listed is decided on the server from what this account may open, so
 *  an account whose role reaches nothing sees an empty switcher rather than a row
 *  of links that turn it away. */

import { AppSwitcher } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { POLARIS_APPS, resolveActiveApp } from "@/lib/apps";

export function AppNav({ appIds }: { appIds: string[] }) {
    const pathname = usePathname();
    const allowed = new Set(appIds);
    const apps = POLARIS_APPS.filter((app) => allowed.has(app.id));
    const current = resolveActiveApp(pathname);
    return (
        <AppSwitcher
            apps={apps}
            currentAppId={current.id}
            currentApp={current.hidden ? current : undefined}
        />
    );
}
