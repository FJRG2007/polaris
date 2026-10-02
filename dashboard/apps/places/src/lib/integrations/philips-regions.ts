/**
 * Where a Philips account is: the countries Philips' apps let somebody pick, and
 * how Polaris guesses the one to start on.
 *
 * The list is Philips' own. The HomeID app reads it from its backend's tenant
 * document (`https://www.backend.vbs.versuni.com/.well-known/tenant/oneka`,
 * `spaces[]`): one entry per country it serves, each with its country code and
 * the time zone Philips gives that country. Copied here, as of 2026-10-02,
 * because the dialog draws it before anybody has signed in.
 *
 * A country is what the apps ask for, not a server: the Air+ app sends it to
 * Versuni's configuration service (`/configuration?countryCode=..` on
 * `prod.global-da.iot.versuni.com`), which answers which of its regions holds
 * that country's devices (`integrations/philips-cloud.ts`, `philipsRegionFor`).
 * So the reader picks what they know - where they live - and Philips says
 * where that is.
 *
 * Pure and client-safe: the picker and the server read the same list.
 */

import type { PlacesKey } from "../../../messages";
import type { PlacesTranslator } from "../i18n";

/** Each country Philips serves, with the time zone Philips gives it. */
const COUNTRIES: readonly (readonly [code: string, zone: string])[] = [
    ["AE", "Asia/Dubai"],
    ["AL", "Europe/Tirane"],
    ["AO", "Africa/Luanda"],
    ["AR", "America/Argentina/Buenos_Aires"],
    ["AT", "Europe/Vienna"],
    ["AU", "Australia/Sydney"],
    ["BA", "Europe/Sarajevo"],
    ["BE", "Europe/Brussels"],
    ["BG", "Europe/Sofia"],
    ["BH", "Asia/Bahrain"],
    ["BN", "Asia/Brunei"],
    ["BR", "America/Sao_Paulo"],
    ["CA", "America/Toronto"],
    ["CH", "Europe/Zurich"],
    ["CL", "America/Santiago"],
    ["CY", "Asia/Nicosia"],
    ["CZ", "Europe/Prague"],
    ["DE", "Europe/Berlin"],
    ["DK", "Europe/Copenhagen"],
    ["EE", "Europe/Tallinn"],
    ["ES", "Europe/Madrid"],
    ["FI", "Europe/Helsinki"],
    ["FR", "Europe/Paris"],
    ["GB", "Europe/London"],
    ["GH", "Africa/Accra"],
    ["GR", "Europe/Athens"],
    ["HK", "Asia/Hong_Kong"],
    ["HR", "Europe/Zagreb"],
    ["HU", "Europe/Budapest"],
    ["ID", "Asia/Jakarta"],
    ["IE", "Europe/Dublin"],
    ["IL", "Asia/Jerusalem"],
    ["IN", "Asia/Kolkata"],
    ["IQ", "Asia/Baghdad"],
    ["IS", "Atlantic/Reykjavik"],
    ["IT", "Europe/Rome"],
    ["JO", "Asia/Amman"],
    ["KE", "Africa/Nairobi"],
    ["KH", "Asia/Phnom_Penh"],
    ["KR", "Asia/Seoul"],
    ["KW", "Asia/Kuwait"],
    ["LT", "Europe/Vilnius"],
    ["LU", "Europe/Luxembourg"],
    ["LV", "Europe/Riga"],
    ["MD", "Europe/Chisinau"],
    ["ME", "Europe/Podgorica"],
    ["MK", "Europe/Skopje"],
    ["MO", "Asia/Macau"],
    ["MU", "Indian/Mauritius"],
    ["MX", "America/Mexico_City"],
    ["MY", "Asia/Kuala_Lumpur"],
    ["NA", "Africa/Windhoek"],
    ["NG", "Africa/Lagos"],
    ["NL", "Europe/Amsterdam"],
    ["NO", "Europe/Oslo"],
    ["NZ", "Pacific/Auckland"],
    ["OM", "Asia/Muscat"],
    ["PE", "America/Lima"],
    ["PH", "Asia/Manila"],
    ["PK", "Asia/Karachi"],
    ["PL", "Europe/Warsaw"],
    ["PT", "Europe/Lisbon"],
    ["QA", "Asia/Qatar"],
    ["RO", "Europe/Bucharest"],
    ["RS", "Europe/Belgrade"],
    ["SA", "Asia/Riyadh"],
    ["SE", "Europe/Stockholm"],
    ["SG", "Asia/Singapore"],
    ["SI", "Europe/Ljubljana"],
    ["SK", "Europe/Bratislava"],
    ["TH", "Asia/Bangkok"],
    ["TR", "Europe/Istanbul"],
    ["TW", "Asia/Taipei"],
    ["UA", "Europe/Kyiv"],
    ["US", "America/New_York"],
    ["UY", "America/Montevideo"],
    ["VN", "Asia/Ho_Chi_Minh"],
    ["XK", "Europe/Belgrade"],
    ["ZA", "Africa/Johannesburg"]
];

