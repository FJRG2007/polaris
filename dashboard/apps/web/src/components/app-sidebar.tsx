"use client";

/**
 * Per-app left sidebar. Shows the options for whichever app the user is in
 * (resolved from the path), so the rail's contents follow the top-left app
 * switcher. Presentational and path-driven; the AppShell handles the responsive
 * behavior (on narrow viewports the same list is rendered inside the header's
 * navigation drawer instead of beside the content).
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { usePathname } from "next/navigation";
import { APP_SECTIONS, isSectionActive, resolveActiveApp } from "@/lib/apps";

export function AppSidebar() {
    const pathname = usePathname();
    const app = resolveActiveApp(pathname);
    // Hidden sections still nest under a root, so the whole list decides what is
    // an exact match even though only some of it is drawn.
    const sections = APP_SECTIONS[app.id] ?? [];
    const items = sections.filter((section) => !section.hidden);
    if (items.length === 0) return null;

    return (
        <nav className="flex flex-col gap-1">
            <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {app.label}
            </p>
            {items.map((item) => {
                const active = isSectionActive(pathname, item.href, sections);
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
