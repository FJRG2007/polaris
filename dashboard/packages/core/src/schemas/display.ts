/**
 * How dates, times, temperatures and money are written on screen.
 *
 * Two layers decide it: the platform default an operator sets for the whole
 * deployment, and the per-user override on top of it. A user preference holds
 * only the fields that user actually chose, so a field left alone keeps
 * following the platform - which is what lets an operator change the house style
 * once and have it reach everyone who never picked their own.
 *
 * The formatters build the date and the clock by hand instead of leaning on a
 * locale, because the point of the setting is that the order and the width are
 * the user's choice rather than whatever their locale implies. Money still goes
 * through Intl: currency symbols and grouping are not something to reinvent.
 */

import { z } from "zod";

export const TEMPERATURE_UNITS = ["c", "f"] as const;
export const DATE_ORDERS = ["dmy", "mdy"] as const;
export const YEAR_FORMATS = ["yyyy", "yy"] as const;
export const CLOCK_FORMATS = ["24h", "12h"] as const;

/** The languages the interface is translated into. English is the only one so
 *  far; the setting exists so an account keeps its choice when more arrive. */
export const LANGUAGES = ["en"] as const;

/** Currencies offered for amounts. Codes are ISO 4217; Intl draws the symbol. */
export const CURRENCIES = [
    { code: "EUR", label: "Euro" },
    { code: "USD", label: "US dollar" },
    { code: "GBP", label: "Pound sterling" },
    { code: "CHF", label: "Swiss franc" },
    { code: "SEK", label: "Swedish krona" },
    { code: "NOK", label: "Norwegian krone" },
    { code: "DKK", label: "Danish krone" },
    { code: "PLN", label: "Polish zloty" },
    { code: "CAD", label: "Canadian dollar" },
    { code: "AUD", label: "Australian dollar" },
    { code: "MXN", label: "Mexican peso" },
    { code: "BRL", label: "Brazilian real" },
    { code: "ARS", label: "Argentine peso" },
    { code: "COP", label: "Colombian peso" },
    { code: "CLP", label: "Chilean peso" },
    { code: "JPY", label: "Japanese yen" },
    { code: "CNY", label: "Chinese yuan" },
    { code: "INR", label: "Indian rupee" }
] as const;

export type CurrencyCode = (typeof CURRENCIES)[number]["code"];

const CURRENCY_CODES = CURRENCIES.map((entry) => entry.code) as [CurrencyCode, ...CurrencyCode[]];

export type TemperatureUnit = (typeof TEMPERATURE_UNITS)[number];
export type DateOrder = (typeof DATE_ORDERS)[number];
export type YearFormat = (typeof YEAR_FORMATS)[number];
export type ClockFormat = (typeof CLOCK_FORMATS)[number];
export type Language = (typeof LANGUAGES)[number];

/** A complete set of choices - what every screen ends up formatting against. */
export const displayPreferencesSchema = z.object({
    temperature: z.enum(TEMPERATURE_UNITS),
    dateOrder: z.enum(DATE_ORDERS),
    yearFormat: z.enum(YEAR_FORMATS),
    clock: z.enum(CLOCK_FORMATS),
    currency: z.enum(CURRENCY_CODES),
    language: z.enum(LANGUAGES)
});

export type DisplayPreferences = z.infer<typeof displayPreferencesSchema>;

/** A user's own choices. Every field is optional: an absent one follows the
 *  platform default rather than pinning today's value. */
export const userDisplayPreferencesSchema = displayPreferencesSchema.partial();

export type UserDisplayPreferences = z.infer<typeof userDisplayPreferencesSchema>;

/** What a deployment formats with until an operator says otherwise. */
export const DISPLAY_DEFAULTS: DisplayPreferences = {
    temperature: "c",
    dateOrder: "mdy",
    yearFormat: "yyyy",
    clock: "24h",
    currency: "EUR",
    language: "en"
};

/** Drop the keys that were not chosen, so a spread cannot overwrite a lower
 *  layer with `undefined`. */
function chosen(preferences: UserDisplayPreferences): UserDisplayPreferences {
    return Object.fromEntries(
        Object.entries(preferences).filter(([, value]) => value !== undefined)
    ) as UserDisplayPreferences;
}

