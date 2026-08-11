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
 * changes what it contains and offers no way out is a place people get stuck. The
 * exception is a subject somebody reaches without reaching the app around it - a
 * member in Inbox, which Management owns - where "back" would be a page that
 * turns them away, and no link at all is the better of the two.
 *
 * Within one list, screens that belong to the same subject sit under a heading of
 * their own (Account's five security screens). A list where nothing names a group
 * is drawn flat, exactly as before.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import { ChevronLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import { hasOrgPermission } from "@polaris/core";
import { useOrgNav } from "@/components/use-org-nav";
import { useInstalledNav } from "@/components/use-installed-nav";
import {
    APP_SECTIONS,
    installedAppIdForPath,
    installedAppSubapp,
    isSectionActive,
    orgSlugForPath,
    resolveActiveApp,
    resolveSubapp,
    type AppSection
} from "@/lib/apps";

export function AppSidebar({ appIds = [] }: { appIds?: string[] }) {
    const pathname = usePathname();
    const app = resolveActiveApp(pathname);
    // Null everywhere except inside an organization, where it says what this
    // reader may open. Absent until it arrives, which draws the baseline rail.
    const org = useOrgNav(orgSlugForPath(pathname));
    // The same, for an installed app: the path carries an id, and what that id is
    // called and which of its screens this reader may open only the server knows.
    // A bridge or a database answers with no screens and keeps the Apps rail.
    const installedId = installedAppIdForPath(pathname);
    const installed = useInstalledNav(installedId);
    const subapp =
        (installedId && installed ? installedAppSubapp(installedId, installed) : null) ?? resolveSubapp(pathname);

    // Hidden sections still nest under a root, so the whole list decides what is
    // an exact match even though only some of it is drawn.
    const sections = subapp ? subapp.sections : (APP_SECTIONS[app.id] ?? []);
    const items = sections.filter((section) => {
        if (section.hidden) return false;
        // Outside an organization - and inside one before the answer arrives -
        // the baseline rail is the entries that ask for nothing.
        if (!org) return !section.permission;
        // Inside one, an entry that names no permission still asks for `org.read`,
        // which every role carries and the owner's successor does not: they are
        // here for the one screen that lets them close it, and nothing else.
        if (section.orgDeleter === true && org.canDelete) return true;
        return hasOrgPermission(org.permissions, section.permission ?? "org.read");
    });
    if (items.length === 0) return null;

    // The ungrouped screens keep the list's own heading; each named group follows
    // in the order it first appears, so the rail reads in the order it is declared.
    // Inside an organization the heading is its name once that is known, and its
    // handle until then - the rail is drawn from the path, and the path only
    // carries the handle.
    const heading = subapp ? (org?.name ?? subapp.label) : app.label;
    const groups: { label: string; items: AppSection[] }[] = [];
    for (const item of items) {
        const label = item.group ?? heading;
        const existing = groups.find((group) => group.label === label);
        if (existing) existing.items.push(item);
        else groups.push({ label, items: [item] });
    }

    // Drawn unless the way back leads somewhere this account cannot go.
    const showParent = subapp !== null && (!subapp.parentAppId || appIds.includes(subapp.parentAppId));

    return (
        <nav className="flex flex-col gap-1">
            {subapp && showParent ? (
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
