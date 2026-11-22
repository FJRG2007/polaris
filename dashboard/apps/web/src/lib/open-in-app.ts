/**
 * A Polaris link followed in a browser, opened in the Polaris app instead - the
 * desktop app on a computer, the phone app on Android and on iPhone - the way WhatsApp and
 * Discord hand their links to their apps.
 *
 * Tried only where it can work and nobody is put out by it: the account has the
 * setting on (`User.openLinksInApp`, on unless they turned it off), it has signed
 * in to that app before, the page was reached from outside Polaris rather than
 * by moving around inside it, and this tab has not tried already. The link only
 * names the page (`polaris://open?server=&path=`, read by both apps the same
 * way), and the app opens it only for a Polaris it already has, or after a yes.
 *
 * Pure but for `holdForSignIn`, so every rule here is asserted without a browser.
 */

import { clientFromUserAgent } from "@polaris/core";

export type AppTarget = "phone" | "iphone" | "desktop";

/** The phone app on iPhone adds this to its User-Agent (`mobile/ios` WebViewController). */
const IPHONE_APP = /\bPolarisMobile\/\d[^\s]*\s+\(iOS\)/;

/** Whether a session's User-Agent is the phone app on iPhone rather than on Android. */
export function isIphoneApp(userAgent: string | null | undefined): boolean {
    return IPHONE_APP.test(userAgent ?? "");
}

/** The Android app's package, which an `intent:` link names so Chrome opens it. */
export const PHONE_APP_PACKAGE = "app.polaris.mobile";

/** The paths never handed to an app: signing in, and anything that is not a screen. */
const NEVER = /^\/(?:api|login|sign-in|sign-up|signup|register|auth|logout|oauth|invite|reset|verify|recover)(?:[/?#]|$)/i;

/** Which app this browser's device would open the link in, or null for none. */
export function appTarget(
    userAgent: string,
    signedIn: { readonly phone: boolean; readonly iphone?: boolean; readonly desktop: boolean }
): AppTarget | null {
    // Already inside one of the apps: nothing to hand over.
    if (clientFromUserAgent(userAgent) !== "browser") return null;
    if (/\bAndroid\b/i.test(userAgent)) return signedIn.phone ? "phone" : null;
    if (/\b(?:iPhone|iPad|iPod)\b/i.test(userAgent)) return signedIn.iphone ? "iphone" : null;
    // Another phone or tablet, with no app to offer.
    if (/\bMobile\b/i.test(userAgent)) return null;
    return signedIn.desktop ? "desktop" : null;
}

/** Whether this load is one to hand over: a screen reached from outside Polaris. */
export function arrivedFromOutside({
    referrer,
    origin,
    path,
    landing,
    navigation,
    tried
}: {
    referrer: string;
    origin: string;
    path: string;
    /** The path this document was loaded on, when it differs from `path`: a
     *  sign-in screen moves on to the app without a page load, so `path` is
     *  already the app's while the visit itself started at signing in. */
    landing?: string;
    /** The browser's navigation type for this load. */
    navigation: string;
    /** Whether this tab already tried once. */
    tried: boolean;
}): boolean {
    if (tried || navigation !== "navigate" || NEVER.test(path)) return false;
    if (landing !== undefined && NEVER.test(landing)) return false;
    if (!referrer) return true;
    try {
        return new URL(referrer).origin !== origin;
    } catch {
        return true;
    }
}

/** The tab's own record of having tried, or of a sign-in started in it. */
export const TRIED_KEY = "polaris.openInApp.tried";

/**
 * Note that this tab is signing in, so the app the sign-in lands on is not
 * handed to an app: a flow started in the browser finishes there. Kept by the
 * tab across a provider's own screens, which come back from another site and
 * would otherwise read as a link followed from outside.
 */
export function holdForSignIn(): void {
    try {
        window.sessionStorage.setItem(TRIED_KEY, "1");
    } catch {
        // No storage: the handoff never runs either (`components/open-in-app`).
    }
}

/** The link that opens this page in the app. */
export function appLink(target: AppTarget, origin: string, path: string): string {
    const query = `server=${encodeURIComponent(origin)}&path=${encodeURIComponent(path)}`;
    // The desktop app and the iPhone app both answer the `polaris:` scheme; Safari
    // asks before it hands the link over.
    if (target === "desktop" || target === "iphone") return `polaris://open?${query}`;
    // Chrome on Android opens an `intent:` link in the named app, and with the app
    // missing goes to the fallback - this same page - instead of the Play Store.
    const fallback = encodeURIComponent(`${origin}${path}`);
    return `intent://open?${query}#Intent;scheme=polaris;package=${PHONE_APP_PACKAGE};S.browser_fallback_url=${fallback};end`;
}
