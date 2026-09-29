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
 *  between the two would fail hydration. The recent apps that fill the top row
 *  are read the same way, from the history the Overview's "Recently visited"
 *  card keeps (`recent-places`); the pins come from the account. */

import Link from "next/link";
import * as nav from "@/lib/apps";
import { useEffect, useState } from "react";
import { readPlace } from "@/lib/last-place";
import { usePathname } from "next/navigation";
import { AppSwitcher, useToast } from "@polaris/ui";
import { launcherLayout } from "@/lib/app-launcher";
import { badgeLabel } from "@/lib/notification-badge";
import { readRecentPlaces } from "@/lib/overview/recent-places";
import { useInstalledNav } from "@/components/use-installed-nav";
import { anythingWaiting, useAppUnread } from "@/components/app-unread";
import { saveFavoriteAppsAction } from "@/app/(app)/app-launcher-actions";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";

export function AppNav({
    appIds,
    guestAppIds = [],
    favorites: savedFavorites = []
}: {
    appIds: string[];
    guestAppIds?: string[];
    /** The apps this account pinned, in its order. */
    favorites?: string[];
}) {
    const pathname = usePathname();
    const toast = useToast();
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
    const [favorites, setFavorites] = useState<string[]>(savedFavorites);
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
        const entry =
            asGuest.has(app.id) && app.guest
                ? {
                      ...app,
                      label: label(app.guest.label),
                      description: describe(app.id, "guestDescription", app.guest.description),
                      href: app.guest.href
                  }
                : // A guest reaches the app through a subject rather than through
                  // the app, so their entry leads to that subject and never to a
                  // remembered screen behind it.
                  {
                      ...app,
                      label: label(app.label),
                      description: describe(app.id, "description", app.description),
                      href: places[app.id] ?? app.href
                  };
        // Whatever that app has waiting, whichever app it is. Naming them
        // here is what left Mail with a number and no dot beside it.
        const badge = badgeLabel(waiting[app.id] ?? 0);
        return badge ? { ...entry, badge } : entry;
    });
    const layout = launcherLayout({ available: apps.map((app) => app.id), favorites, recent });
    const isGameServer = installedId !== null && installed !== null && installed.tabs.length > 0;
    const active = isGameServer
        ? (nav.POLARIS_APPS.find((app) => app.id === "games") ?? nav.resolveActiveApp(pathname))
        : nav.resolveActiveApp(pathname);
    const current = { ...active, label: label(active.label) };

    // Optimistic: the star fills at once and comes back off, with a note, if the
    // save is refused. Sent whole, so two quick clicks cannot interleave into a
    // list neither of them meant.
    function togglePin(appId: string) {
        const pinning = !favorites.includes(appId);
        const next = pinning ? [...favorites, appId] : favorites.filter((id) => id !== appId);
        setFavorites(next);
        const undo = () =>
            setFavorites((current) =>
                current.includes(appId) !== pinning
                    ? current
                    : pinning
                      ? current.filter((id) => id !== appId)
                      : [...current, appId]
            );
        void saveFavoriteAppsAction(next)
            .then((answer) => {
                if (!answer.error) return;
                undo();
                toast.show({ title: answer.error });
            })
            .catch(() => {
                undo();
                toast.show({ title: t("switcher.saveFailed") });
            });
    }

    return (
        <AppSwitcher
            apps={apps}
            currentAppId={current.id}
            currentApp={current.hidden ? current : undefined}
            featured={layout.featured}
            featuredLabel={
                layout.pinned
                    ? t("switcher.favorites")
                    : layout.visited
                      ? t("switcher.recent")
                      : t("switcher.suggested")
            }
            strings={{
                moreApps: t("switcher.moreApps"),
                allApps: t("switcher.allApps"),
                pin: (app) => t("switcher.pin", { app }),
                unpin: (app) => t("switcher.unpin", { app })
            }}
            pinned={favorites}
            onTogglePin={togglePin}
            // Moving between apps keeps the page. An anchor here reloaded the
            // whole dashboard, which among other things hung up on whoever was
            // on the other end of a call.
            linkAs={Link}
            // The dot on the switcher itself, which is all somebody sees
            // while the list is closed. Derived from what is actually waiting
            // rather than from a list of apps, so the next app to start counting
            // raises it without anybody remembering to.
            alert={anythingWaiting(waiting)}
        />
    );
}
