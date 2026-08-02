/**
 * Where a visitor is, without a geo-IP database.
 *
 * A visitor's IANA time zone names their country almost exactly - "Europe/Madrid"
 * is Spain and nothing else - and the browser hands it over for free. That is worth
 * far more than it looks: a geo-IP database is a licensed, hundred-megabyte file
 * that goes stale, has to be shipped and updated, and is wrong for anyone on a VPN.
 * The time zone is none of those things, and it is what Umami does too.
 *
 * The trade is honest and worth stating: a time zone is coarse (one entry for the
 * whole US Eastern seaboard, so the map here resolves those to the country rather
 * than pretending to a city), and a request that never ran the tracker has no time
 * zone at all - for those the edge's country header is used when the proxy in front
 * supplies one, and the location is simply unknown otherwise.
 *
 * Country names and flags are derived rather than stored: Intl knows every name,
 * and a flag is two regional-indicator code points computed from the letters.
 */

/**
 * Time zone to ISO-3166 alpha-2.
 *
 * Zones whose country is already in the name (Europe/Madrid) still need to be here,
 * because the name is a city, not a country. Zones shared by several countries are
 * left out entirely rather than guessed at - an unknown location is a fact, and a
 * wrong one is worse than a blank.
 */
const ZONE_COUNTRY: Readonly<Record<string, string>> = {
    // Europe
    "Europe/Madrid": "ES",
    "Atlantic/Canary": "ES",
    "Africa/Ceuta": "ES",
    "Europe/Lisbon": "PT",
    "Atlantic/Azores": "PT",
    "Atlantic/Madeira": "PT",
    "Europe/London": "GB",
    "Europe/Dublin": "IE",
    "Europe/Paris": "FR",
    "Europe/Berlin": "DE",
    "Europe/Busingen": "DE",
    "Europe/Rome": "IT",
    "Europe/Amsterdam": "NL",
    "Europe/Brussels": "BE",
    "Europe/Luxembourg": "LU",
    "Europe/Zurich": "CH",
    "Europe/Vienna": "AT",
    "Europe/Prague": "CZ",
    "Europe/Bratislava": "SK",
    "Europe/Warsaw": "PL",
    "Europe/Budapest": "HU",
    "Europe/Bucharest": "RO",
    "Europe/Sofia": "BG",
    "Europe/Athens": "GR",
    "Europe/Istanbul": "TR",
    "Europe/Zagreb": "HR",
    "Europe/Ljubljana": "SI",
    "Europe/Belgrade": "RS",
    "Europe/Sarajevo": "BA",
    "Europe/Skopje": "MK",
    "Europe/Podgorica": "ME",
    "Europe/Tirane": "AL",
    "Europe/Chisinau": "MD",
    "Europe/Kyiv": "UA",
    "Europe/Kiev": "UA",
    "Europe/Minsk": "BY",
    "Europe/Moscow": "RU",
    "Europe/Kaliningrad": "RU",
    "Europe/Samara": "RU",
    "Asia/Yekaterinburg": "RU",
    "Asia/Novosibirsk": "RU",
    "Asia/Krasnoyarsk": "RU",
    "Asia/Irkutsk": "RU",
    "Asia/Vladivostok": "RU",
    "Europe/Stockholm": "SE",
    "Europe/Oslo": "NO",
    "Europe/Copenhagen": "DK",
    "Europe/Helsinki": "FI",
    "Europe/Tallinn": "EE",
    "Europe/Riga": "LV",
    "Europe/Vilnius": "LT",
    "Atlantic/Reykjavik": "IS",
    "Europe/Malta": "MT",
    "Asia/Nicosia": "CY",
    "Europe/Monaco": "MC",
    "Europe/Andorra": "AD",
    "Europe/San_Marino": "SM",
    "Europe/Vatican": "VA",
    "Europe/Gibraltar": "GI",
    // Americas
    "America/New_York": "US",
    "America/Detroit": "US",
    "America/Chicago": "US",
    "America/Denver": "US",
    "America/Phoenix": "US",
    "America/Los_Angeles": "US",
    "America/Anchorage": "US",
    "America/Indiana/Indianapolis": "US",
    "America/Kentucky/Louisville": "US",
    "Pacific/Honolulu": "US",
    "America/Puerto_Rico": "PR",
    "America/Toronto": "CA",
    "America/Vancouver": "CA",
    "America/Edmonton": "CA",
    "America/Winnipeg": "CA",
    "America/Halifax": "CA",
    "America/St_Johns": "CA",
    "America/Mexico_City": "MX",
    "America/Monterrey": "MX",
    "America/Tijuana": "MX",
    "America/Cancun": "MX",
    "America/Guatemala": "GT",
    "America/El_Salvador": "SV",
    "America/Tegucigalpa": "HN",
    "America/Managua": "NI",
    "America/Costa_Rica": "CR",
    "America/Panama": "PA",
    "America/Havana": "CU",
    "America/Santo_Domingo": "DO",
    "America/Port-au-Prince": "HT",
    "America/Jamaica": "JM",
    "America/Bogota": "CO",
    "America/Caracas": "VE",
    "America/Guayaquil": "EC",
    "America/Lima": "PE",
    "America/La_Paz": "BO",
    "America/Asuncion": "PY",
    "America/Montevideo": "UY",
    "America/Santiago": "CL",
    "America/Argentina/Buenos_Aires": "AR",
    "America/Argentina/Cordoba": "AR",
    "America/Argentina/Mendoza": "AR",
    "America/Sao_Paulo": "BR",
    "America/Bahia": "BR",
    "America/Fortaleza": "BR",
    "America/Recife": "BR",
    "America/Manaus": "BR",
    "America/Belem": "BR",
    // Africa and the Middle East
    "Africa/Casablanca": "MA",
    "Africa/Algiers": "DZ",
    "Africa/Tunis": "TN",
    "Africa/Tripoli": "LY",
    "Africa/Cairo": "EG",
    "Africa/Khartoum": "SD",
    "Africa/Lagos": "NG",
    "Africa/Accra": "GH",
    "Africa/Abidjan": "CI",
    "Africa/Dakar": "SN",
    "Africa/Bamako": "ML",
    "Africa/Nairobi": "KE",
    "Africa/Kampala": "UG",
    "Africa/Dar_es_Salaam": "TZ",
    "Africa/Addis_Ababa": "ET",
    "Africa/Kigali": "RW",
    "Africa/Luanda": "AO",
    "Africa/Kinshasa": "CD",
    "Africa/Douala": "CM",
    "Africa/Harare": "ZW",
    "Africa/Lusaka": "ZM",
    "Africa/Maputo": "MZ",
    "Africa/Johannesburg": "ZA",
    "Indian/Mauritius": "MU",
    "Asia/Jerusalem": "IL",
    "Asia/Beirut": "LB",
    "Asia/Damascus": "SY",
    "Asia/Amman": "JO",
    "Asia/Baghdad": "IQ",
    "Asia/Riyadh": "SA",
    "Asia/Kuwait": "KW",
    "Asia/Qatar": "QA",
    "Asia/Bahrain": "BH",
    "Asia/Dubai": "AE",
    "Asia/Muscat": "OM",
    "Asia/Tehran": "IR",
    "Asia/Baku": "AZ",
    "Asia/Yerevan": "AM",
    "Asia/Tbilisi": "GE",
    // Asia and Oceania
    "Asia/Karachi": "PK",
    "Asia/Kabul": "AF",
    "Asia/Kolkata": "IN",
    "Asia/Calcutta": "IN",
    "Asia/Colombo": "LK",
    "Asia/Kathmandu": "NP",
    "Asia/Dhaka": "BD",
    "Asia/Yangon": "MM",
    "Asia/Bangkok": "TH",
    "Asia/Phnom_Penh": "KH",
    "Asia/Vientiane": "LA",
    "Asia/Ho_Chi_Minh": "VN",
    "Asia/Saigon": "VN",
    "Asia/Kuala_Lumpur": "MY",
    "Asia/Singapore": "SG",
    "Asia/Jakarta": "ID",
    "Asia/Makassar": "ID",
    "Asia/Jayapura": "ID",
    "Asia/Manila": "PH",
    "Asia/Hong_Kong": "HK",
    "Asia/Macau": "MO",
    "Asia/Taipei": "TW",
    "Asia/Shanghai": "CN",
    "Asia/Urumqi": "CN",
    "Asia/Seoul": "KR",
    "Asia/Pyongyang": "KP",
    "Asia/Tokyo": "JP",
    "Asia/Ulaanbaatar": "MN",
    "Asia/Almaty": "KZ",
    "Asia/Tashkent": "UZ",
    "Asia/Ashgabat": "TM",
    "Asia/Dushanbe": "TJ",
    "Asia/Bishkek": "KG",
    "Australia/Sydney": "AU",
    "Australia/Melbourne": "AU",
    "Australia/Brisbane": "AU",
    "Australia/Perth": "AU",
    "Australia/Adelaide": "AU",
    "Australia/Darwin": "AU",
    "Australia/Hobart": "AU",
    "Pacific/Auckland": "NZ",
    "Pacific/Fiji": "FJ",
    "Pacific/Guam": "GU",
    "Pacific/Port_Moresby": "PG"
};

