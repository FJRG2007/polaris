"use client";

/** Wraps the app switcher, marking the active app from the current path. Which
 *  apps are listed is decided on the server from what this account may open, so
 *  an account whose role reaches nothing sees an empty switcher rather than a row
 *  of links that turn it away.
 *
 *  `guestAppIds` names the entries this account only reaches through a subject
 *  the app carries rather than through the app itself - a member reaching Inbox
 *  inside Management - which are drawn under that subject's name and lead to it.
 *  Calling it Management would offer them a page that turns them away.
 *
 *  Chat carries a count of what is waiting, and the trigger a dot when it does.
 *  On a phone the trigger is the whole of the navigation, so without the dot a
 *  message was invisible to anybody who was not already in Chat - which is
 *  everybody who is working.
 *
 *  An app that remembered where it was left leads back there rather than to its
 *  front door - see `last-place`. Read after mount rather than during render:
 *  the server has no idea what one browser remembers, and a link that differed
 *  between the two would fail hydration. The recent apps are read the same way,
 *  from the history the Overview's "Recently visited" card keeps
 *  (`recent-places`); the favorites come from the account, through the store the
 *  Overview's rail shares (`favorite-apps`).
 *
 *  Every app is also found by its English name and by its shelf, so somebody
 *  reading in Spanish who types "settings" or "games" still finds it. */

import Link from "next/link";
import * as nav from "@/lib/apps";
import { useEffect, useState } from "react";
import { readPlace } from "@/lib/last-place";
import { usePathname } from "next/navigation";
import { ArrowUpDown, Store } from "lucide-react";
import { launcherLayout } from "@/lib/app-launcher";
import { badgeLabel } from "@/lib/notification-badge";
import { useFavoriteApps } from "@/components/favorite-apps-context";
import { readRecentPlaces } from "@/lib/overview/recent-places";
import { useInstalledNav } from "@/components/use-installed-nav";
import { anythingWaiting, useAppUnread } from "@/components/app-unread";
import {
    AppSwitcher,
    DropdownMenuItem,
    type AppSwitcherSection,
    type PolarisApp
} from "@polaris/ui";
import { ArrangeFavoritesDialog } from "@/components/arrange-favorites-dialog";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";

const CATEGORY_LABEL = new Map<string, string>(
    nav.APP_CATEGORIES.map((category) => [category.id, category.label])
);

export function AppNav({
    appIds,
    guestAppIds = [],
    marketplace = false
}: {
    appIds: string[];
    guestAppIds?: string[];
    /** Whether this account can open the marketplace, for the way to more apps
     *  at the foot of the menu - Google's "More from Google", Slack's directory. */
    marketplace?: boolean;
}) {
    const pathname = usePathname();
    const t = useTranslations("nav");
    const label = useNavLabel();
    // The description an app is listed with, by its id. Every app in the
    // catalogue has one in the `nav` namespace - the catalog test says so - and
    // the catalogue's own English is the answer for one that does not yet.
    const describe = (id: string, key: "description" | "guestDescription", english: string) => {
        const path = `apps.${id}.${key}`;
        return t.has(path) ? t(path as NamespaceKey<"nav">) : english;
    };
    const allowed = new Set(appIds);
    const asGuest = new Set(guestAppIds);
    const waiting = useAppUnread();
    const [places, setPlaces] = useState<Record<string, string>>({});
    const [recent, setRecent] = useState<string[]>([]);
    // A game server's own screens live with the installed apps, and belong to
    // Game servers. The path only says "an installed app"; whether it is a game
    // server is the answer the rail already asks for (a server has screens).
    const installedId = nav.installedAppIdForPath(pathname);
    const installed = useInstalledNav(installedId);

    // Re-read on every navigation: leaving Tasks is the moment the entry that
    // leads back into it becomes wrong, and the moment it becomes recent.
    useEffect(() => {
        const found: Record<string, string> = {};
        for (const app of nav.POLARIS_APPS) {
            const place = readPlace(app.id, app.href);
            if (place) found[app.id] = place;
        }
        setPlaces(found);
        setRecent(readRecentPlaces().map((place) => nav.resolveActiveApp(place.href).id));
    }, [pathname]);

    const apps = nav.POLARIS_APPS.filter((app) => allowed.has(app.id)).map((app) => {
        const category = CATEGORY_LABEL.get(app.category) ?? "";
        const guest = asGuest.has(app.id) && app.guest ? app.guest : null;
        const english = guest ? guest.label : app.label;
        const entry = {
            ...app,
            label: label(english),
            description: guest
                ? describe(app.id, "guestDescription", guest.description)
                : describe(app.id, "description", app.description),
            // A guest reaches the app through a subject rather than through the
            // app, so their entry leads to that subject and never to a
            // remembered screen behind it.
            href: guest ? guest.href : (places[app.id] ?? app.href),
            keywords: [english, label(category), category]
        };
        // Whatever that app has waiting, whichever app it is. Naming them
        // here is what left Mail with a number and no dot beside it.
        const badge = badgeLabel(waiting[app.id] ?? 0);
        return badge ? { ...entry, badge } : entry;
    });
    const isGameServer = installedId !== null && installed !== null && installed.tabs.length > 0;
    const active = isGameServer
        ? (nav.POLARIS_APPS.find((app) => app.id === "games") ?? nav.resolveActiveApp(pathname))
        : nav.resolveActiveApp(pathname);
    const current = { ...active, label: label(active.label) };

    return (
        <AppLauncher
            apps={apps}
            currentAppId={current.id}
            currentApp={current.hidden ? current : undefined}
            recent={recent}
            marketplace={marketplace}
            // The dot on the switcher itself, which is all somebody sees while
            // the list is closed. Derived from what is actually waiting rather
            // than from a list of apps, so the next app to start counting raises
            // it without anybody remembering to.
            alert={anythingWaiting(waiting)}
        />
    );
}