/** Every country code Philips' apps offer, in Philips' order. */
export const PHILIPS_COUNTRIES: readonly string[] = COUNTRIES.map(([code]) => code);

export function isPhilipsCountry(code: string): boolean {
    return PHILIPS_COUNTRIES.includes(code);
}

/** Where somebody probably is: their time zones and their languages, each in
 *  the order they are trusted. */
export interface WhereaboutsSignals {
    readonly timeZones: readonly (string | null | undefined)[];
    readonly locales: readonly (string | null | undefined)[];
}

/** The region subtag of a language tag (`es-ES` -> `ES`), or null. */
function regionOf(locale: string): string | null {
    try {
        return new Intl.Locale(locale).region ?? null;
    } catch {
        return null;
    }
}

/**
 * The country to start the picker on, or "" where nothing says.
 *
 * A time zone first: it is where the clock is, which is where somebody lives
 * more often than their language is. A zone matches only the one Philips gives
 * a country, so a zone Philips does not name (`America/Chicago`) says nothing
 * and the languages decide: `en-US` is the United States. Never a guess beyond
 * that - an empty picker asks, a wrong one is believed.
 */
export function philipsCountryGuess(signals: WhereaboutsSignals): string {
    for (const zone of signals.timeZones) {
        const found = zone ? COUNTRIES.find(([, known]) => known === zone) : undefined;
        if (found) return found[0];
    }
    for (const locale of signals.locales) {
        const region = locale ? regionOf(locale) : null;
        if (region && isPhilipsCountry(region)) return region;
    }
    return "";
}

/**
 * The part of the world an AWS region code names, by its prefix, as AWS names
 * them ("Regions and Availability Zones"): `eu-west-1` is Europe. Versuni's
 * configuration answers its regions in these codes. Anything else is "other",
 * and the code itself is what the screen shows.
 */
export const PHILIPS_AREAS = ["eu", "us", "ca", "mx", "sa", "ap", "cn", "me", "il", "af"] as const;
export type PhilipsArea = (typeof PHILIPS_AREAS)[number] | "other";

export function philipsArea(awsRegion: string): PhilipsArea {
    const prefix = awsRegion.split("-")[0] ?? "";
    return (PHILIPS_AREAS as readonly string[]).includes(prefix)
        ? (prefix as PhilipsArea)
        : "other";
}

/** One name table per language: the picker names 79 countries a render. */
const names = new Map<string, Intl.DisplayNames | null>();

/** A country's name in the reader's language, from the platform's own table;
 *  the code itself where the runtime has none. */
export function philipsCountryName(code: string, locale: string): string {
    let table = names.get(locale);
    if (table === undefined) {
        try {
            table = new Intl.DisplayNames([locale], { type: "region" });
        } catch {
            table = null;
        }
        names.set(locale, table);
    }
    try {
        return table?.of(code) ?? code;
    } catch {
        return code;
    }
}

/** A region's part of the world in the reader's words (`eu-west-1` is
 *  "Europe"), or the code itself for a part AWS has no prefix for here. */
export function philipsRegionWords(t: PlacesTranslator, awsRegion: string): string {
    const area = philipsArea(awsRegion);
    return area === "other" ? awsRegion : t(`connections.philips-cloud.areas.${area}` as PlacesKey);
}

/**
 * The English words of a country and a region back to the reader's, for a
 * sentence written in English on the server (`nothingFoundSentence`). Anything
 * that is not one of the names written there is left as it came.
 */
export function philipsWhereInWords(
    t: PlacesTranslator,
    english: PlacesTranslator,
    country: string,
    area: string
): { country: string; area: string } {
    if (country === english("connections.philips-cloud.yourCountry")) {
        return {
            country: t("connections.philips-cloud.yourCountry"),
            area: philipsWhereInWords(t, english, "", area).area
        };
    }
    const code = PHILIPS_COUNTRIES.find((each) => philipsCountryName(each, "en") === country);
    const prefix = PHILIPS_AREAS.find(
        (each) => english(`connections.philips-cloud.areas.${each}` as PlacesKey) === area
    );
    return {
        country: code ? philipsCountryName(code, t.locale) : country,
        area: prefix ? t(`connections.philips-cloud.areas.${prefix}` as PlacesKey) : area
    };
}
