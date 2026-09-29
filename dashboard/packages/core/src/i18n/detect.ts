/**
 * Working out which language somebody reads, from what their browser and their
 * address say.
 *
 * Pure: the header, the list a browser reports and the country are handed in,
 * so the same rules decide on the server (the sign-up request, the first request
 * of an account that has never had a language) and in the browser (the sign-in
 * screen, before any account exists).
 */

import { DEFAULT_LOCALE, LOCALE_INFO, LOCALES, type Locale } from "./locales.js";

/** Past this a header is not a browser's, and reading all of it buys nothing. */
const MAX_HEADER_LENGTH = 1024;
const MAX_RANGES = 32;

/** One entry of an `Accept-Language` header. */
export interface LanguageRange {
    readonly tag: string;
    readonly quality: number;
}

/** A language tag's shape: letters, digits and hyphens, subtags of at most 8. */
const TAG = /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/i;

/**
 * An `Accept-Language` header as the ranges it names, most wanted first.
 *
 * Entries with `q=0` are refusals and are dropped, as is the `*` wildcard -
 * "anything" is not a language anybody can be matched on. Ties keep the order
 * the header wrote them in, which is the browser's own order of preference.
 */
export function parseAcceptLanguage(header: string | null | undefined): LanguageRange[] {
    if (!header) return [];
    const ranges: (LanguageRange & { index: number })[] = [];
    const entries = header.slice(0, MAX_HEADER_LENGTH).split(",").slice(0, MAX_RANGES);
    entries.forEach((entry, index) => {
        const [rawTag = "", ...params] = entry.split(";");
        const tag = rawTag.trim().replace(/_/g, "-");
        if (!TAG.test(tag)) return;
        let quality = 1;
        for (const param of params) {
            const [name, value] = param.split("=").map((part) => part.trim());
            if (name?.toLowerCase() !== "q") continue;
            const parsed = Number(value);
            quality = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
        }
        if (quality > 0) ranges.push({ tag, quality, index });
    });
    return ranges
        .sort((left, right) => right.quality - left.quality || left.index - right.index)
        .map(({ tag, quality }) => ({ tag, quality }));
}

/**
 * The locale one language tag is best served by, or null when Polaris has
 * nothing for it.
 *
 * An exact locale wins (`es-ES`); otherwise the primary language decides, so
 * `es-MX` and `ca-ES` read Spanish and `en-GB` reads English.
 */
export function matchLocale(tag: string | null | undefined): Locale | null {
    const value = tag?.trim().replace(/_/g, "-").toLowerCase();
    if (!value || !TAG.test(value)) return null;
    const exact = LOCALES.find((locale) => locale.toLowerCase() === value);
    if (exact) return exact;
    const language = value.split("-")[0];
    return LOCALES.find((locale) => LOCALE_INFO[locale].languages.includes(language ?? "")) ?? null;
}

/** The first of several tags, in order, that Polaris has a locale for. */
export function negotiateLocale(tags: readonly string[] | null | undefined): Locale | null {
    for (const tag of tags ?? []) {
        const found = matchLocale(tag);
        if (found) return found;
    }
    return null;
}

/** The locale most people in a country read, or null when no locale claims it. */
export function localeForCountry(countryCode: string | null | undefined): Locale | null {
    const code = countryCode?.trim().toUpperCase();
    if (!code) return null;
    return LOCALES.find((locale) => LOCALE_INFO[locale].countries.includes(code)) ?? null;
}

/** Where a detected locale came from, for tests and for deciding whether an
 *  answer is worth storing. */
export type LocaleSource = "header" | "browser" | "country" | "default";

export interface LocaleSignals {
    /** The request's `Accept-Language` header. */
    readonly acceptLanguage?: string | null;
    /** What the browser reported as `navigator.languages`, most preferred first. */
    readonly languages?: readonly string[] | null;
    /** The request address's country, when it has been looked up. */
    readonly country?: string | null;
}

/**
 * The locale for somebody Polaris knows nothing else about.
 *
 * The browser first, because it is the only one of these the person chose: the
 * header, then the list the page reported. Their address's country only when
 * neither names a language Polaris has - a French browser in Madrid reads
 * Spanish sooner than English. The default when nothing says anything.
 */
export function detectLocale(signals: LocaleSignals): { locale: Locale; source: LocaleSource } {
    const fromHeader = negotiateLocale(parseAcceptLanguage(signals.acceptLanguage).map((range) => range.tag));
    if (fromHeader) return { locale: fromHeader, source: "header" };
    const fromBrowser = negotiateLocale(signals.languages);
    if (fromBrowser) return { locale: fromBrowser, source: "browser" };
    const fromCountry = localeForCountry(signals.country);
    if (fromCountry) return { locale: fromCountry, source: "country" };
    return { locale: DEFAULT_LOCALE, source: "default" };
}
