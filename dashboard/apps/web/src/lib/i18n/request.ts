/**
 * The language of the request being served, for server components, server
 * actions and route handlers.
 *
 * The reader's account decides when there is one - the real session, not an
 * account an administrator is viewing as, because it is the administrator who
 * is reading. Without an account (the sign-in screen, an invite) the cookie the
 * browser was last shown Polaris in decides, then the browser's own
 * `Accept-Language`, then the default.
 *
 * An account with no language yet gets one here, on its first request: the same
 * detection a new account gets, written once so every later request is a read.
 */

import { cache } from "react";
import { translatorFor } from "./translate";
import { resolveSession } from "@/lib/session";
import { cookies, headers } from "next/headers";
import { clientIp } from "@/lib/request-context";
import { LOCALE_COOKIE, localeFromCookie } from "./cookie";
import type { Namespace, NamespaceTranslator } from "./types";
import { recordDetectedLocale, storedLocale } from "./locale-service";
import { DEFAULT_LOCALE, detectLocale, type Locale } from "@polaris/core";

/** How long a first request waits for the address's country before giving up on
 *  it. Only reached when the browser names no language Polaris has, and only
 *  once per account - an answer that is not in by then is not worth a slow page. */
const COUNTRY_WAIT_MS = 1500;

export interface DetectedLocale {
    readonly locale: Locale;
    /** Whether anything actually said so. False only when the address's country
     *  was asked for and did not arrive in time, which is worth asking again
     *  rather than writing the default down for good. */
    readonly decided: boolean;
}

/** The country an address is in, or null - within a bounded wait. Null
 *  `country` with `answered: false` means the lookup ran out of time. */
async function countryOf(ip: string | undefined): Promise<{ country: string | null; answered: boolean }> {
    if (!ip) return { country: null, answered: true };
    // Imported when needed: it reaches the database and the network, and the
    // common case - a browser that names a language - never gets this far.
    const { resolveGeo } = await import("@/lib/geo-service");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), COUNTRY_WAIT_MS);
    });
    try {
        const found = await Promise.race([resolveGeo(ip).then((geo) => geo.countryCode), late]);
        return found === null ? { country: null, answered: false } : { country: found, answered: true };
    } catch {
        return { country: null, answered: true };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The language this request's browser asks for, for somebody Polaris knows
 * nothing else about.
 *
 * The cookie first - it is either a language this browser was already reading
 * Polaris in, or the one its own language list named on the sign-in screen -
 * then `Accept-Language`, then, when `withCountry` is set and neither names a
 * language Polaris has, the country the address is in.
 */
export async function detectRequestLocale(options: { withCountry: boolean }): Promise<DetectedLocale> {
    const [store, incoming] = await Promise.all([cookies(), headers()]);
    const remembered = localeFromCookie(store.get(LOCALE_COOKIE)?.value);
    if (remembered) return { locale: remembered, decided: true };

    const acceptLanguage = incoming.get("accept-language");
    const fromBrowser = detectLocale({ acceptLanguage });
    if (fromBrowser.source !== "default" || !options.withCountry) {
        return { locale: fromBrowser.locale, decided: true };
    }
    const { country, answered } = await countryOf(await clientIp());
    return { locale: detectLocale({ acceptLanguage, country }).locale, decided: answered };
}

/**
 * Give an account that has no language the one its browser asks for, and write
 * it down. Called for a new account the moment it is created, and for an older
 * one on its first request since languages arrived. Never throws: a language is
 * not worth failing a sign-up or a page over.
 */
export async function adoptRequestLocale(userId: string): Promise<Locale> {
    try {
        const detected = await detectRequestLocale({ withCountry: true });
        if (!detected.decided) return detected.locale;
        return await recordDetectedLocale(userId, detected.locale);
    } catch (caught) {
        console.error("Could not work out a language for a new account", caught);
        return DEFAULT_LOCALE;
    }
}

/** Worked out once per request: the root layout, the frame and the page all ask. */
const requestLocale = cache(async (): Promise<Locale> => {
    try {
        const session = await resolveSession().catch(() => null);
        if (session) return (await storedLocale(session.id)) ?? (await adoptRequestLocale(session.id));
        return (await detectRequestLocale({ withCountry: false })).locale;
    } catch {
        return DEFAULT_LOCALE;
    }
});

/**
 * The language to draw this request in. Never throws: the root layout reads it,
 * and a page is always drawn in something.
 */
export async function getLocale(): Promise<Locale> {
    return requestLocale();
}

/**
 * A translator over one namespace, in the language of this request - for a
 * server component, a server action's reply, a route handler's error.
 *
 *     const t = await getTranslations("account");
 *     return { error: t("language.unsupported") };
 */
export async function getTranslations<N extends Namespace>(namespace: N): Promise<NamespaceTranslator<N>> {
    return translatorFor(await getLocale(), namespace);
}
