/**
 * The country and the region of an identity's address.
 *
 * The country is kept as its ISO 3166-1 code (`ES`), which every language can
 * name and every form can be matched against - a country written as "España"
 * only matches a form in Spanish. Identities saved before keep their text, and
 * that text is read back to a code wherever it names a country in any of the
 * languages asked.
 *
 * The regions come from country-region-data (MIT, the list behind
 * react-country-region-selector), loaded only when an identity is edited.
 */

import { COUNTRY_CODES } from "@polaris/core";

/** Lowercased, without accents or punctuation: how two spellings are compared. */
export function normalizePlace(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

/** The short forms people write that no language's own name for a country is. */
const ALIASES: Readonly<Record<string, string>> = {
    usa: "US",
    "united states of america": "US",
    eeuu: "US",
    "ee uu": "US",
    uk: "GB",
    "great britain": "GB",
    uae: "AE"
};

const namers = new Map<string, Intl.DisplayNames | null>();

function namer(locale: string): Intl.DisplayNames | null {
    if (!namers.has(locale)) {
        let made: Intl.DisplayNames | null = null;
        try {
            made = new Intl.DisplayNames([locale], { type: "region" });
        } catch {
            // A locale this runtime cannot name countries in.
        }
        namers.set(locale, made);
    }
    return namers.get(locale) ?? null;
}

/** A country's name in `locale`, or the code when the runtime cannot name it. */
export function countryLabel(code: string, locale: string): string {
    return namer(locale)?.of(code.toUpperCase()) ?? code;
}

/**
 * The code a stored country stands for: a code as it is, or a name in any of
 * `locales`, English or Spanish. Null for text that names no country.
 */
export function countryCodeOf(text: string, locales: readonly string[]): string | null {
    const raw = text.trim();
    if (raw === "") return null;
    if (/^[a-z]{2}$/i.test(raw) && COUNTRY_CODES.includes(raw.toUpperCase()))
        return raw.toUpperCase();
    const wanted = normalizePlace(raw);
    const alias = ALIASES[wanted];
    if (alias) return alias;
    for (const locale of new Set([...locales, "en", "es"])) {
        const names = namer(locale);
        if (!names) continue;
        for (const code of COUNTRY_CODES) {
            const name = names.of(code);
            if (name && normalizePlace(name) === wanted) return code;
        }
    }
    return null;
}

/** How a stored country reads: its name when it is one, the text as typed when not. */
export function countryText(stored: string, locale: string): string {
    const code = countryCodeOf(stored, [locale]);
    return code ? countryLabel(code, locale) : stored;
}

/** One region of a country, and its short code where the list has one. */
export interface Region {
    readonly name: string;
    readonly code: string;
}

/** The regions of a country by code, or an empty list when the data has none. */
export async function regionsOf(country: string): Promise<Region[]> {
    const { allCountries } = await import("country-region-data");
    const entry = allCountries.find((one) => one[1] === country);
    return entry ? entry[2].map(([name, code]) => ({ name, code: code ?? "" })) : [];
}
