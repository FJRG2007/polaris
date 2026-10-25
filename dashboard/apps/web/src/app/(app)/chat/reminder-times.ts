/**
 * When "remind me tomorrow" is.
 *
 * Read on the account's own clock rather than the browser's, the same way the
 * scheduling dialog reads it - see `schedule-dialog.tsx`. "Tomorrow" is nine in
 * the morning where the reader lives, not twenty-four hours from now, and not
 * nine in a zone the browser happens to be set to.
 *
 * Pure, so the presets can be asserted against a fixed now.
 */

import * as core from "@polaris/core";

/** The hour "morning" means. Nine, which is what every client that offers this
 *  settled on and what an office day starts at. */
export const MORNING = 9;

/** A reading on a wall clock, in some zone. */
export interface Reading {
    year: number;
    month: number;
    day: number;
    hours: number;
    minutes: number;
}

/** The day `days` after this one, in the zone the reading is written in. Built
 *  through UTC so the month and the year roll over on their own. */
export function plusDays(reading: Reading, days: number): Reading {
    const walked = new Date(Date.UTC(reading.year, reading.month - 1, reading.day + days));
    return {
        year: walked.getUTCFullYear(),
        month: walked.getUTCMonth() + 1,
        day: walked.getUTCDate(),
        hours: reading.hours,
        minutes: reading.minutes
    };
}

/** Which day of the week a reading falls on, 0 for Sunday. */
export function weekdayOf(reading: Reading): number {
    return new Date(Date.UTC(reading.year, reading.month - 1, reading.day)).getUTCDay();
}

/** Tomorrow at nine, on the reader's clock. */
export function tomorrowMorning(now: Date, timeZone: string): Reading {
    return plusDays({ ...core.wallClock(now, timeZone), hours: MORNING, minutes: 0 }, 1);
}

/** The next Monday that is not today, at nine. */
export function mondayMorning(now: Date, timeZone: string): Reading {
    const today = core.wallClock(now, timeZone);
    const ahead = (8 - weekdayOf(today)) % 7 || 7;
    return plusDays({ ...today, hours: MORNING, minutes: 0 }, ahead);
}

/** The presets the message menu offers, in its order. */
export const REMINDER_PRESETS = [
    "in15Minutes",
    "in1Hour",
    "in3Hours",
    "tomorrow",
    "nextMonday"
] as const;

export type ReminderPreset = (typeof REMINDER_PRESETS)[number];

const MINUTE = 60 * 1000;

/** The instant one preset stands for, from `now`. */
export function reminderMoment(preset: ReminderPreset, now: Date, timeZone: string): Date {
    switch (preset) {
        case "in15Minutes":
            return new Date(now.getTime() + 15 * MINUTE);
        case "in1Hour":
            return new Date(now.getTime() + 60 * MINUTE);
        case "in3Hours":
            return new Date(now.getTime() + 180 * MINUTE);
        case "tomorrow":
            return core.zonedInstant(tomorrowMorning(now, timeZone), timeZone);
        case "nextMonday":
            return core.zonedInstant(mondayMorning(now, timeZone), timeZone);
    }
}
