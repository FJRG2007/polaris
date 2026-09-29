/**
 * The language a browser was last shown Polaris in, kept in a cookie.
 *
 * An account's language lives on the account. This mirror is for the screens
 * that come before one - signing in, setting up, accepting an invite - which
 * have no account to ask, and for the moment an account is created, when the
 * language the invite screen was read in is the best answer there is.
 *
 * Readable from the page on purpose (not HttpOnly): the sign-in screen writes it
 * from the browser's own language list, and it carries a language tag and
 * nothing else. Client-safe: no server imports.
 */

import { isLocale, type Locale } from "@polaris/core";

export const LOCALE_COOKIE = "polaris-locale";

/** A year: it is a preference, and it is refreshed whenever the account's
 *  language is read or changed. */
export const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** The locale a cookie value names, or null when it names none of ours. */
export function localeFromCookie(value: string | null | undefined): Locale | null {
    return isLocale(value) ? value : null;
}

/** The locale in a `document.cookie` string, or null. */
export function readLocaleCookie(cookieString: string): Locale | null {
    for (const entry of cookieString.split(";")) {
        const [name, ...rest] = entry.trim().split("=");
        if (name === LOCALE_COOKIE) return localeFromCookie(decodeURIComponent(rest.join("=")));
    }
    return null;
}

/** Write the mirror from the browser. `Secure` follows the page, so it works on
 *  the plain-HTTP LAN address as well as on the domain. */
export function writeLocaleCookie(locale: Locale): void {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}
