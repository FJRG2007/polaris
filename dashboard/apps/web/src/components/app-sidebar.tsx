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
import * as nav from "@/lib/apps";
import { ChevronLeft } from "lucide-react";
import { usePathname } from "next/navigation";
import { hasOrgPermission } from "@polaris/core";
import { badgeLabel } from "@/lib/notification-badge";
import { useChatUnread } from "@/components/chat-unread";
import { useOrgNav } from "@/components/use-org-nav";
import { useInstalledNav } from "@/components/use-installed-nav";

export function AppSidebar({ appIds = [] }: { appIds?: string[] }) {
    const pathname = usePathname();
    const app = nav.resolveActiveApp(pathname);
    // Null everywhere except inside an organization, where it says what this
    // reader may open. Absent until it arrives, which draws the baseline rail.
    const org = useOrgNav(nav.orgSlugForPath(pathname));
    // The same, for an installed app: the path carries an id, and what that id is
    // called and which of its screens this reader may open only the server knows.
    // A bridge or a database answers with no screens and keeps the Apps rail.
    const installedId = nav.installedAppIdForPath(pathname);
    const installed = useInstalledNav(installedId);
    const subapp =
        (installedId && installed ? nav.installedAppSubapp(installedId, installed) : null) ?? nav.resolveSubapp(pathname);

    // Hidden sections still nest under a root, so the whole list decides what is
    // an exact match even though only some of it is drawn.
    //
    // The Overview is the exception: it belongs to no app's list of screens
    // because it is a window onto all of them, which left the rail empty on the
    // one screen where somebody has not yet decided where they are going. Its
    // rail is the apps themselves.
    const sections = subapp
        ? subapp.sections
        : app.id === nav.OVERVIEW_APP_ID
          ? appRail(appIds)
          : (nav.APP_SECTIONS[app.id] ?? []);
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
    const heading = subapp ? (org?.name ?? subapp.label) : app.id === nav.OVERVIEW_APP_ID ? "Apps" : app.label;
    const groups: { label: string; items: nav.AppSection[] }[] = [];
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
                <div key={group.label} className={cn("flex flex-col gap-0.5", index > 0 && "mt-4")}>
                    <p className="px-2 pb-1 text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle">
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

/** The apps this account can open, as rail entries. The Overview itself is left
 *  out: it is the screen the rail is being drawn on. */
function appRail(appIds: readonly string[]): nav.AppSection[] {
    return nav.POLARIS_APPS.filter((app) => app.id !== nav.OVERVIEW_APP_ID && appIds.includes(app.id)).map((app) => ({
        label: app.label,
        href: app.href,
        icon: app.icon
    }));
}

/** The Chat entry, by the one thing a rail entry is keyed on. Read off the
 *  app list rather than written again, so a move takes the badge with it. */
const CHAT_HREF = nav.POLARIS_APPS.find((app) => app.id === "chat")?.href ?? "/chat";

function RailLink({
    item,
    pathname,
    sections
}: {
    item: nav.AppSection;
    pathname: string;
    sections: readonly nav.AppSection[];
}) {
    const active = nav.isSectionActive(pathname, item.href, sections);
    const Icon = item.icon;
    const waiting = useChatUnread();
    // Only on Chat, and only when there is something. A count beside every entry
    // would be a rail of numbers; what this answers is "is anybody waiting for
    // me", which is a question about one app.
    const unread = item.href === CHAT_HREF ? waiting.messages : 0;
    // The active row is the one place the rail spends colour: a faint accent fill
    // and an accent icon. Everything else is a hover away and stays neutral, so
    // where you are is readable at a glance rather than hunted for.
    return (
        <Link
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
                "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[0.8125rem] leading-5 text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground",
                active && "bg-primary/15 font-medium text-foreground hover:bg-primary/15"
            )}
        >
            <Icon className={cn("size-4 shrink-0", active ? "text-primary" : "text-foreground-subtle")} />
            <span className="truncate" title={item.label}>{item.label}</span>
            {unread > 0 ? (
                <span
                    aria-label={`${unread} unread ${unread === 1 ? "message" : "messages"}`}
                    title={`${unread} unread ${unread === 1 ? "message" : "messages"}`}
                    className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-[0.6875rem] font-medium leading-4 text-primary-foreground"
                >
                    {badgeLabel(unread)}
                </span>
            ) : null}
        </Link>
    );
}
