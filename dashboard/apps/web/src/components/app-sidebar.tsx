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
import {
    Activity,
    Blocks,
    Clock,
    Contact,
    Container,
    Database,
    FolderOpen,
    Globe,
    Inbox,
    LayoutDashboard,
    Link2,
    MessagesSquare,
    Radio,
    Rocket,
    ScrollText,
    Server,
    Settings,
    ShieldCheck,
    Star,
    Store,
    Trash2,
    Users,
    UsersRound,
    type LucideIcon
} from "lucide-react";
import { cn } from "@polaris/ui";
import { resolveActiveApp } from "@/lib/apps";

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
        { label: "Favorites", href: "/favorites", icon: Star },
        { label: "Recent", href: "/drive/recent", icon: Clock },
        { label: "Shared links", href: "/drive/shared-links", icon: Link2 },
        { label: "Drop points", href: "/drive/drop-points", icon: Inbox },
        { label: "Trash", href: "/trash", icon: Trash2 }
    ],
    apps: [
        { label: "Marketplace", href: "/apps/marketplace", icon: Store },
        { label: "Deploy", href: "/apps/deploy", icon: Rocket },
        { label: "Servers", href: "/apps/servers", icon: Server },
        { label: "Containers", href: "/apps/containers", icon: Container },
        { label: "Backups", href: "/apps/backups", icon: Database }
    ],
    inbox: [
        { label: "Conversations", href: "/inbox", icon: MessagesSquare },
        { label: "Contacts", href: "/inbox/contacts", icon: Contact },
        { label: "Channels", href: "/inbox/channels", icon: Radio },
        { label: "Logs", href: "/inbox/logs", icon: ScrollText }
    ],
    admin: [
        { label: "Overview", href: "/admin", icon: LayoutDashboard },
        { label: "Users", href: "/admin/users", icon: Users },
        { label: "Groups", href: "/admin/groups", icon: UsersRound },
        { label: "Policies", href: "/admin/policies", icon: ShieldCheck },
        { label: "Activity", href: "/admin/activity", icon: Activity },
        { label: "Domains", href: "/admin/domains", icon: Globe },
        { label: "Integrations", href: "/integrations", icon: Blocks },
        { label: "Updates & settings", href: "/settings", icon: Settings }
    ]
};

/** Section roots that must match their own path exactly, so they do not stay
 *  highlighted while a sibling sub-route is open. */
const EXACT_MATCH = new Set(["/drive", "/admin", "/inbox"]);

export function AppSidebar() {
    const pathname = usePathname();
    const app = resolveActiveApp(pathname);
    const items = APP_SIDEBARS[app.id] ?? [];
    if (items.length === 0) return null;

    return (
        <nav className="flex flex-col gap-1">
            <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {app.label}
            </p>
            {items.map((item) => {
                const active = EXACT_MATCH.has(item.href)
                    ? pathname === item.href
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
