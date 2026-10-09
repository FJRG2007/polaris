/**
 * What changing the account a browser acts as does on the browser's side.
 *
 * The session cookie is shared by every tab, so the moment it names another
 * account, every tab still drawn for the previous one is showing somebody else's
 * data and holding their live connections - a stream authorized when it opened
 * keeps serving the account it opened for. Nothing short of a fresh load tears
 * all of that down, so a change of account is a full navigation in the tab that
 * made it and a reload in every other.
 *
 * The other tabs are told through one localStorage entry: the account the
 * browser was last drawn for. A page of the app writes it when it mounts, and
 * every other tab hears the write as a `storage` event and reloads when it no
 * longer names them. That covers every way an account can change - the switcher,
 * signing out, and a sign-in finished on the second-factor screen or by a scanned
 * code - without each of them having to remember to say so.
 *
 * What a tab keeps of an account between loads goes too: recent places and
 * searches, the last place in each app, the snapshots painted before a read
 * lands, and the mail kept for offline reading. Those are the previous account's
 * titles and subject lines, and keying them by account would only keep them on a
 * shared device for longer.
 */

import { dropAllSnapshots } from "@/lib/snapshot-cache";
import { dropMailCache } from "@/lib/mailbox/mail-cache";
import { STORE_KEY as APP_USAGE_KEY } from "@/lib/app-usage";
import { PREFIX as LAST_PLACE_PREFIX } from "@/lib/last-place";
import { STORE_KEY as RECENT_SEARCH_KEY } from "@/lib/search/recent";
import { STORE_KEY as RECENT_PLACES_KEY } from "@/lib/overview/recent-places";
import { SHARED_CURSOR_KEY as MAIL_CURSOR_KEY } from "@/components/mail-unread";

/** The account this browser was last drawn for. */
export const ACCOUNT_MARKER_KEY = "polaris.account.current";

/** Forget everything this browser kept for the account it was acting as. */
export async function forgetAccountTraces(): Promise<void> {
    dropAllSnapshots();
    try {
        const doomed: string[] = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
            const key = window.localStorage.key(index);
            if (!key) continue;
            if (key.startsWith(LAST_PLACE_PREFIX) || ACCOUNT_KEYS.has(key)) doomed.push(key);
        }
        for (const key of doomed) window.localStorage.removeItem(key);
    } catch {
        // Storage refused (a private window, a blocked site): nothing was kept.
    }
    await dropMailCache().catch(() => undefined);
}

const ACCOUNT_KEYS: ReadonlySet<string> = new Set([
    APP_USAGE_KEY,
    RECENT_PLACES_KEY,
    RECENT_SEARCH_KEY,
    MAIL_CURSOR_KEY
]);

function readMarker(): string | null {
    try {
        return window.localStorage.getItem(ACCOUNT_MARKER_KEY);
    } catch {
        return null;
    }
}

function writeMarker(value: string): void {
    try {
        window.localStorage.setItem(ACCOUNT_MARKER_KEY, value);
    } catch {
        // Without storage the other tabs cannot be told; each finds out on its
        // next request instead, as before.
    }
}

/**
 * Leave for `target` as another account, or as nobody: forget this one's traces,
 * tell the other tabs, and load the page fresh.
 */
export async function leaveAccount(target: string): Promise<void> {
    await forgetAccountTraces();
    // Cleared rather than set to the next account, which this tab does not know
    // yet: every other tab reloads and the first page to mount writes it.
    writeMarker("");
    window.location.assign(target);
}

/**
 * Settle which account this browser was last drawn for, with the one this page
 * was drawn for. Called while the app's frame renders - before any screen inside
 * it reads what was kept - so an account that changed by a path that never went
 * through `leaveAccount` (a sign-in finished on another screen) still has the
 * previous one's traces cleared before they can be painted.
 */
export function reconcileAccount(userId: string): void {
    const previous = readMarker();
    if (previous === userId) return;
    if (previous) void forgetAccountTraces();
    writeMarker(userId);
}

/**
 * Reload this tab when another one changes the account. Returns the clean-up.
 */
export function listenForAccountChange(userId: string): () => void {
    const reload = (): void => {
        dropAllSnapshots();
        window.location.assign("/");
    };
    const onStorage = (event: StorageEvent): void => {
        if (event.key !== ACCOUNT_MARKER_KEY) return;
        if (event.newValue !== userId) reload();
    };
    // A page restored from the back-forward cache never renders again, so it is
    // asked here whether it is still the right account.
    const onShow = (event: PageTransitionEvent): void => {
        if (!event.persisted) return;
        const current = readMarker();
        if (current !== null && current !== userId) reload();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onShow);
    return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener("pageshow", onShow);
    };
}
