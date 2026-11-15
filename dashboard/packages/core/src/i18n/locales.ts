/**
 * The languages the interface is written in, and the one registry that says so.
 *
 * Adding a language is one entry here plus its catalogs, partial at first (see
 * docs/i18n.md, "Adding a language"): the
 * detection, the account setting, the catalog parity test and the `<html lang>`
 * all read this list, so nothing else has to be told.
 *
 * A locale is a full BCP 47 tag rather than a bare language on purpose. Spanish
 * as written in Spain and as written in Mexico are different catalogs, and a tag
 * that already says which one leaves room for the second without renaming the
 * first.
 */

/** Every locale Polaris has catalogs for. The first is the source of truth: its
 *  catalogs define the keys every other locale may carry, and what a locale
 *  that does not carry one reads instead. */
export const LOCALES = ["en-US", "es-ES"] as const;

export type Locale = (typeof LOCALES)[number];

/** The locale whose catalogs define the keys, and the one every missing message
 *  falls back to. */
export const SOURCE_LOCALE = LOCALES[0];

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
    /**
     * Every catalog carries every key. A complete locale is held to the source
     * key for key by the catalog tests, and its catalogs are typed that way; one
     * that is not ships with what has been translated so far, reads the source's
     * message for the rest, and is marked as partly translated in the pickers.
     * Set it once the coverage report shows the locale at 100%.
     */
    readonly complete: boolean;
}

const INFO = {
    "en-US": {
        name: "English (US)",
        complete: true,
        languages: ["en"],
        countries: [],
        formats: {}
    },
    "es-ES": {
        name: "Español (España)",
        complete: true,
        languages: ["es", "ca", "gl", "eu"],
        // Every country where Spanish is the language most people speak, and
        // Andorra, where it is the one most visitors share with Catalan.
        countries: [
            "AD", "AR", "BO", "CL", "CO", "CR", "CU", "DO", "EC", "ES", "GQ",
            "GT", "HN", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY", "VE"
        ],
        formats: { dateOrder: "dmy", weekStart: "mon", clock: "24h" }
    }
} as const satisfies Record<Locale, LocaleInfo>;

export const LOCALE_INFO: Readonly<Record<Locale, LocaleInfo>> = INFO;

/** The locales marked complete, as a type: their catalogs must match the
 *  source's shape exactly. */
export type CompleteLocale = {
    [L in Locale]: (typeof INFO)[L]["complete"] extends true ? L : never;
}[Locale];

/** Whether a locale carries every key. Anything not in the registry - a locale
 *  a test registers in memory - is treated as partial. */
export function isCompleteLocale(locale: string): boolean {
    return (LOCALE_INFO as Readonly<Record<string, LocaleInfo | undefined>>)[locale]?.complete === true;
}

/**
 * Words written inline rather than in a catalog - a deck key's label - in the
 * source locale and whichever others have them.
 */
export type LocaleWords = { readonly [S in typeof SOURCE_LOCALE]: string } & {
    readonly [L in Locale]?: string;
};

/** The reader's words, or the source's when their locale has none yet. */
export function wordsFor(words: LocaleWords, locale: Locale): string {
    return words[locale] ?? words[SOURCE_LOCALE];
}

/** Whether a value names a locale Polaris has catalogs for. Exact and
 *  case-sensitive: anything looser is `matchLocale`'s job. */
export function isLocale(value: unknown): value is Locale {
    return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** A stored or submitted locale, or the default when it is not one of ours. */
export function localeOrDefault(value: unknown): Locale {
    return isLocale(value) ? value : DEFAULT_LOCALE;
}
