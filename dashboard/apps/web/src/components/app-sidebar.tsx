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
import { Clock, Container, FolderOpen, Inbox, LayoutDashboard, Link2, Trash2, type LucideIcon } from "lucide-react";
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
        { label: "Overview", href: "/overview", icon: LayoutDashboard },
        { label: "Files", href: "/drive", icon: FolderOpen },
        { label: "Recent", href: "/drive/recent", icon: Clock },
        { label: "Shared links", href: "/drive/shared-links", icon: Link2 },
        { label: "Drop points", href: "/drive/drop-points", icon: Inbox },
        { label: "Trash", href: "/trash", icon: Trash2 }
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
                // Files ("/drive") matches only itself; the nested drive apps
                // (shared links, drop points) stay highlighted on their subtrees.
                const active =
                    item.href === "/drive"
                        ? pathname === "/drive"
                        : pathname === item.href || pathname.startsWith(`${item.href}/`);
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
