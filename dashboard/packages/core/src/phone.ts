/**
 * Phone numbers, read and written the one way every Polaris screen and server
 * action agrees on: E.164 (`+34600111222`) when stored, grouped the way the
 * number's own country writes it when shown.
 *
 * The functions over libphonenumber-js's smallest metadata set live behind the
 * Rust core's facade (`@polaris/core-rs/phone`), which answers each call with
 * the TypeScript implementation or its Rust twin according to the domain's
 * mode; this module re-exports it unchanged, so no caller changes an import.
 * What combines them with Polaris' own signals stays here.
 */

import { countryForTimeZone } from "./analytics-geo.js";
import { isPhoneCountry, phoneCountryFromLocales, type PhoneCountry } from "@polaris/core-rs/phone";

export {
    formatPhoneAsTyped,
    formatPhoneInternational,
    isPhoneCountry,
    phoneCallingCode,
    phoneCountries,
    phoneCountryFromLocales,
    phoneCountryOf,
    phoneMainCountry,
    splitPhone,
    toE164,
    type PhoneCountry
} from "@polaris/core-rs/phone";

/** What a phone field can know about where its reader is, strongest first. */
export interface PhoneRegionSignals {
    /** The country the server placed the request in (the edge's country header,
     *  or the address looked up). */
    server?: string | null;
    /** The reader's languages in order of preference (`es-ES`). */
    locales?: readonly string[];
    /** The reader's time zone (`Europe/Madrid`). */
    timeZone?: string | null;
}

/** The country a field shows when nothing better is known. */
export const NEUTRAL_PHONE_COUNTRY: PhoneCountry = "US";

/**
 * The country a phone field starts on when it holds no number: the one the
 * server placed the request in, else the region named in the reader's
 * languages, else the country of their time zone, else `fallback`. A zone that
 * spans several countries, a bare language and an unknown code all fall through
 * rather than guess.
 */
export function defaultPhoneCountry(
    signals: PhoneRegionSignals,
    fallback: PhoneCountry = NEUTRAL_PHONE_COUNTRY
): PhoneCountry {
    const server = signals.server?.trim().toUpperCase();
    if (isPhoneCountry(server)) return server;
    const fromLocales = phoneCountryFromLocales(signals.locales ?? []);
    if (fromLocales) return fromLocales;
    const fromZone = countryForTimeZone(signals.timeZone);
    if (isPhoneCountry(fromZone)) return fromZone;
    return fallback;
}
