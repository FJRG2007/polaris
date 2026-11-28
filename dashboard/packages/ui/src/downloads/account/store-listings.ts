/**
 * Whether Polaris for Android is listed on Google Play and on F-Droid.
 *
 * Asked of the stores rather than written down here, so the Downloads page
 * offers a store the day the listing goes live, on every deployment, with no
 * release of the dashboard in between. Each store answers a plain 404 for a
 * package it does not carry: Google Play on the listing page, F-Droid on its
 * package API.
 *
 * The answer is held for six hours, a "not listed" included, because it
 * changes once in the app's life. A store that does not answer keeps the last
 * answer that worked and is asked again in five minutes; with none ever read,
 * the store is left off - the APK is always offered, so nobody is left without
 * a way to install it.
 *
 * Past the six hours the held answer is still what the page draws: the store is
 * asked again behind the read (`@polaris/core/stale-while-revalidate`). The
 * Android card used to wait up to five seconds on Google Play every time the
 * hold ran out, and every five minutes while Play refused a server's request.
 * Only a deployment that has never had an answer waits, and not past the
 * timeout.
 */

import { staleWhileRevalidate } from "@polaris/core/stale-while-revalidate";

/** The application id in `mobile/android/app/build.gradle`. */
export const ANDROID_PACKAGE = "app.polaris.mobile";

export const PLAY_LISTING_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
export const FDROID_LISTING_URL = `https://f-droid.org/packages/${ANDROID_PACKAGE}/`;
const FDROID_API_URL = `https://f-droid.org/api/v1/packages/${ANDROID_PACKAGE}`;

const HOLD_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5000;

/** Where to install it from, each null while that store does not carry it. */
export interface AndroidStores {
    readonly play: string | null;
    readonly fdroid: string | null;
}

/** What a store's status code says: listed, not listed, or no answer. Pure. */
export function listingState(status: number): boolean | null {
    if (status >= 200 && status < 300) return true;
    if (status === 404 || status === 410) return false;
    return null;
}

/** What a store last said, and whether the look that said it failed (then it is
 *  the answer before, kept, and asked again in `RETRY_MS`). */
interface Held {
    readonly listed: boolean | null;
    readonly failed: boolean;
}

const listings = staleWhileRevalidate<Held>({
    freshMs: HOLD_MS,
    retryMs: RETRY_MS,
    freshFor: (held) => (held.failed ? RETRY_MS : HOLD_MS),
    waitMs: TIMEOUT_MS,
    maxKeys: 8
});

async function ask(url: string): Promise<boolean | null> {
    try {
        const response = await fetch(url, {
            method: "GET",
            headers: { "user-agent": "polaris-dashboard" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            redirect: "follow"
        });
        // Only the status is read; the body is not needed.
        await response.body?.cancel().catch(() => undefined);
        return listingState(response.status);
    } catch {
        return null;
    }
}

async function listed(url: string): Promise<boolean> {
    const held = await listings.get(url, async (previous) => {
        const answer = await ask(url);
        return answer === null
            ? { listed: previous?.listed ?? null, failed: true }
            : { listed: answer, failed: false };
    });
    return held?.listed ?? false;
}

/** The stores that carry Polaris for Android, asked of the stores themselves. */
export async function androidStores(): Promise<AndroidStores> {
    const [play, fdroid] = await Promise.all([
        listed(`${PLAY_LISTING_URL}&hl=en`),
        listed(FDROID_API_URL)
    ]);
    return { play: play ? PLAY_LISTING_URL : null, fdroid: fdroid ? FDROID_LISTING_URL : null };
}
