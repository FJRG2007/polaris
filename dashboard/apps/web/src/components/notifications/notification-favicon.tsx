"use client";

/**
 * Puts what is waiting on the tab icon. Reads the same live feed the bell does,
 * so the badge appears the moment an alert arrives and clears as soon as one is
 * read - on this tab or on another device. Renders nothing itself.
 *
 * Chat is counted here as well, even though a message never reaches the bell.
 * The bell is for things that happened to you and can be read later; a message
 * is somebody waiting. Left out, a person working in another app had a plain
 * icon on the tab and no way at all of learning one had arrived - which is the
 * one place a tab icon is worth anything, since by definition they are not
 * looking at the page.
 *
 * Whether that shows as a number, a dot, or nothing at all is the device's
 * choice - see `favicon-style` - and it is followed while the page is open, so
 * changing it in Settings redraws the tab there and then. The tab's title
 * carries the same thing in front of it, because a row of pinned or crowded tabs
 * shows the title where the icon is too small to read.
 *
 * In a season the icon also wears the season's accessory - the season the frame
 * decorates with, so the operator's switch and the reader's own calendar decide
 * it exactly as they decide the rest of the decoration. The desktop app's
 * window, taskbar, tray and Dock icon and the phone app's launcher icon are
 * shared with every other Polaris that app is signed in to, so for those the
 * page reports this host's calendar (`app-icon-report`) and the app settles all
 * of them by one rule - Polaris's own calendar first - rather than wearing
 * whichever page spoke last.
 */

import { useEffect, useRef, useState } from "react";
import { useAppUnread } from "@/components/app-unread";
import { useAdminWaiting } from "@/components/admin-waiting";
import { tabWaiting } from "@/lib/waiting-counts";
import { useNotificationFeed } from "@/components/notifications/notifications-provider";
import { useDoNotDisturb } from "@/components/do-not-disturb";
import {
    applyFavicon,
    currentFavicon,
    drawBadgeOverlay,
    drawFavicon,
    seasonalFavicon,
    type FaviconLink
} from "@/lib/favicon";
import { useDecorationSeason, useHostCalendar } from "@/components/seasonal/season-context";
import { appIconReport } from "@/lib/app-icon-report";
import { phoneSeasonIcon } from "@/lib/mobile-bridge";
import { useDesktopBridge } from "@/components/desktop-app";
import { useClient } from "@/components/i18n/i18n-provider";
import {
    DEFAULT_FAVICON_STYLE,
    faviconBadge,
    faviconStyle,
    onFaviconStyleChange,
    titleWithBadge,
    type FaviconStyle
} from "@/lib/favicon-style";

/** How long the season has to stay put before the phone app is told it. */
const PHONE_ICON_SETTLE_MS = 2000;