/** Built-in defaults, then the platform's, then the user's own. */
export function resolveDisplayPreferences(
    platform: UserDisplayPreferences | null | undefined,
    user?: UserDisplayPreferences | null
): DisplayPreferences {
    return { ...DISPLAY_DEFAULTS, ...chosen(platform ?? {}), ...chosen(user ?? {}) };
}

/**
 * Read a stored preference blob. The column holds stringified JSON, so anything
 * unparseable or no longer valid degrades to "chose nothing" - which formats
 * against the layer below instead of failing a page render.
 */
export function parseDisplayPreferences(value: string | null | undefined): UserDisplayPreferences {
    if (!value) return {};
    try {
        const parsed = userDisplayPreferencesSchema.safeParse(JSON.parse(value));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

/** Serialize choices back to the stored form, keeping only what was chosen. */
export function stringifyDisplayPreferences(preferences: UserDisplayPreferences): string {
    return JSON.stringify(chosen(preferences));
}

/** The BCP 47 tag Intl formats with. */
export function localeFor(language: Language): string {
    return language;
}

/** Celsius as the unit asks for it. Readings are stored in Celsius throughout. */
export function toDisplayTemperature(celsius: number, unit: TemperatureUnit): number {
    return unit === "f" ? celsius * 1.8 + 32 : celsius;
}

/** The suffix that goes after a converted reading ("C" or "F"). */
export function temperatureSuffix(unit: TemperatureUnit): string {
    return unit === "f" ? "F" : "C";
}

/** A date/time to format. Anything unparseable formats as "-". */
export type Formattable = Date | string | number | null | undefined;

function toDate(value: Formattable): Date | null {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value: number): string {
    return String(value).padStart(2, "0");
}

/** The formatters every screen uses. Bound to one set of preferences. */
export interface DisplayFormat {
    readonly preferences: DisplayPreferences;
    /** "31/07/2026", "07/31/26", ... */
    date(value: Formattable): string;
    /** "14:05", "2:05 PM". Seconds are opt-in. */
    time(value: Formattable, options?: { seconds?: boolean }): string;
    /** The date and the time, in that order. */
    dateTime(value: Formattable, options?: { seconds?: boolean }): string;
    /** A Celsius reading in the chosen unit, e.g. "42 C" or "108 F". */
    temperature(celsius: number | null | undefined): string;
    /** An amount in the chosen currency. */
    currency(amount: number | null | undefined): string;
}

export function createDisplayFormat(preferences: DisplayPreferences): DisplayFormat {
    const { dateOrder, yearFormat, clock, temperature, currency, language } = preferences;

    function date(value: Formattable): string {
        const parsed = toDate(value);
        if (!parsed) return "-";
        const day = pad(parsed.getDate());
        const month = pad(parsed.getMonth() + 1);
        const year = yearFormat === "yy" ? pad(parsed.getFullYear() % 100) : String(parsed.getFullYear());
        return dateOrder === "mdy" ? `${month}/${day}/${year}` : `${day}/${month}/${year}`;
    }

    function time(value: Formattable, options?: { seconds?: boolean }): string {
        const parsed = toDate(value);
        if (!parsed) return "-";
        const seconds = options?.seconds ? `:${pad(parsed.getSeconds())}` : "";
        const minutes = pad(parsed.getMinutes());
        if (clock === "12h") {
            const hours = parsed.getHours() % 12 === 0 ? 12 : parsed.getHours() % 12;
            return `${hours}:${minutes}${seconds} ${parsed.getHours() < 12 ? "AM" : "PM"}`;
        }
        return `${pad(parsed.getHours())}:${minutes}${seconds}`;
    }

    return {
        preferences,
        date,
        time,
        dateTime(value, options) {
            const parsed = toDate(value);
            return parsed ? `${date(parsed)} ${time(parsed, options)}` : "-";
        },
        temperature(celsius) {
            if (celsius === null || celsius === undefined || !Number.isFinite(celsius)) return "-";
            return `${Math.round(toDisplayTemperature(celsius, temperature))} ${temperatureSuffix(temperature)}`;
        },
        currency(amount) {
            if (amount === null || amount === undefined || !Number.isFinite(amount)) return "-";
            return new Intl.NumberFormat(localeFor(language), { style: "currency", currency }).format(amount);
        }
    };
}

/** Formatters for the built-in defaults, for code with no preferences at hand. */
export const DEFAULT_DISPLAY_FORMAT: DisplayFormat = createDisplayFormat(DISPLAY_DEFAULTS);
