"use client";

/**
 * Per-app left sidebar. Shows the options for whichever app the user is in
 * (resolved from the path), so the rail's contents follow the top-left app
 * switcher. Presentational and path-driven; the AppShell handles the responsive
 * behavior (the rail is hidden on narrow viewports, where the top switcher and
 * account menu still provide navigation).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Container, FolderOpen, Link2, type LucideIcon } from "lucide-react";
import { cn } from "@polaris/ui";
import { POLARIS_APPS } from "@/lib/apps";

interface SidebarItem {
    label: string;
    href: string;
    icon: LucideIcon;
}

/** Options per app id. Apps not listed here render no rail. */
const APP_SIDEBARS: Record<string, SidebarItem[]> = {
    drive: [
        { label: "Files", href: "/drive", icon: FolderOpen },
        { label: "Shared links", href: "/shared", icon: Link2 }
    ],
    containers: [{ label: "Containers", href: "/apps/containers", icon: Container }]
};

export function AppSidebar() {
    const pathname = usePathname();
    const app =
        POLARIS_APPS.find((entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`)) ??
        POLARIS_APPS[0];
    const items = app ? (APP_SIDEBARS[app.id] ?? []) : [];
    if (items.length === 0) return null;

    return (
        <nav className="flex flex-col gap-1">
            <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {app?.label}
            </p>
            {items.map((item) => {
                const active = pathname === item.href;
                const Icon = item.icon;
                return (
                    <Link
                        key={item.href}
                        href={item.href}
                        className={cn(
                            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                            active && "bg-muted font-medium"
                        )}
                    >
                        <Icon className="size-4 text-muted-foreground" />
                        {item.label}
                    </Link>
                );
            })}
        </nav>
    );
}
