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
 *
 * Every label the catalogue declares is drawn in the reader's language
 * (`useNavLabel`); a name somebody chose - an organization, an installed app -
 * is drawn as it is.
 */

import Link from "next/link";
import { cn } from "@polaris/ui";
import * as nav from "@/lib/apps";
import { railApps } from "@/lib/app-launcher";
import { ChevronLeft, LayoutGrid } from "lucide-react";
import { useFavoriteApps } from "@/components/favorite-apps-context";
import { usePathname } from "next/navigation";
import { hasOrgPermission } from "@polaris/core";
import { railCount } from "@/lib/waiting-counts";
import { useOrgNav } from "@/components/use-org-nav";
import { badgeLabel } from "@/lib/notification-badge";
import { useAppUnread } from "@/components/app-unread";
import { useAdminWaiting } from "@/components/admin-waiting";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { useInstalledNav } from "@/components/use-installed-nav";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

export function AppSidebar({
    appIds = [],
    held = [],
    installed: installedApps = [],
    isAdmin = false
}: {
    appIds?: string[];
    /**
     * The instance permissions this account holds, out of the ones any section
     * names. Resolved on the server and handed down, because whether somebody
     * holds a capability is a policy evaluation rather than a column - roles,
     * groups, policies and the account's own override all get a say - and none
     * of that can be asked from the browser.
     */
    held?: string[];
    /** The marketplace apps installed, out of the ones any section requires.
     *  Resolved on the server for the same reason; absent means none. */
    installed?: string[];
    isAdmin?: boolean;
}) {
    const pathname = usePathname();
    const label = useNavLabel();
    const t = useTranslations("nav");
    const app = nav.resolveActiveApp(pathname);
    const { favorites, order, openLauncher } = useFavoriteApps();
    // Null everywhere except inside an organization, where it says what this
    // reader may open. Absent until it arrives, which draws the baseline rail.
    const org = useOrgNav(nav.orgSlugForPath(pathname));
    // The same, for an installed app: the path carries an id, and what that id is
    // called and which of its screens this reader may open only the server knows.
    // A bridge or a database answers with no screens and keeps the Apps rail.
    const installedId = nav.installedAppIdForPath(pathname);
    const installed = useInstalledNav(installedId);
    const subapp =
        (installedId && installed ? nav.installedAppSubapp(installedId, installed) : null) ??
        nav.resolveSubapp(pathname);

    // Hidden sections still nest under a root, so the whole list decides what is
    // an exact match even though only some of it is drawn.
    //
    // The Overview is the exception: it belongs to no app's list of screens
    // because it is a window onto all of them, which left the rail empty on the
    // one screen where somebody has not yet decided where they are going. Its
    // rail is the apps themselves - only the favorites, in the order the app
    // menu was arranged in, and a way to the rest. Thirty apps in a rail is a
    // list to read; the app menu is where the whole set is searched.
    const onOverview = !subapp && app.id === nav.OVERVIEW_APP_ID;
    const railIds = onOverview ? railApps({ available: appIds, favorites, arranged: order }) : [];
    const moreApps =
        onOverview && appIds.filter((id) => id !== nav.OVERVIEW_APP_ID).length > railIds.length;
    const sections = subapp
        ? subapp.sections
        : onOverview
          ? appRail(railIds)
          : (nav.APP_SECTIONS[app.id] ?? []);
    const items = sections.filter((section) => {
        if (section.hidden) return false;
        // A screen this account cannot open is left out rather than drawn and
        // then refused on the click. Being told "that page is not open to your
        // role" after following a link the app itself offered is the worst of
        // the three: it advertises something, spends a navigation, and says no
        // somewhere nobody can act on it. A screen for an app nobody installed is
        // left out the same way.
        if (!nav.sectionOffered(section, { isAdmin, held, installed: installedApps })) return false;
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
    //
    // Only a subject from the catalogue has a label to translate. An
    // organization's heading is its name or handle, and an installed app's is
    // the name it was given - data, drawn as it is.
    const heading = subapp
        ? (org?.name ?? (nav.APP_SUBAPPS.includes(subapp) ? label(subapp.label) : subapp.label))
        : onOverview && favorites.some((id) => railIds.includes(id))
          ? t("switcher.favorites")
          : label(app.id === nav.OVERVIEW_APP_ID ? "Apps" : app.label);
    const groups: { label: string; items: nav.AppSection[] }[] = [];
    for (const item of items) {
        const title = item.group ? label(item.group) : heading;
        const existing = groups.find((group) => group.label === title);
        if (existing) existing.items.push(item);
        else groups.push({ label: title, items: [item] });
    }

    // Drawn unless the way back leads somewhere this account cannot go.
    const showParent =
        subapp !== null && (!subapp.parentAppId || appIds.includes(subapp.parentAppId));

    return (
        <nav className="flex flex-col gap-1">
            {subapp && showParent ? (
                <Link
                    href={subapp.parent.href}
                    className="mb-1 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <ChevronLeft className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate" title={label(subapp.parent.label)}>
                        {label(subapp.parent.label)}
                    </span>
                </Link>
            ) : null}
            {groups.map((group, index) => (
                <div key={group.label} className={cn("flex flex-col gap-0.5", index > 0 && "mt-4")}>
                    <p
                        className="truncate px-2 pb-1 text-[0.6875rem] font-medium uppercase tracking-wider text-foreground-subtle"
                        title={group.label}
                    >
                        {group.label}
                    </p>
                    {group.items.map((item) => (
                        <RailLink
                            key={item.href}
                            item={item}
                            pathname={pathname}
                            sections={sections}
                            inApp={subapp !== null || app.id !== nav.OVERVIEW_APP_ID}
                        />
                    ))}
                </div>
            ))}
            {moreApps ? (
                // A button rather than a link: it opens the app menu in the top
                // bar, which is where every app is. Marked so the phone drawer
                // this rail is also drawn in closes first.
                <button
                    type="button"
                    data-closes-nav=""
                    onClick={openLauncher}
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[0.8125rem] leading-5 text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
                >
                    <LayoutGrid
                        className="size-4 shrink-0 text-foreground-subtle"
                        aria-hidden="true"
                    />
                    <span className="truncate">{t("switcher.moreApps")}</span>
                </button>
            ) : null}
        </nav>
    );
}

/** These apps, in this order, as rail entries (see `railApps` for which). */
function appRail(appIds: readonly string[]): nav.AppSection[] {
    return appIds.flatMap((id) => {
        const app = nav.POLARIS_APPS.find((candidate) => candidate.id === id);
        return app ? [{ label: app.label, href: app.href, icon: app.icon }] : [];
    });
}

/** The Chat entry, by the one thing a rail entry is keyed on. Read off the
 *  app list rather than written again, so a move takes the badge with it. */
/** Which app a rail entry belongs to, by the address it points at. Built from
 *  the catalogue rather than written out, so an app that starts counting needs
 *  nothing here. */
const APP_BY_HREF: Readonly<Record<string, string>> = Object.fromEntries(
    nav.POLARIS_APPS.map((app) => [app.href, app.id])
);

/**
 * What an app's badge is counting, said in words, for a tooltip and a screen
 * reader.
 *
 * The badge machinery deliberately does not know which app it is drawing (see
 * `app-unread`), so the words are the catalog's: an app that counts something
 * other than messages has its own sentence under `waiting.byApp` - Management
 * counts reports and updates, and "3 unread messages" there would describe a
 * published build as post. Every other app counts messages.
 */
function waitingLabel(appId: string, count: number, t: NamespaceTranslator<"nav">): string {
    const own = `waiting.byApp.${appId}`;
    return t.has(own) ? t(own as NamespaceKey<"nav">, { count }) : t("waiting.unread", { count });
}

function RailLink({
    item,
    pathname,
    sections,
    inApp
}: {
    item: nav.AppSection;
    pathname: string;
    sections: readonly nav.AppSection[];
    /** Whether this rail is one app's screens rather than the list of apps. */
    inApp: boolean;
}) {
    const active = nav.isSectionActive(pathname, item.href, sections);
    const Icon = item.icon;
    const t = useTranslations("nav");
    const label = useNavLabel()(item.label);
    const waiting = useAppUnread();
    const admin = useAdminWaiting();
    // Only where there is something, and on the entry the count is about: an app
    // in the list of apps, or the one screen inside an app that holds it - see
    // `railCount`. A count beside every entry would be a rail of numbers; what
    // this answers is "is anybody waiting for me".
    const appId = APP_BY_HREF[item.href] ?? "";
    const unread = railCount({ href: item.href, appId, inApp, waiting, admin });
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
            <Icon
                className={cn(
                    "size-4 shrink-0",
                    active ? "text-primary" : "text-foreground-subtle"
                )}
            />
            <span className="truncate" title={label}>
                {label}
            </span>
            {unread > 0 ? (
                <span
                    aria-label={waitingLabel(appId, unread, t)}
                    title={waitingLabel(appId, unread, t)}
                    className="ml-auto shrink-0 rounded-full bg-primary px-1.5 text-[0.6875rem] font-medium leading-4 text-primary-foreground"
                >
                    {badgeLabel(unread)}
                </span>
            ) : null}
        </Link>
    );
}