/** An app as the menu lists it: drawn, and filed on a shelf. */
export type LauncherApp = PolarisApp & { readonly category: nav.AppCategory };

/**
 * The menu itself, from a list of apps already resolved for this reader - the
 * favorites, recent apps and shelves, the search, the arranging. Apart from
 * `AppNav` so it can be drawn from any list of apps, which is how it is
 * exercised with more apps than the catalogue holds.
 */
export function AppLauncher({
    apps,
    currentAppId,
    currentApp,
    recent,
    marketplace = false,
    alert = false
}: {
    apps: readonly LauncherApp[];
    currentAppId: string;
    currentApp?: PolarisApp;
    /** App ids, most recent first. */
    recent: readonly string[];
    marketplace?: boolean;
    alert?: boolean;
}) {
    const t = useTranslations("nav");
    const label = useNavLabel();
    const { favorites, toggle, arrange, launcherOpen, setLauncherOpen } = useFavoriteApps();
    const [arranging, setArranging] = useState(false);
    const categoryOf = new Map(apps.map((app) => [app.id, app.category]));
    const layout = launcherLayout({
        available: apps.map((app) => app.id),
        favorites,
        recent,
        categoryOf: (id) => categoryOf.get(id)
    });
    const sections: AppSwitcherSection[] = [
        {
            key: "favorites",
            label: t("switcher.favorites"),
            ids: layout.favorites,
            arrangeable: true
        },
        { key: "recent", label: t("switcher.recent"), ids: layout.recent },
        ...layout.shelves.map((shelf) => ({
            key: shelf.category,
            label: label(CATEGORY_LABEL.get(shelf.category) ?? shelf.category),
            ids: shelf.ids
        }))
    ];

    return (
        <>
            <AppSwitcher
                apps={apps}
                currentAppId={currentAppId}
                currentApp={currentApp}
                sections={sections}
                open={launcherOpen}
                onOpenChange={setLauncherOpen}
                strings={{
                    search: t("switcher.search"),
                    noMatch: (query) => t("switcher.noMatch", { query }),
                    pin: (app) => t("switcher.pin", { app }),
                    unpin: (app) => t("switcher.unpin", { app }),
                    moved: (app, position, total) => t("switcher.moved", { app, position, total })
                }}
                pinned={favorites}
                onTogglePin={toggle}
                onArrange={arrange}
                footer={
                    <>
                        <DropdownMenuItem onSelect={() => setArranging(true)}>
                            <ArrowUpDown className="text-muted-foreground" aria-hidden="true" />
                            {t("switcher.arrange")}
                        </DropdownMenuItem>
                        {marketplace ? (
                            <DropdownMenuItem asChild>
                                <Link href="/apps/marketplace">
                                    <Store className="text-muted-foreground" aria-hidden="true" />
                                    {t("switcher.marketplace")}
                                </Link>
                            </DropdownMenuItem>
                        ) : null}
                    </>
                }
                // Moving between apps keeps the page. An anchor here reloaded the
                // whole dashboard, which among other things hung up on whoever was
                // on the other end of a call.
                linkAs={Link}
                alert={alert}
            />
            <ArrangeFavoritesDialog open={arranging} onOpenChange={setArranging} apps={apps} />
        </>
    );
}
