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
    if (elapsed < MINUTE) return "just now";
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
    if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
    if (elapsed <= WEEK) return `${Math.floor(elapsed / DAY)}d ago`;
    return format.date(iso);
}
