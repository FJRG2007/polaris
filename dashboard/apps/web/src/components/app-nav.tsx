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
 *  between the two would fail hydration. How much each app is used is read the
 *  same way, from this browser's history (`app-usage`); the favorites and the
 *  order the menu was arranged in come from the account, through the store the
 *  Overview's rail shares (`favorite-apps`).
 *
 *  Every app is also found by its English name and by its category, so somebody
 *  reading in Spanish who types "settings" or "games" still finds it. */

import Link from "next/link";
import * as nav from "@/lib/apps";
import { useEffect, useState } from "react";
import { readPlace } from "@/lib/last-place";
import { usePathname } from "next/navigation";
import { readAppUsage } from "@/lib/app-usage";
import { ArrowUpDown, Store } from "lucide-react";
import { badgeLabel } from "@/lib/notification-badge";
import { useFavoriteApps } from "@/components/favorite-apps-context";
import { useInstalledNav } from "@/components/use-installed-nav";
import { anythingWaiting, useAppUnread } from "@/components/app-unread";
import { launcherOrder, type AppUsage } from "@/lib/app-launcher";
import { AppSwitcher, DropdownMenuItem, type PolarisApp } from "@polaris/ui";
import { ArrangeAppsDialog } from "@/components/arrange-apps-dialog";
import { LauncherWaitingList } from "@/components/launcher-waiting";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";

const CATEGORY_LABEL = new Map<string, string>(
    nav.APP_CATEGORIES.map((category) => [category.id, category.label])
);

/** An option under the launcher's grid, drawn as an icon button. */
const FOOTER_ICON =
    "size-8 justify-center p-0 text-muted-foreground hover:text-foreground focus:text-foreground";

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
    const [usage, setUsage] = useState<{ usage: AppUsage; at: number }>({ usage: {}, at: 0 });
    // A game server's own screens live with the installed apps, and belong to
    // Game servers. The path only says "an installed app"; whether it is a game
    // server is the answer the rail already asks for (a server has screens).
    const installedId = nav.installedAppIdForPath(pathname);
    const installed = useInstalledNav(installedId);

    // Re-read on every navigation: leaving Tasks is the moment the entry that
    // leads back into it becomes wrong, and the moment it was used once more.
    useEffect(() => {
        const found: Record<string, string> = {};
        for (const app of nav.POLARIS_APPS) {
            const place = readPlace(app.id, app.href);
            if (place) found[app.id] = place;
        }
        setPlaces(found);
        setUsage({ usage: readAppUsage(), at: Date.now() });
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
            usage={usage.usage}
            now={usage.at}
            marketplace={marketplace}
            // The dot on the switcher itself, which is all somebody sees while
            // the list is closed. Derived from what is actually waiting rather
            // than from a list of apps, so the next app to start counting raises
            // it without anybody remembering to.
            alert={anythingWaiting(waiting)}
        />
    );
}

/**
 * The menu itself, from a list of apps already resolved for this reader - one
 * grid in the reader's order (see `launcherOrder`), the search, the arranging.
 * Apart from `AppNav` so it can be drawn from any list of apps, which is how it
 * is exercised with more apps than the catalogue holds.
 */
export function AppLauncher({
    apps,
    currentAppId,
    currentApp,
    usage = {},
    now = 0,
    marketplace = false,
    alert = false
}: {
    apps: readonly PolarisApp[];
    currentAppId: string;
    currentApp?: PolarisApp;
    /** How much this browser has opened each app. */
    usage?: AppUsage;
    /** When `usage` was read, which is what its decay is measured from. */
    now?: number;
    marketplace?: boolean;
    alert?: boolean;
}) {
    const t = useTranslations("nav");
    const { favorites, order, arrangeApps, launcherOpen, setLauncherOpen } = useFavoriteApps();
    const [arranging, setArranging] = useState(false);
    const ids = launcherOrder({
        available: apps.map((app) => app.id),
        arranged: order,
        favorites,
        usage,
        now
    });

    return (
        <>
            <AppSwitcher
                apps={apps}
                currentAppId={currentAppId}
                currentApp={currentApp}
                order={ids}
                open={launcherOpen}
                onOpenChange={setLauncherOpen}
                strings={{
                    search: t("switcher.search"),
                    noMatch: (query) => t("switcher.noMatch", { query }),
                    moved: (app, position, total) => t("switcher.moved", { app, position, total }),
                    more: t("switcher.more")
                }}
                onArrange={arrangeApps}
                // What each app has waiting, with a way to mark it read without
                // opening the app - see `launcher-waiting`.
                below={<LauncherWaitingList open={launcherOpen} apps={apps} />}
                // Icons only, so the options take one short row under the grid;
                // the words stay as the accessible name and the hover tooltip.
                footer={
                    <>
                        <DropdownMenuItem
                            onSelect={() => setArranging(true)}
                            aria-label={t("switcher.arrange")}
                            title={t("switcher.arrange")}
                            className={FOOTER_ICON}
                        >
                            <ArrowUpDown aria-hidden="true" />
                        </DropdownMenuItem>
                        {marketplace ? (
                            <DropdownMenuItem asChild className={FOOTER_ICON}>
                                <Link
                                    href="/apps/marketplace"
                                    aria-label={t("switcher.marketplace")}
                                    title={t("switcher.marketplace")}
                                >
                                    <Store aria-hidden="true" />
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
            <ArrangeAppsDialog
                open={arranging}
                onOpenChange={setArranging}
                apps={apps}
                order={ids}
            />
        </>
    );
}