export function NotificationFavicon() {
    const { items } = useNotificationFeed();
    const apps = useAppUnread();
    const admin = useAdminWaiting();
    // One number, because the icon has room for one. What it means is "there is
    // something here for you", and which app it came from is a question the page
    // itself answers. Each thing once: an update waiting is in the bell and in
    // Management, and used to count as two - see `tabWaiting`.
    const waiting = tabWaiting({ bell: items, apps, admin });
    // Storage is not readable while the page is rendered on the server, so the
    // default holds until the first paint has happened.
    const [style, setStyle] = useState<FaviconStyle>(DEFAULT_FAVICON_STYLE);
    // The plain icon the page was served with. Kept so a feed that empties puts
    // back the crisp vector rather than a drawn copy of it.
    const plain = useRef<FaviconLink | null>(null);
    // In do not disturb the tab's title carries no count: the icon still does,
    // quietly, but a title that changes is the tab asking to be looked at.
    const quiet = useDoNotDisturb();
    const desktop = useDesktopBridge();
    const client = useClient();
    const season = useDecorationSeason();
    const hostCalendar = useHostCalendar();

    useEffect(() => {
        const read = () => setStyle(faviconStyle());
        read();
        return onFaviconStyleChange(read);
    }, []);

    useEffect(() => {
        plain.current ??= currentFavicon();
        const badge = faviconBadge(style, waiting);
        let icon: FaviconLink | null;
        if (!badge) icon = season ? seasonalFavicon(season) : plain.current;
        else {
            const badged = drawFavicon(badge, undefined, season);
            icon = badged ? { href: badged, type: "image/png" } : null;
        }
        if (!icon) return;
        const wanted = icon;
        applyFavicon(wanted);
        // A navigation renders the page's metadata again, and with it the icon
        // links the server sent - which put the plain or the server's icon back
        // over this one until the next alert. Put it back whenever that happens.
        const watcher = new MutationObserver(() => {
            if (!showsFavicon(wanted)) applyFavicon(wanted);
        });
        watcher.observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ["href"] });
        return () => watcher.disconnect();
    }, [style, waiting, season]);

    // The desktop app's own icon. It is shared with every other Polaris the app
    // shows, so this host reports its calendar and the dressed marks the app
    // may need, and the app decides across all of them. An app from before that
    // takes the plain `{ png }` and gets the season this host alone would pick.
    useEffect(() => {
        const setAppIcon = desktop?.setAppIcon;
        if (!setAppIcon) return;
        const report = appIconReport(hostCalendar, new Date());
        const icons: Partial<Record<string, string>> = {};
        for (const each of report.seasons) {
            try {
                const png = drawFavicon(null, 256, each);
                if (png) icons[each] = png;
            } catch {
                // That season stays plain rather than failing the rest.
            }
        }
        const png = (report.season && icons[report.season]) || null;
        const host = window.location.origin;
        const plainOnly = () => void setAppIcon({ png }).catch(() => undefined);
        void setAppIcon({ png, host, calendar: report.calendar, icons })
            .then((taken) => (taken ? undefined : plainOnly()))
            .catch(plainOnly);
        return () => {
            void setAppIcon({ png: null, host })
                .then((taken) => (taken ? undefined : setAppIcon({ png: null })))
                .catch(() => undefined);
        };
    }, [desktop, hostCalendar, season]);

    // The phone app's launcher icon follows the same rule, and keeps it after
    // the page goes. Only once the season has settled, since the frame reads
    // the calendar a moment after the first paint and iOS shows an alert on
    // every change. An admin's preview never reaches it: it is not in the
    // host calendar.
    useEffect(() => {
        const timer = window.setTimeout(() => {
            const report = appIconReport(hostCalendar, new Date());
            phoneSeasonIcon(report.season, report.official);
        }, PHONE_ICON_SETTLE_MS);
        return () => window.clearTimeout(timer);
    }, [hostCalendar, season]);

    // The desktop app has no tab: the same choice goes on its icon in the
    // taskbar or the Dock instead, and comes off when the page goes.
    useEffect(() => {
        const badge = faviconBadge(style, waiting);
        const setAppBadge = desktop?.setAppBadge;
        if (!setAppBadge) {
            // Installed from the browser's menu: the browser draws the count on
            // the installed app's icon itself, where it can.
            if (client === "installed")
                installedAppBadge(badge ? (badge.kind === "dot" ? 0 : waiting) : null);
            return;
        }
        void setAppBadge({
            label: badge?.kind === "count" ? badge.label : null,
            dot: badge?.kind === "dot",
            count: waiting,
            overlay: badge ? drawBadgeOverlay(badge) : null
        }).catch(() => undefined);
    }, [client, desktop, style, waiting]);

    useEffect(
        () => () => {
            void desktop
                ?.setAppBadge?.({ label: null, dot: false, count: 0, overlay: null })
                .catch(() => undefined);
        },
        [desktop]
    );

    useEffect(() => {
        const badge = quiet ? null : faviconBadge(style, waiting);
        const apply = () => {
            const next = titleWithBadge(document.title, badge);
            if (next !== document.title) document.title = next;
        };
        apply();
        // Every navigation writes the page's own title back, so the prefix is
        // put in front again whenever the head changes. Writing an identical
        // title is skipped above, which is what ends the loop this would be.
        const watcher = new MutationObserver(apply);
        watcher.observe(document.head, { subtree: true, childList: true, characterData: true });
        return () => {
            watcher.disconnect();
            document.title = titleWithBadge(document.title, null);
        };
    }, [style, waiting, quiet]);

    useEffect(
        () => () => {
            if (plain.current) applyFavicon(plain.current);
        },
        []
    );

    return null;
}

/** Whether every icon link in the document already points at `icon`. */
function showsFavicon(icon: FaviconLink): boolean {
    const links = document.head.querySelectorAll<HTMLLinkElement>("link[rel~='icon']");
    return links.length > 0 && Array.from(links).every((link) => link.getAttribute("href") === icon.href);
}

/** The Badging API of an installed web app: a number, 0 for a bare mark, or
 *  nothing at all. Missing in browsers that do not have it. */
function installedAppBadge(count: number | null): void {
    const badging = navigator as Navigator & {
        setAppBadge?: (count?: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
    };
    if (count === null) void badging.clearAppBadge?.().catch(() => undefined);
    else void badging.setAppBadge?.(count).catch(() => undefined);
}
