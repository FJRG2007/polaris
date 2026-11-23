/**
 * The phone domain's TypeScript implementation: what `@polaris/core`'s
 * `phone.ts` ran before it became a facade, unchanged, and the source of the
 * golden vectors `polaris-core::phone` must match. `defaultPhoneCountry` stays
 * in `@polaris/core` (it reads that package's time-zone table) and calls these.
 *
 * Phone numbers, read and written the one way every Polaris screen and server
 * action agrees on: E.164 (`+34600111222`) when stored, grouped the way the
 * number's own country writes it when shown.
 *
 * Built on libphonenumber-js with its smallest metadata set: it knows every
 * country's calling code, number lengths and leading digits, which is what a
 * field needs to tell a whole number from a mistyped one, without the full
 * set's per-type detail.
 */

import {
    AsYouType,
    getCountries,
    getCountryCallingCode,
    parsePhoneNumberFromString,
    type CountryCode
} from "libphonenumber-js/min";
import metadata from "libphonenumber-js/min/metadata";

export type PhoneCountry = CountryCode;

let known: ReadonlySet<string> | null = null;

/**
 * Every country and territory a number can belong to, by ISO 3166-1 code.
 * A function rather than a constant read at import, so a bundle that takes
 * something else from this package does not carry the phone metadata.
 */
export function phoneCountries(): readonly PhoneCountry[] {
    return getCountries();
}

/** Whether `code` (upper case, `ES`) is a country a phone number can belong to. */
export function isPhoneCountry(code: string | null | undefined): code is PhoneCountry {
    known ??= new Set<string>(getCountries());
    return typeof code === "string" && known.has(code);
}

/** The calling code dialled before a country's numbers, without the plus: `34`. */
export function phoneCallingCode(country: PhoneCountry): string {
    return getCountryCallingCode(country);
}

/**
 * The country a calling code belongs to first, among those that share it:
 * `US` for `1`, `GB` for `44`, `RU` for `7`. Undefined for a code nobody uses.
 * Read from the same metadata `/min` already carries, where each code lists
 * its main country first.
 */
export function phoneMainCountry(callingCode: string): PhoneCountry | undefined {
    const first = metadata.country_calling_codes[callingCode]?.[0];
    return isPhoneCountry(first) ? first : undefined;
}

/**
 * The number in E.164, or null when it is not a whole, valid number.
 *
 * A number written with its `+` is read as it is; one without is read as a
 * number of `country`, and refused when no country is given - guessing one
 * would send someone's code to a stranger.
 */
export function toE164(value: string, country?: PhoneCountry): string | null {
    const typed = value.trim();
    if (!typed) return null;
    const parsed = parsePhoneNumberFromString(typed, typed.startsWith("+") ? undefined : country);
    return parsed?.isValid() ? parsed.number : null;
}

/** The country an E.164 number belongs to, when it can be told. */
export function phoneCountryOf(value: string): PhoneCountry | undefined {
    return parsePhoneNumberFromString(value.trim())?.country;
}

/**
 * A stored number split into what a phone field shows: its country and the
 * rest grouped the way that country writes it. Anything that does not read as
 * an international number comes back whole in `national`, so an old value
 * typed before numbers were checked is shown rather than lost.
 */
export function splitPhone(value: string): { country?: PhoneCountry; national: string } {
    const typed = value.trim();
    if (!typed.startsWith("+")) return { national: typed };
    const parsed = parsePhoneNumberFromString(typed);
    if (!parsed?.country) return { national: typed };
    return { country: parsed.country, national: parsed.formatNational() };
}

/** What has been typed so far, grouped as `country` writes it ("600 11 12 22"). */
export function formatPhoneAsTyped(value: string, country?: PhoneCountry): string {
    return new AsYouType(country).input(value);
}

/** A stored number written out for reading: `+34 600 11 12 22`. */
export function formatPhoneInternational(value: string): string {
    const parsed = parsePhoneNumberFromString(value.trim());
    return parsed ? parsed.formatInternational() : value;
}

/**
 * The country a phone field starts on, from the reader's languages in order of
 * preference (`es-ES` -> `ES`). Only a region named in a tag counts: a bare
 * language says nothing about where someone's phone is from.
 */
export function phoneCountryFromLocales(locales: readonly string[]): PhoneCountry | undefined {
    for (const tag of locales) {
        try {
            const region = new Intl.Locale(tag).region;
            if (isPhoneCountry(region)) return region;
        } catch {
            // A malformed tag is skipped, not a reason to fail the field.
        }
    }
    return undefined;
}
