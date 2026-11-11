"use client";

/**
 * Where a reader last was inside an app, kept in their browser.
 *
 * Leaving Tasks for Chat and coming back should reopen the list that was on
 * screen, not the app's front door - which is how every application with rooms
 * or lists behaves, and the thing whose absence reads as the app having
 * forgotten what you were doing.
 *
 * Per account on this device, and never sent anywhere: it is one browser's idea
 * of where its reader was, it changes several times a minute, and nobody else
 * has any business knowing. Keyed by the account so switching to another one
 * and back returns each to its own place - it used to be one entry the switch
 * had to wipe, so every switch sent both accounts back to the front door. Signing
 * an account out forgets its places (`forgetPlaces`). A screen that has since
 * been deleted is the one failure, and it lands on the app's own not-found page
 * with a way back.
 */

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { currentAccount } from "@/lib/account-marker";

/** The entries from before places were kept per account, one per app. Cleared
 *  on a change of account, since nobody can say whose they were. */
export const PREFIX = "polaris.place.";

/** Each account's places: `polaris.places.<account>.<app>`. */
export const ACCOUNT_PREFIX = "polaris.places.";

function placeKey(account: string, appId: string): string {
    return `${ACCOUNT_PREFIX}${account}.${appId}`;
}

/** Remember where this app was left, for the account the page is drawn for. */
export function rememberPlace(appId: string, path: string): void {
    const account = currentAccount();
    if (!account) return;
    try {
        window.localStorage.setItem(placeKey(account, appId), path);
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
    const account = currentAccount();
    if (!account) return null;
    try {
        const stored = window.localStorage.getItem(placeKey(account, appId));
        if (!stored || !stored.startsWith(`${root}/`)) return null;
        return stored;
    } catch {
        return null;
    }
}

/** Forget the places kept for one account, or for every account with none named. */
export function forgetPlaces(account?: string): void {
    const prefix = account ? `${ACCOUNT_PREFIX}${account}.` : ACCOUNT_PREFIX;
    try {
        const doomed: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (key?.startsWith(prefix)) doomed.push(key);
        }
        for (const key of doomed) window.localStorage.removeItem(key);
    } catch {
        // Storage refused: nothing was kept.
    }
}

let adopted = false;

/** Move an entry from before places were per account onto `account`, the one
 *  this browser was already drawn for when it was written. */
export function adoptLegacyPlaces(account: string): void {
    // Once a page load: the frame calls this on every render.
    if (adopted) return;
    adopted = true;
    try {
        const legacy: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (key?.startsWith(PREFIX)) legacy.push(key);
        }
        for (const key of legacy) {
            const path = window.localStorage.getItem(key);
            const target = placeKey(account, key.slice(PREFIX.length));
            if (path && window.localStorage.getItem(target) === null)
                window.localStorage.setItem(target, path);
            window.localStorage.removeItem(key);
        }
    } catch {
        // Storage refused: the app opens on its front door, as before.
    }
}
