"use client";

/** Wraps the app switcher, marking the active app from the current path.
 *  Admin-only apps (Management) are hidden from non-admins. */

import { usePathname } from "next/navigation";
import { AppSwitcher } from "@polaris/ui";
import { POLARIS_APPS, resolveActiveApp } from "@/lib/apps";

export function AppNav({ isAdmin = false }: { isAdmin?: boolean }) {
    const pathname = usePathname();
    const apps = POLARIS_APPS.filter((app) => !app.adminOnly || isAdmin);
    const current = resolveActiveApp(pathname);
    return <AppSwitcher apps={apps} currentAppId={current.id} />;
}
