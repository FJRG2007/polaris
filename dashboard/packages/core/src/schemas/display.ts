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
import { THEME_IDS } from "./themes.js";

export const TEMPERATURE_UNITS = ["c", "f"] as const;
export const DATE_ORDERS = ["dmy", "mdy"] as const;
export const YEAR_FORMATS = ["yyyy", "yy"] as const;
export const CLOCK_FORMATS = ["24h", "12h"] as const;

/** Which day a calendar week is drawn from. The three in real use: most of the
 *  world reads a week as Monday to Sunday, the Americas as Sunday first, and
 *  parts of the Middle East as Saturday first. */
export const WEEK_STARTS = ["sun", "mon", "sat"] as const;

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
export type WeekStart = (typeof WEEK_STARTS)[number];
export type Language = (typeof LANGUAGES)[number];

/** A complete set of choices - what every screen ends up formatting against. */
export const displayPreferencesSchema = z.object({
    temperature: z.enum(TEMPERATURE_UNITS),
    dateOrder: z.enum(DATE_ORDERS),
    yearFormat: z.enum(YEAR_FORMATS),
    clock: z.enum(CLOCK_FORMATS),
    weekStart: z.enum(WEEK_STARTS),
    currency: z.enum(CURRENCY_CODES),
    language: z.enum(LANGUAGES),
    theme: z.enum(THEME_IDS)
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
    weekStart: "sun",
    currency: "EUR",
    language: "en",
    theme: "dark"
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

/** Weekday names, indexed the way `Date.getDay()` numbers them. */
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The `Date.getDay()` index a week begins on, which is what every calendar
 *  header, week grid and "this week" window counts from. */
export function weekStartIndex(weekStart: WeekStart): number {
    if (weekStart === "mon") return 1;
    return weekStart === "sat" ? 6 : 0;
}

/** The seven `getDay()` indexes in the order this week runs, so a header and the
 *  cells under it can never disagree about which column is which day. */
export function weekdayOrder(weekStart: WeekStart): number[] {
    const first = weekStartIndex(weekStart);
    return Array.from({ length: 7 }, (_, offset) => (first + offset) % 7);
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
    /** The `getDay()` index the week starts on, for the views that draw one. */
    readonly weekStartsOn: number;
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
        weekStartsOn: weekStartIndex(preferences.weekStart),
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

/**
 * What somebody may choose to appear as, and what a dot may say.
 *
 * Here rather than beside the service that resolves it, because the picker is a
 * client component: a menu that imported the resolver would drag Prisma into the
 * browser bundle, and the words are the half both sides need.
 *
 * `auto` is what almost everybody keeps and means "work it out from whether I am
 * at the screen". The other three are somebody deciding, and a decision outranks
 * an observation - a green dot over the top of "do not disturb" would make the
 * setting a lie.
 */
export const PRESENCE_CHOICES = ["auto", "busy", "away", "invisible"] as const;

export type PresenceChoice = (typeof PRESENCE_CHOICES)[number];

export const PRESENCE_LABELS: Record<PresenceChoice, string> = {
    auto: "Online",
    busy: "Do not disturb",
    away: "Away",
    invisible: "Invisible"
};

/** What is actually drawn. Invisible is not one of these: there is no colour for
 *  it, and a state that renders differently is a state that gives itself away. */
export const PRESENCE_STATES = ["online", "idle", "busy", "offline"] as const;

export type Presence = (typeof PRESENCE_STATES)[number];

export const PRESENCE_WORDS: Record<Presence, string> = {
    online: "Online",
    idle: "Away",
    busy: "Do not disturb",
    offline: "Offline"
};

/**
 * How long a chosen status holds before it goes back to being worked out.
 *
 * The reason this exists is the status people forget they set. "Do not disturb"
 * put on for a meeting and still on two days later is worse than never having
 * set it: everybody around them stops expecting an answer, and they are not
 * told. So the same list every application that solved this settled on, and the
 * last entry is the old behaviour rather than an absence - somebody who means
 * "until I say otherwise" should be able to say it.
 *
 * Minutes rather than a timestamp, because it is chosen relative to now and the
 * moment it lands on is the server's to work out.
 */
export const PRESENCE_DURATIONS = [
    { minutes: 15, label: "For 15 minutes" },
    { minutes: 60, label: "For 1 hour" },
    { minutes: 8 * 60, label: "For 8 hours" },
    { minutes: 24 * 60, label: "For 24 hours" },
    { minutes: 3 * 24 * 60, label: "For 3 days" },
    { minutes: null, label: "Until I change it" }
] as const;

export type PresenceDuration = (typeof PRESENCE_DURATIONS)[number]["minutes"];

/** Whether a number is one of the durations offered, which is what stops a
 *  request naming a window nobody was given. */
export function isPresenceDuration(minutes: unknown): minutes is number {
    return (
        typeof minutes === "number" &&
        PRESENCE_DURATIONS.some((duration) => duration.minutes === minutes)
    );
}

/**
 * The line an account chooses to show beside its name.
 *
 * A different question from the dot: the dot says whether to expect a reply, and
 * this says why - "back Monday", "in the workshop". One sentence, because it is
 * read in a list beside thirty other names and anything longer is a paragraph
 * nobody finishes.
 */
export const MAX_STATUS = 100;

export const statusField = z.string().trim().max(MAX_STATUS, `At most ${MAX_STATUS} characters`);

/**
 * How long a status holds before it clears itself.
 *
 * The reason the last entry is not the default: the status people forget. One
 * set for an afternoon and still there the following week is worse than none at
 * all, because everybody around them has stopped reading it and nobody is told.
 * So the same ladder every client that solved this arrived at, and "until I
 * clear it" is offered rather than assumed.
 *
 * Minutes rather than a moment, because it is chosen relative to now and the
 * moment it lands on is the server's to work out.
 */
export const STATUS_DURATIONS = [
    { minutes: 30, label: "In 30 minutes" },
    { minutes: 60, label: "In 1 hour" },
    { minutes: 4 * 60, label: "In 4 hours" },
    { minutes: 24 * 60, label: "In 24 hours" },
    { minutes: null, label: "Don't clear" }
] as const;

export type StatusDuration = (typeof STATUS_DURATIONS)[number]["minutes"];

/** Whether a number is one of the windows offered, which is what stops a request
 *  naming one nobody was given. */
export function isStatusDuration(minutes: unknown): minutes is number {
    return (
        typeof minutes === "number" && STATUS_DURATIONS.some((entry) => entry.minutes === minutes)
    );
}

/** Setting the line, and when it clears. Null minutes is "until I clear it";
 *  an empty line clears it now, which is how it is taken off. */
export const userStatusSchema = z.object({
    text: statusField,
    minutes: z
        .number()
        .nullable()
        .refine((value) => value === null || isStatusDuration(value), "Not one of the windows offered")
});

export type UserStatusInput = z.infer<typeof userStatusSchema>;

/**
 * Whether a status is still standing, right now.
 *
 * Pure, and the whole rule, because three places ask it: the screen that draws
 * somebody's line, the picker that shows the owner their own, and the write that
 * decides whether to bother storing one. A lapsed status is not a status, and
 * nothing sweeps them - which only works if everybody agrees on this function.
 */
export function statusInForce(
    status: { readonly statusText: string; readonly statusUntil: Date | string | null },
    now: Date = new Date()
): boolean {
    if (!status.statusText.trim()) return false;
    if (!status.statusUntil) return true;
    return new Date(status.statusUntil).getTime() > now.getTime();
}

/**
 * What an account says about itself.
 *
 * Longer than a status and shorter than a page: it is read on a profile panel
 * beside a conversation, where the conversation is the point and this is the
 * context.
 */
export const MAX_DESCRIPTION = 280;

export const descriptionField = z
    .string()
    .trim()
    .max(MAX_DESCRIPTION, `At most ${MAX_DESCRIPTION} characters`);
