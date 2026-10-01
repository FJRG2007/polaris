/**
 * Public holiday calendars a person can subscribe to by picking a region.
 *
 * Source: Thunderbird's holiday calendars page,
 * https://www.thunderbird.net/en-US/calendar/holidays/ (fetched 2026-10-01),
 * read row by row - the feed's address, the name the page gives it and the
 * years it covers. That page is Mozilla website content, licensed CC BY-SA 3.0
 * Unported or later (https://www.mozilla.org/foundation/licensing/website-content/);
 * what is taken from it here is that list of facts, with this attribution.
 * The feeds are subscribed to as ordinary ICS addresses, so nothing here is
 * fetched until a person picks one.
 *
 * `region` (ISO 3166-1) and `language` (the language the feed's event names
 * are written in) are not on that page: they were added here by reading each
 * feed, so a screen can name the region in the reader's language. Two rows of
 * the page are left out because their feeds held no events at the time:
 * Indonesia and Ukraine.
 */

export interface HolidayCalendar {
    readonly region: string;
    readonly language: string;
    readonly name: string;
    readonly url: string;
    readonly datespan: string;
}

export const HOLIDAY_CALENDARS: readonly HolidayCalendar[] = [
    { region: "AL", language: "sq", name: "Albania", url: "https://www.thunderbird.net/media/caldata/autogen/AlbaniaHolidays.ics", datespan: "2025-2028" },
    { region: "DZ", language: "ar", name: "Algeria (Arabic)", url: "https://www.thunderbird.net/media/caldata/autogen/AlgeriaHolidaysArabic.ics", datespan: "2025-2028" },
    { region: "DZ", language: "fr", name: "Algeria (French)", url: "https://www.thunderbird.net/media/caldata/autogen/AlgeriaHolidays.ics", datespan: "2025-2028" },
    { region: "AR", language: "es", name: "Argentina", url: "https://www.thunderbird.net/media/caldata/autogen/ArgentinaHolidays.ics", datespan: "2025-2028" },
    { region: "AM", language: "hy", name: "Armenia", url: "https://www.thunderbird.net/media/caldata/autogen/ArmeniaHolidays.ics", datespan: "2025-2028" },
    { region: "AU", language: "en", name: "Australia", url: "https://www.thunderbird.net/media/caldata/autogen/AustraliaHolidays.ics", datespan: "2025-2028" },
    { region: "AT", language: "de", name: "Austrian", url: "https://www.thunderbird.net/media/caldata/autogen/AustrianHolidays.ics", datespan: "2025-2028" },
    { region: "BE", language: "nl", name: "Belgian (Dutch)", url: "https://www.thunderbird.net/media/caldata/autogen/BelgianHolidays.ics", datespan: "2025-2028" },
    { region: "BE", language: "fr", name: "Belgian (French)", url: "https://www.thunderbird.net/media/caldata/autogen/BelgianHolidaysFrench.ics", datespan: "2025-2028" },
    { region: "BO", language: "es", name: "Bolivia", url: "https://www.thunderbird.net/media/caldata/autogen/BoliviaHolidays.ics", datespan: "2025-2028" },
    { region: "BR", language: "pt", name: "Brazil", url: "https://www.thunderbird.net/media/caldata/autogen/BrazilHolidays.ics", datespan: "2025-2028" },
    { region: "BG", language: "bg", name: "Bulgaria", url: "https://www.thunderbird.net/media/caldata/autogen/BulgarianHolidays.ics", datespan: "2025-2028" },
    { region: "CA", language: "en", name: "Canada (English)", url: "https://www.thunderbird.net/media/caldata/autogen/CanadaHolidays.ics", datespan: "2025-2028" },
    { region: "CA", language: "fr", name: "Canada (French)", url: "https://www.thunderbird.net/media/caldata/autogen/CanadaHolidaysFrench.ics", datespan: "2025-2028" },
    { region: "CL", language: "es", name: "Chile", url: "https://www.thunderbird.net/media/caldata/autogen/ChileHolidays.ics", datespan: "2025-2028" },
    { region: "CN", language: "zh", name: "China", url: "https://www.thunderbird.net/media/caldata/autogen/ChinaHolidays.ics", datespan: "2025-2028" },
    { region: "CO", language: "es", name: "Colombia", url: "https://www.thunderbird.net/media/caldata/autogen/ColombianHolidays.ics", datespan: "2025-2028" },
    { region: "CR", language: "es", name: "Costa Rica", url: "https://www.thunderbird.net/media/caldata/autogen/CostaRicaHolidays.ics", datespan: "2025-2028" },
    { region: "HR", language: "hr", name: "Croatia", url: "https://www.thunderbird.net/media/caldata/autogen/CroatiaHolidays.ics", datespan: "2025-2028" },
    { region: "CZ", language: "cs", name: "Czech", url: "https://www.thunderbird.net/media/caldata/autogen/CzechHolidays.ics", datespan: "2025-2028" },
    { region: "DK", language: "da", name: "Denmark", url: "https://www.thunderbird.net/media/caldata/autogen/DenmarkHolidays.ics", datespan: "2025-2028" },
    { region: "DO", language: "es", name: "Dominican Republic", url: "https://www.thunderbird.net/media/caldata/autogen/DominicanRepublicHolidays.ics", datespan: "2025-2028" },
    { region: "EE", language: "et", name: "Estonia", url: "https://www.thunderbird.net/media/caldata/autogen/EstoniaHolidays.ics", datespan: "2025-2028" },
    { region: "FI", language: "fi", name: "Finland (Finnish)", url: "https://www.thunderbird.net/media/caldata/autogen/FinlandHolidays.ics", datespan: "2025-2028" },
    { region: "FI", language: "sv", name: "Finland (Swedish)", url: "https://www.thunderbird.net/media/caldata/autogen/FinlandHolidaysSwedish.ics", datespan: "2025-2028" },
    { region: "FR", language: "fr", name: "France", url: "https://www.thunderbird.net/media/caldata/autogen/FrenchHolidays.ics", datespan: "2025-2028" },
    { region: "DE", language: "de", name: "Germany", url: "https://www.thunderbird.net/media/caldata/autogen/GermanHolidays.ics", datespan: "2025-2028" },
    { region: "GR", language: "el", name: "Greece", url: "https://www.thunderbird.net/media/caldata/autogen/GreeceHolidays.ics", datespan: "2025-2028" },
    { region: "GY", language: "en", name: "Guyana", url: "https://www.thunderbird.net/media/caldata/autogen/GuyanaHolidays.ics", datespan: "2025-2028" },
    { region: "HT", language: "ht", name: "Haiti", url: "https://www.thunderbird.net/media/caldata/autogen/HaitiHolidays.ics", datespan: "2025-2028" },
    { region: "HK", language: "zh", name: "Hong Kong", url: "https://www.thunderbird.net/media/caldata/autogen/HongKongHolidays.ics", datespan: "2025-2028" },
    { region: "HU", language: "hu", name: "Hungary", url: "https://www.thunderbird.net/media/caldata/autogen/HungarianHolidays.ics", datespan: "2025-2028" },
    { region: "IS", language: "is", name: "Iceland", url: "https://www.thunderbird.net/media/caldata/autogen/IcelandHolidays.ics", datespan: "2025-2028" },
    { region: "IN", language: "hi", name: "India", url: "https://www.thunderbird.net/media/caldata/autogen/IndiaHolidays.ics", datespan: "2025-2028" },
    { region: "IE", language: "en", name: "Ireland (English)", url: "https://www.thunderbird.net/media/caldata/autogen/IrelandHolidays.ics", datespan: "2025-2028" },
    { region: "IE", language: "ga", name: "Ireland (Irish)", url: "https://www.thunderbird.net/media/caldata/autogen/IrelandHolidaysIrish.ics", datespan: "2025-2028" },
    { region: "IL", language: "en", name: "Israel", url: "https://www.thunderbird.net/media/caldata/autogen/IsraelHolidays.ics", datespan: "2025-2028" },
    { region: "IT", language: "it", name: "Italy", url: "https://www.thunderbird.net/media/caldata/autogen/ItalianHolidays.ics", datespan: "2025-2028" },
    { region: "JP", language: "ja", name: "Japan", url: "https://www.thunderbird.net/media/caldata/autogen/JapanHolidays.ics", datespan: "2025-2028" },
    { region: "KZ", language: "kk", name: "Kazakhstan", url: "https://www.thunderbird.net/media/caldata/autogen/KazakhstanHolidaysEnglish.ics", datespan: "2025-2028" },
    { region: "KE", language: "sw", name: "Kenya", url: "https://www.thunderbird.net/media/caldata/autogen/KenyaHolidays.ics", datespan: "2025-2028" },
    { region: "LV", language: "lv", name: "Latvia", url: "https://www.thunderbird.net/media/caldata/autogen/LatviaHolidays.ics", datespan: "2025-2028" },
    { region: "LB", language: "ar", name: "Lebanon", url: "https://www.thunderbird.net/media/caldata/autogen/LebanonHolidays.ics", datespan: "2025-2028" },
    { region: "LI", language: "de", name: "Liechtenstein", url: "https://www.thunderbird.net/media/caldata/autogen/LiechtensteinHolidays.ics", datespan: "2025-2028" },
    { region: "LT", language: "lt", name: "Lithuania", url: "https://www.thunderbird.net/media/caldata/autogen/LithuanianHolidays.ics", datespan: "2025-2028" },
    { region: "LU", language: "fr", name: "Luxembourg (French)", url: "https://www.thunderbird.net/media/caldata/autogen/LuxembourgHolidaysFrench.ics", datespan: "2025-2028" },
    { region: "LU", language: "de", name: "Luxembourg (German)", url: "https://www.thunderbird.net/media/caldata/autogen/LuxembourgHolidaysGerman.ics", datespan: "2025-2028" },
    { region: "MY", language: "ms", name: "Malaysia", url: "https://www.thunderbird.net/media/caldata/autogen/MalaysiaHolidays.ics", datespan: "2025-2028" },
    { region: "MT", language: "mt", name: "Malta", url: "https://www.thunderbird.net/media/caldata/autogen/MaltaHolidays.ics", datespan: "2025-2028" },
    { region: "MX", language: "es", name: "Mexico", url: "https://www.thunderbird.net/media/caldata/autogen/MexicoHolidays.ics", datespan: "2025-2028" },
    { region: "MA", language: "ar", name: "Morocco", url: "https://www.thunderbird.net/media/caldata/autogen/MoroccoHolidays.ics", datespan: "2025-2028" },
    { region: "NA", language: "en", name: "Namibia", url: "https://www.thunderbird.net/media/caldata/autogen/NamibiaHolidays.ics", datespan: "2025-2028" },
    { region: "NL", language: "nl", name: "Netherlands (Dutch)", url: "https://www.thunderbird.net/media/caldata/autogen/DutchHolidays.ics", datespan: "2025-2028" },
    { region: "NL", language: "en", name: "Netherlands (English)", url: "https://www.thunderbird.net/media/caldata/autogen/DutchHolidaysEnglish.ics", datespan: "2025-2028" },
    { region: "NL", language: "fr", name: "Netherlands (French)", url: "https://www.thunderbird.net/media/caldata/autogen/DutchHolidaysFrench.ics", datespan: "2025-2028" },
    { region: "NL", language: "de", name: "Netherlands (German)", url: "https://www.thunderbird.net/media/caldata/autogen/DutchHolidaysGerman.ics", datespan: "2025-2028" },
    { region: "NZ", language: "en", name: "New Zealand", url: "https://www.thunderbird.net/media/caldata/autogen/NewZealandHolidays.ics", datespan: "2025-2028" },
    { region: "NI", language: "en", name: "Nicaragua", url: "https://www.thunderbird.net/media/caldata/autogen/NicaraguaHolidays.ics", datespan: "2025-2028" },
    { region: "NO", language: "nb", name: "Norway", url: "https://www.thunderbird.net/media/caldata/autogen/NorwegianHolidays.ics", datespan: "2025-2028" },
    { region: "PK", language: "ur", name: "Pakistan", url: "https://www.thunderbird.net/media/caldata/autogen/PakistanHolidays.ics", datespan: "2025-2028" },
    { region: "PE", language: "es", name: "Peru", url: "https://www.thunderbird.net/media/caldata/autogen/PeruHolidays.ics", datespan: "2025-2028" },
    { region: "PH", language: "en", name: "Philippines", url: "https://www.thunderbird.net/media/caldata/autogen/PhilippinesHolidays.ics", datespan: "2025-2028" },
    { region: "PL", language: "pl", name: "Polish", url: "https://www.thunderbird.net/media/caldata/autogen/PolishHolidays.ics", datespan: "2025-2028" },
    { region: "PT", language: "pt", name: "Portugal", url: "https://www.thunderbird.net/media/caldata/autogen/PortugalHolidays.ics", datespan: "2025-2028" },
    { region: "PR", language: "en", name: "Puerto Rico", url: "https://www.thunderbird.net/media/caldata/autogen/PuertoRicoHolidays.ics", datespan: "2025-2028" },
    { region: "RO", language: "ro", name: "Romania", url: "https://www.thunderbird.net/media/caldata/autogen/RomaniaHolidays.ics", datespan: "2025-2028" },
    { region: "RU", language: "ru", name: "Russia", url: "https://www.thunderbird.net/media/caldata/autogen/RussiaHolidays.ics", datespan: "2025-2028" },
    { region: "SG", language: "ms", name: "Singapore", url: "https://www.thunderbird.net/media/caldata/autogen/SingaporeHolidays.ics", datespan: "2025-2028" },
    { region: "SK", language: "sk", name: "Slovakia", url: "https://www.thunderbird.net/media/caldata/autogen/SlovakHolidays.ics", datespan: "2025-2028" },
    { region: "SI", language: "sl", name: "Slovenia", url: "https://www.thunderbird.net/media/caldata/autogen/SlovenianHolidays.ics", datespan: "2025-2028" },
    { region: "ZA", language: "en", name: "South Africa", url: "https://www.thunderbird.net/media/caldata/autogen/SouthAfricaHolidays.ics", datespan: "2025-2028" },
    { region: "KR", language: "ko", name: "South Korea", url: "https://www.thunderbird.net/media/caldata/autogen/SouthKoreaHolidays.ics", datespan: "2025-2028" },
    { region: "ES", language: "es", name: "Spain", url: "https://www.thunderbird.net/media/caldata/autogen/SpainHolidays.ics", datespan: "2025-2028" },
    { region: "LK", language: "en", name: "Sri Lanka", url: "https://www.thunderbird.net/media/caldata/autogen/SriLankaHolidays.ics", datespan: "2025-2028" },
    { region: "SE", language: "sv", name: "Swedish", url: "https://www.thunderbird.net/media/caldata/autogen/SwedishHolidays.ics", datespan: "2025-2028" },
    { region: "CH", language: "en", name: "Switzerland", url: "https://www.thunderbird.net/media/caldata/autogen/SwissHolidays.ics", datespan: "2025-2028" },
    { region: "TW", language: "zh", name: "Taiwan", url: "https://www.thunderbird.net/media/caldata/autogen/TaiwanHolidays.ics", datespan: "2025-2028" },
    { region: "TH", language: "th", name: "Thailand", url: "https://www.thunderbird.net/media/caldata/autogen/ThailandHolidays.ics", datespan: "2025-2028" },
    { region: "TT", language: "en", name: "Trinidad and Tobago", url: "https://www.thunderbird.net/media/caldata/autogen/TrinidadandTobagoHolidays.ics", datespan: "2025-2028" },
    { region: "TR", language: "tr", name: "Turkey", url: "https://www.thunderbird.net/media/caldata/autogen/TurkeyHolidays.ics", datespan: "2025-2028" },
    { region: "GB", language: "en", name: "United Kingdom", url: "https://www.thunderbird.net/media/caldata/autogen/UKHolidays.ics", datespan: "2025-2028" },
    { region: "US", language: "en", name: "United States", url: "https://www.thunderbird.net/media/caldata/autogen/USHolidays.ics", datespan: "2025-2028" },
    { region: "UY", language: "es", name: "Uruguay", url: "https://www.thunderbird.net/media/caldata/autogen/UruguayHolidays.ics", datespan: "2025-2028" },
    { region: "VN", language: "vi", name: "Vietnam", url: "https://www.thunderbird.net/media/caldata/autogen/VietnamHolidays.ics", datespan: "2025-2028" }
];
