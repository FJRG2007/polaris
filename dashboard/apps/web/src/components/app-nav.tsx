"use client";

/** Wraps the app switcher, marking the active app from the current path. */

import { usePathname } from "next/navigation";
import { AppSwitcher } from "@polaris/ui";
import { POLARIS_APPS } from "@/lib/apps";

export function AppNav() {
    const pathname = usePathname();
    const current =
        POLARIS_APPS.find((app) => pathname === app.href || pathname.startsWith(`${app.href}/`)) ??
        POLARIS_APPS[0];
    return <AppSwitcher apps={POLARIS_APPS} currentAppId={current?.id ?? "drive"} />;
}
