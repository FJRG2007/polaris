/**
 * How a duration and a count read wherever Game servers shows one - the side
 * panel in the game, challenges, events, and the screens - so "most time
 * played" never reads 2000 h and a count never reads 10000.
 *
 * A duration steps up through the units as it grows - seconds, minutes, hours,
 * days, weeks, months, years - and keeps one decimal while that says something
 * (`26 h` is `1.1 d`, `45 d` is `6.4 wk`). A count of ten thousand or more is
 * written short, the way each language writes it (`12K`, `1.2M`; `12 mil`,
 * `1,2 M`).
 *
 * Pure and browser-safe.
 */

/** The languages figures are written in; anything else reads as English. */
export type FigureLanguage = "en" | "es";

/** A locale (`es-ES`, `en`) as the language its figures are written in. */
export function figureLanguage(locale: string | null | undefined): FigureLanguage {
    return typeof locale === "string" && /^es\b/i.test(locale) ? "es" : "en";
}

const TAGS: Readonly<Record<FigureLanguage, string>> = { en: "en-US", es: "es-ES" };

export type DurationUnit = "s" | "min" | "h" | "d" | "wk" | "mo" | "yr";

/** Each unit, how long it is, and how many of it before the next one reads better. */
const STEPS: readonly { unit: DurationUnit; ms: number; upTo: number }[] = [
    { unit: "s", ms: 1_000, upTo: 60 },
    { unit: "min", ms: 60_000, upTo: 60 },
    { unit: "h", ms: 3_600_000, upTo: 24 },
    { unit: "d", ms: 86_400_000, upTo: 7 },
    // Weeks up to eight: "6.4 wk" says more than "1.5 mo".
    { unit: "wk", ms: 7 * 86_400_000, upTo: 8 },
    // A month and a year as the calendar averages them.
    { unit: "mo", ms: 30.436875 * 86_400_000, upTo: 12 },
    { unit: "yr", ms: 365.2425 * 86_400_000, upTo: Number.POSITIVE_INFINITY }
];

const UNIT_LABELS: Readonly<Record<FigureLanguage, Readonly<Record<DurationUnit, string>>>> = {
    en: { s: "s", min: "min", h: "h", d: "d", wk: "wk", mo: "mo", yr: "yr" },
    es: { s: "s", min: "min", h: "h", d: "d", wk: "sem", mo: "mes", yr: "a" }
};

/** One decimal under ten, where it still says something; whole numbers past it. */
function rounded(value: number): number {
    return value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
}

/** A duration as a number and its unit: the largest unit it fills at least once. */
export function durationParts(ms: number): { value: number; unit: DurationUnit } {
    const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
    for (const [index, step] of STEPS.entries()) {
        const value = rounded(safe / step.ms);
        // Rounding up to the next unit's worth reads in that unit instead:
        // 59.97 minutes is an hour, not "60 min".
        if (value < step.upTo || index === STEPS.length - 1) return { value, unit: step.unit };
    }
    return { value: 0, unit: "s" };
}

/** A number as the language writes it: `1.5`, `1,5`. */
function plain(value: number, language: FigureLanguage): string {
    return new Intl.NumberFormat(TAGS[language], {
        maximumFractionDigits: 1,
        useGrouping: false
    }).format(value);
}

/** A duration, short: `45 s`, `12 min`, `1.1 d`, `6.4 wk`, `2 yr`; in Spanish `6,4 sem`. */
export function formatDuration(ms: number, language: FigureLanguage = "en"): string {
    const { value, unit } = durationParts(ms);
    return `${plain(value, language)} ${UNIT_LABELS[language][unit]}`;
}

/** Below this a count is written out in full. */
export const COMPACT_FROM = 10_000;

/** A count, short once it is large: `9999`, `12K`, `1.2M`; in Spanish `12 mil`, `1,2 M`. */
export function formatCount(value: number, language: FigureLanguage = "en"): string {
    const whole = Number.isFinite(value) ? Math.round(value) : 0;
    if (Math.abs(whole) < COMPACT_FROM) return String(whole);
    return new Intl.NumberFormat(TAGS[language], {
        notation: "compact",
        maximumFractionDigits: 1
    }).format(whole);
}
