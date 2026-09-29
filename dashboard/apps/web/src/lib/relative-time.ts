/**
 * How long ago, in the few words somebody would actually say.
 *
 * Absolute time below a minute is noise, and past a week the date itself is what
 * anybody wants - so the switch to a date is the point of this, and the date has
 * to be written the way the reader has asked for dates to be written. That is why
 * the formatter is a parameter rather than a `toLocaleDateString` call: this runs
 * in a browser, whose locale is not the account's preference.
 *
 * There is a `<RelativeTime>` element too, which upgrades itself and re-renders as
 * time passes. This is for the places that need the phrase inside a longer string -
 * "since 3h ago", a title attribute - where an element cannot go.
 */

import type { DisplayFormat } from "@polaris/core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function relativeTime(
    iso: string | null | undefined,
    format: DisplayFormat,
    /** What to say when there is no time to say anything about. */
    absent = "not recorded",
    now: number = Date.now()
): string {
    if (!iso) return absent;
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return absent;
    const elapsed = now - at;
    // Phrased by Intl in the reader's language: "3m ago" in English, "hace 3
    // min" in Spanish. Always a number, so a day is "1d ago" rather than
    // "yesterday" - the same shape at every step.
    const phrase = new Intl.RelativeTimeFormat(format.preferences.language, {
        numeric: "always",
        style: "narrow"
    });
    if (elapsed < MINUTE) {
        return new Intl.RelativeTimeFormat(format.preferences.language, { numeric: "auto" }).format(0, "second");
    }
    if (elapsed < HOUR) return phrase.format(-Math.floor(elapsed / MINUTE), "minute");
    if (elapsed < DAY) return phrase.format(-Math.floor(elapsed / HOUR), "hour");
    if (elapsed <= WEEK) return phrase.format(-Math.floor(elapsed / DAY), "day");
    return format.date(iso);
}