/** The country a time zone belongs to, or null when the zone is unknown or spans
 *  more than one. */
export function countryForTimeZone(zone: string | null | undefined): string | null {
    if (!zone) return null;
    return ZONE_COUNTRY[zone] ?? null;
}

/** A country code out of whatever the request carried: the edge's country header
 *  where a proxy sets one, else the visitor's time zone. */
export function resolveCountry(header: string | null | undefined, zone: string | null | undefined): string | null {
    const code = header?.trim().toUpperCase();
    // Cloudflare sends XX for an address it cannot place and T1 for Tor, neither of
    // which is a country.
    if (code && /^[A-Z]{2}$/.test(code) && code !== "XX" && code !== "T1") return code;
    return countryForTimeZone(zone);
}

let names: Intl.DisplayNames | null | undefined;

/**
 * The country's name in English.
 *
 * Deliberately not localised to the reader: the rest of the dashboard is in English,
 * and a breakdown whose row labels change language halfway down - because some are
 * translated and the codes underneath are not - reads as a bug.
 */
export function countryName(code: string | null | undefined): string {
    if (!code || !/^[A-Za-z]{2}$/.test(code)) return "Unknown";
    const upper = code.toUpperCase();
    if (names === undefined) {
        try {
            names = new Intl.DisplayNames(["en"], { type: "region" });
        } catch {
            names = null;
        }
    }
    return names?.of(upper) ?? upper;
}

/**
 * The flag, as the two regional-indicator code points the letters map to. Computed
 * rather than stored - there is no table of flags to keep, and a code Intl has never
 * heard of still renders as its own letters instead of a missing glyph.
 */
export function countryFlag(code: string | null | undefined): string {
    if (!code || !/^[A-Za-z]{2}$/.test(code)) return "";
    const upper = code.toUpperCase();
    return String.fromCodePoint(...[...upper].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

/** The primary language of an Accept-Language header, as a bare tag ("es-ES"). */
export function parseLanguage(header: string | null | undefined): string | null {
    if (!header) return null;
    const first = header.split(",")[0]?.split(";")[0]?.trim();
    if (!first || first === "*") return null;
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(first) ? first : null;
}
