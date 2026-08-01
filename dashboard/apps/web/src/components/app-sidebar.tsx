"use client";

/**
 * Per-app left sidebar. Shows the options for whichever app the user is in
 * (resolved from the path), so the rail's contents follow the top-left app
 * switcher. Presentational and path-driven; the AppShell handles the responsive
 * behavior (the rail is hidden on narrow viewports, where the top switcher and
 * account menu still provide navigation).
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { APP_SECTIONS, resolveActiveApp } from "@/lib/apps";

/** Section roots that must match their own path exactly, so they do not stay
 *  highlighted while a sibling sub-route is open. */
const EXACT_MATCH = new Set(["/drive", "/admin", "/inbox", "/account"]);

export function AppSidebar() {
    const pathname = usePathname();
    const app = resolveActiveApp(pathname);
    const items = (APP_SECTIONS[app.id] ?? []).filter((section) => !section.hidden);
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
