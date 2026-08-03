"use client";

/**
 * Per-app left sidebar. Shows the options for whichever app the user is in
 * (resolved from the path), so the rail's contents follow the top-left app
 * switcher. Presentational and path-driven; the AppShell handles the responsive
 * behavior (on narrow viewports the same list is rendered inside the header's
 * navigation drawer instead of beside the content).
 *
 * A few sections are subjects of their own with several screens each - Runners is
 * pools, repositories, runs and secrets. Inside one of those the rail shows that
 * subject instead of the app's list, with a way back at the top: a rail that
 * changes what it contains and offers no way out is a place people get stuck.
 *
 * Within one list, screens that belong to the same subject sit under a heading of
 * their own (Account's five security screens). A list where nothing names a group
 * is drawn flat, exactly as before.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { ChevronLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import { APP_SECTIONS, isSectionActive, resolveActiveApp, resolveSubapp, type AppSection } from "@/lib/apps";

export function AppSidebar() {
    const pathname = usePathname();
    const subapp = resolveSubapp(pathname);
    const app = resolveActiveApp(pathname);

    // Hidden sections still nest under a root, so the whole list decides what is
    // an exact match even though only some of it is drawn.
    const sections = subapp ? subapp.sections : (APP_SECTIONS[app.id] ?? []);
    const items = sections.filter((section) => !section.hidden);
    if (items.length === 0) return null;

    // The ungrouped screens keep the list's own heading; each named group follows
    // in the order it first appears, so the rail reads in the order it is declared.
    const groups: { label: string; items: AppSection[] }[] = [];
    for (const item of items) {
        const label = item.group ?? (subapp ? subapp.label : app.label);
        const existing = groups.find((group) => group.label === label);
        if (existing) existing.items.push(item);
        else groups.push({ label, items: [item] });
    }

    return (
        <nav className="flex flex-col gap-1">
            {subapp ? (
                <Link
                    href={subapp.parent.href}
                    className="mb-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ChevronLeft className="size-3.5" />
                    {subapp.parent.label}
                </Link>
            ) : null}
            {groups.map((group, index) => (
                <div key={group.label} className={cn("flex flex-col gap-1", index > 0 && "mt-3")}>
                    <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {group.label}
                    </p>
                    {group.items.map((item) => (
                        <RailLink key={item.href} item={item} pathname={pathname} sections={sections} />
                    ))}
                </div>
            ))}
        </nav>
    );
}

function RailLink({
    item,
    pathname,
    sections
}: {
    item: AppSection;
    pathname: string;
    sections: readonly AppSection[];
}) {
    const active = isSectionActive(pathname, item.href, sections);
    const Icon = item.icon;
    return (
        <Link
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
}
