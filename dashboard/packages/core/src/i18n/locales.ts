/**
 * The languages the interface is written in, and the one registry that says so.
 *
 * Adding a language is one entry here plus its catalogs (see docs/i18n.md): the
 * detection, the account setting, the catalog parity test and the `<html lang>`
 * all read this list, so nothing else has to be told.
 *
 * A locale is a full BCP 47 tag rather than a bare language on purpose. Spanish
 * as written in Spain and as written in Mexico are different catalogs, and a tag
 * that already says which one leaves room for the second without renaming the
 * first.
 */

/** Every locale Polaris has catalogs for. The first is the source of truth: its
 *  catalogs define the keys every other locale must carry. */
export const LOCALES = ["en-US", "es-ES"] as const;

export type Locale = (typeof LOCALES)[number];

/** What an account reads before anything has been detected or chosen. */
export const DEFAULT_LOCALE: Locale = "en-US";

/** The formats a locale implies for somebody who never chose their own. Only the
 *  fields that differ from the built-in defaults - see `resolveDisplayPreferences`. */
export interface LocaleFormats {
    readonly dateOrder?: "dmy" | "mdy";
    readonly weekStart?: "sun" | "mon" | "sat";
    readonly clock?: "24h" | "12h";
}

export interface LocaleInfo {
    /** The language's name in itself, which is how a picker lists it: somebody
     *  who cannot read the current language can still find their own. */
    readonly name: string;
    /**
     * The primary language subtags this locale answers for when a browser asks.
     *
     * More than the locale's own language where a reader of another one is far
     * better served by it than by the default: Catalan, Galician and Basque
     * readers in Spain read Spanish every day.
     */
    readonly languages: readonly string[];
    /** ISO 3166-1 alpha-2 countries whose visitors get this locale when their
     *  browser names no language Polaris has. */
    readonly countries: readonly string[];
    readonly formats: LocaleFormats;
}

export const LOCALE_INFO: Readonly<Record<Locale, LocaleInfo>> = {
    "en-US": {
        name: "English (US)",
        languages: ["en"],
        countries: [],
        formats: {}
    },
    "es-ES": {
        name: "Español (España)",
        languages: ["es", "ca", "gl", "eu"],
        // Every country where Spanish is the language most people speak, and
        // Andorra, where it is the one most visitors share with Catalan.
        countries: [
            "AD", "AR", "BO", "CL", "CO", "CR", "CU", "DO", "EC", "ES", "GQ",
            "GT", "HN", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY", "VE"
        ],
        formats: { dateOrder: "dmy", weekStart: "mon", clock: "24h" }
    }
};

/** Whether a value names a locale Polaris has catalogs for. Exact and
 *  case-sensitive: anything looser is `matchLocale`'s job. */
export function isLocale(value: unknown): value is Locale {
    return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** A stored or submitted locale, or the default when it is not one of ours. */
export function localeOrDefault(value: unknown): Locale {
    return isLocale(value) ? value : DEFAULT_LOCALE;
}
