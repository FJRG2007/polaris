"use client";

/**
 * Where a reader last was inside an app, kept in their browser.
 *
 * Leaving Tasks for Chat and coming back should reopen the list that was on
 * screen, not the app's front door - which is how every application with rooms
 * or lists behaves, and the thing whose absence reads as the app having
 * forgotten what you were doing.
 *
 * Per device rather than per account, and never sent anywhere: it is one
 * browser's idea of where its reader was, it changes several times a minute, and
 * nobody else has any business knowing. A screen that has since been deleted is
 * the one failure, and it lands on the app's own not-found page with a way back.
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export const PREFIX = "polaris.place.";

/** Remember where this app was left. */
export function rememberPlace(appId: string, path: string): void {
    try {
        window.localStorage.setItem(PREFIX + appId, path);
    } catch {
        // Private browsing refuses the write, and so does a full quota. The app
        // opens on its front door instead, which is where it opened before.
    }
}

/**
 * Where each of these apps was left, by app id, for every entry that leads into
 * an app - the launcher and the sidebar alike, so the same app opens in the same
 * place whichever of them was used.
 *
 * Read after mount, not during render: the server has no browser storage, and a
 * first paint that disagreed with it would not hydrate. Read again on every
 * navigation, because leaving an app is the moment the way back into it changes.
 */
export function useLastPlaces(
    apps: readonly { readonly id: string; readonly href: string }[]
): Record<string, string> {
    const pathname = usePathname();
    const [places, setPlaces] = useState<Record<string, string>>({});
    const key = apps.map((app) => `${app.id}=${app.href}`).join("|");
    useEffect(() => {
        const found: Record<string, string> = {};
        for (const app of apps) {
            const place = readPlace(app.id, app.href);
            if (place) found[app.id] = place;
        }
        setPlaces((held) => (JSON.stringify(held) === JSON.stringify(found) ? held : found));
        // `key` stands for the list, whose identity changes on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname, key]);
    return places;
}

/** Where it was left, or null when this browser has never been there. Only a
 *  path inside the app is answered: a stored value from another version, or one
 *  somebody edited, must not become somewhere the switcher sends people. */
export function readPlace(appId: string, root: string): string | null {
    try {
        const stored = window.localStorage.getItem(PREFIX + appId);
        if (!stored || !stored.startsWith(`${root}/`)) return null;
        return stored;
    } catch {
        return null;
    }
}
