/**
 * Geo (country/continent) helpers for access allowlists on shares and drop
 * points. Pure and client-safe: a country -> continent map, the continent list,
 * and the allow decision. The actual IP -> country resolution (network + cache)
 * lives server-side in the app; this module only decides whether a resolved
 * location passes an allowlist, and is shared by the client dialogs and the
 * server enforcement so both agree on the rule.
 */

export interface Continent {
    /** Two-letter continent code (AF, AN, AS, EU, NA, OC, SA). */
    readonly code: string;
    readonly name: string;
}

export const CONTINENTS: readonly Continent[] = [
    { code: "AF", name: "Africa" },
    { code: "AS", name: "Asia" },
    { code: "EU", name: "Europe" },
    { code: "NA", name: "North America" },
    { code: "SA", name: "South America" },
    { code: "OC", name: "Oceania" },
    { code: "AN", name: "Antarctica" }
];

// ISO-3166 alpha-2 country codes grouped by continent. Kept as space-separated
// strings and expanded once at load, so the source stays compact and auditable.
const COUNTRIES_BY_CONTINENT: Record<string, string> = {
    AF: "DZ AO BJ BW BF BI CM CV CF TD KM CG CD CI DJ EG GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW",
    AN: "AQ BV GS TF HM",
    AS: "AF AM AZ BH BD BT BN KH CN CY GE HK IN ID IR IQ IL JP JO KZ KW KG LA LB MO MY MV MN MM NP KP OM PK PS PH QA SA SG KR LK SY TW TJ TH TL TR TM AE UZ VN YE",
    EU: "AL AD AT BY BE BA BG HR CZ DK EE FO FI FR DE GI GR GG HU IS IE IM IT JE LV LI LT LU MT MD MC ME NL MK NO PL PT RO RU SM RS SK SI ES SJ SE CH UA GB VA AX",
    NA: "AI AG AW BS BB BZ BM BQ CA KY CR CU CW DM DO SV GL GD GP GT HT HN JM MQ MX MS NI PA PR BL KN LC MF PM VC SX TT TC US VG VI",
    OC: "AS AU CK FJ PF GU KI MH FM NR NC NZ NU NF MP PW PG PN WS SB TK TO TV VU WF",
    SA: "AR BO BR CL CO EC FK GF GY PY PE SR UY VE"
};

/** Flat ISO country code -> continent code map, built once. */
export const COUNTRY_TO_CONTINENT: Readonly<Record<string, string>> = (() => {
    const map: Record<string, string> = {};
    for (const [continent, codes] of Object.entries(COUNTRIES_BY_CONTINENT)) {
        for (const code of codes.split(" ")) if (code) map[code] = continent;
    }
    return map;
})();

/** All ISO-3166 alpha-2 country codes Polaris knows, sorted. */
export const COUNTRY_CODES: readonly string[] = Object.keys(COUNTRY_TO_CONTINENT).sort();

/** The continent for a country code, or null if unknown. */
export function continentOf(countryCode: string | null | undefined): string | null {
    if (!countryCode) return null;
    return COUNTRY_TO_CONTINENT[countryCode.toUpperCase()] ?? null;
}

/**
 * Whether a resolved location passes an allowlist. Empty lists mean no geo
 * restriction (admit everything). A non-empty list admits a location that
 * matches by country OR by continent. An unresolved location (no country code)
 * is admitted when a filter is present - geo is approximate and a lookup failure
 * must not lock out otherwise-authorized users; pair it with an IP allowlist for
 * a hard boundary.
 */
export function geoAllowed(
    countryCode: string | null | undefined,
    allowedCountries: readonly string[],
    allowedContinents: readonly string[]
): boolean {
    if (allowedCountries.length === 0 && allowedContinents.length === 0) return true;
    if (!countryCode) return true;
    const cc = countryCode.toUpperCase();
    if (allowedCountries.some((code) => code.toUpperCase() === cc)) return true;
    const continent = continentOf(cc);
    if (continent && allowedContinents.some((code) => code.toUpperCase() === continent)) return true;
    return false;
}

/** Uppercase, validate, and dedupe a list of country codes against the known set. */
export function normalizeCountryCodes(values: readonly string[]): string[] {
    const known = new Set(COUNTRY_CODES);
    const out = new Set<string>();
    for (const value of values) {
        const code = value.trim().toUpperCase();
        if (known.has(code)) out.add(code);
    }
    return [...out];
}

/** Uppercase, validate, and dedupe a list of continent codes. */
export function normalizeContinentCodes(values: readonly string[]): string[] {
    const known = new Set(CONTINENTS.map((entry) => entry.code));
    const out = new Set<string>();
    for (const value of values) {
        const code = value.trim().toUpperCase();
        if (known.has(code)) out.add(code);
    }
    return [...out];
}
