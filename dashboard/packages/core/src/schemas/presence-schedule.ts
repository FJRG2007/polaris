/**
 * Standing hours: the windows in which an account appears as something other
 * than whatever its sessions would say.
 *
 * The picker on somebody's own face answers "what am I now, and for how long".
 * This answers the other half - the part of the week they already know about.
 * Asleep between midnight and nine. Heads down every weekday morning. Away on a
 * Friday afternoon. Those are facts about a week, not about this minute, and
 * setting them by hand twice a day is how people end up with "do not disturb"
 * still on two days later.
 *
 * **A window is a wall-clock rule, not a moment.** It is stored as minutes past
 * midnight and a set of weekdays, and read against the account's own clock. So
 * one written as 00:00 to 09:00 opens at midnight wherever that account is, on
 * the day the clocks move as much as on any other, and no row anywhere has to be
 * rewritten when either of those changes.
 *
 * **A window that ends before it starts crosses midnight.** 23:00 to 07:00 is
 * the common case and the whole reason anybody wants this, so it is a shape the
 * rule takes rather than something they have to say twice. The days named are
 * the days it *opens* on: "Friday, 23:00 to 07:00" runs into Saturday morning.
 *
 * **Nothing runs on a schedule to make a schedule true.** It is worked out on
 * the way past, in `presenceInForce`, the same way a lapsed status is - which
 * matters more here than anywhere: a job that has to be running for somebody to
 * be invisible is a job whose absence tells everybody where they are.
 */

import { z } from "zod";
import { AUTOMATIC_TIME_ZONE, wallClock, zonedInstant } from "./display.js";
import { PRESENCE_CHOICES, PRESENCE_LABELS, type PresenceChoice } from "./display.js";

/**
 * What a window may put somebody on.
 *
 * `auto` is missing on purpose, and its absence is the design: `auto` means
 * "work it out from whether I am at the screen", so a window scheduling it is a
 * window that does nothing. Somebody who wants to be back to normal at nine
 * writes a window that ends at nine.
 */
export const SCHEDULED_PRESENCES = ["busy", "away", "invisible"] as const;

export type ScheduledPresence = (typeof SCHEDULED_PRESENCES)[number];

export function isScheduledPresence(value: unknown): value is ScheduledPresence {
    return (SCHEDULED_PRESENCES as readonly unknown[]).includes(value);
}

/** The most windows one account may keep. Far above what anybody writes, and a
 *  ceiling on what a browser can make this table hold. */
export const MAX_PRESENCE_SCHEDULES = 20;

/** Minutes in a day, which is both the length of the longest window and the
 *  number a start or an end has to stay under. */
export const MINUTES_IN_DAY = 24 * 60;

/**
 * Days, as a bitmask of `getDay()` indexes - bit 0 Sunday through bit 6
 * Saturday.
 *
 * A mask rather than a row per day or a comma-separated column: it is seven
 * booleans, every question asked of it is a bit test, and it stays one integer
 * in both engines the schema has to fit. Zero is a window that never opens,
 * which is why the schema refuses it.
 */
export const EVERY_DAY = 0b1111111;

/** Monday to Friday, and the two days either side of it. Offered as presets
 *  because they are what almost every window turns out to be. */
export const WEEKDAYS = 0b0111110;

export const WEEKEND = 0b1000001;

export function dayBit(day: number): number {
    return 1 << day;
}

/** Whether a window opens on one `getDay()` index. */
export function runsOnDay(days: number, day: number): boolean {
    return (days & dayBit(day)) !== 0;
}

/** The mask with one day turned the other way, which is what a day toggle does. */
export function toggleDay(days: number, day: number): number {
    return days ^ dayBit(day);
}

/** Full names, by `getDay()` index. */
export const DAY_NAMES = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday"
] as const;

/** And the three-letter forms the toggles are drawn with. */
export const DAY_SHORT_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The seven days in the order this account's week runs, from the index its
 *  formatters already carry - so the row of toggles and every calendar in the
 *  dashboard start on the same day. */
export function weekOrderFrom(firstDay: number): number[] {
    return Array.from({ length: 7 }, (_, offset) => (firstDay + offset) % 7);
}

/**
 * The days a window runs on, in words.
 *
 * "Every day" and "Weekdays" rather than seven or five abbreviations, because
 * they are what somebody meant when they picked them and reading five names to
 * work out that they add up to the working week is a small tax on every glance.
 * Anything else is listed in the order this account's week runs in, so the list
 * never disagrees with the row of toggles above it.
 */
export function nameDays(days: number, weekOrder: readonly number[]): string {
    const mask = days & EVERY_DAY;
    if (mask === EVERY_DAY) return "Every day";
    if (mask === WEEKDAYS) return "Weekdays";
    if (mask === WEEKEND) return "Weekends";
    if (mask === 0) return "No days";
    return weekOrder
        .filter((day) => runsOnDay(mask, day))
        .map((day) => DAY_SHORT_NAMES[day])
        .join(", ");
}

/** A minute of the day as `HH:MM` - what an `<input type="time">` reads and
 *  writes, and a form every clock preference renders the same. */
export function clockTime(minute: number): string {
    const safe = ((Math.trunc(minute) % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
    return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/** The inverse, for what that input hands back. Null for anything that is not a
 *  reading, which is how an emptied field stays unsaved rather than becoming
 *  midnight. */
export function clockMinute(value: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
}

/** How long a window stays open, in minutes. An end at or before the start is
 *  one that crosses midnight rather than one that lasts no time. */
export function windowLength(startMinute: number, endMinute: number): number {
    return endMinute > startMinute
        ? endMinute - startMinute
        : endMinute + MINUTES_IN_DAY - startMinute;
}

/** One window, as everything outside the database reads it. */
export interface PresenceScheduleRule {
    readonly id: string;
    readonly presence: ScheduledPresence;
    readonly days: number;
    readonly startMinute: number;
    readonly endMinute: number;
    /** Off keeps the window without applying it, which is what somebody wants
     *  the week they are on holiday and not what "delete" means. */
    readonly enabled: boolean;
}

/** What a window is worth in one line: "Invisible, 00:00 to 09:00, every day". */
export function describeSchedule(
    rule: Pick<PresenceScheduleRule, "presence" | "days" | "startMinute" | "endMinute">,
    weekOrder: readonly number[]
): string {
    return [
        PRESENCE_LABELS[rule.presence],
        `${clockTime(rule.startMinute)} to ${clockTime(rule.endMinute)}`,
        nameDays(rule.days, weekOrder)
    ].join(" - ");
}

export const presenceScheduleSchema = z
    .object({
        presence: z.enum(SCHEDULED_PRESENCES),
        days: z
            .number()
            .int()
            .min(1, "Pick at least one day")
            .max(EVERY_DAY, "That is not a set of days"),
        startMinute: z
            .number()
            .int()
            .min(0)
            .max(MINUTES_IN_DAY - 1),
        endMinute: z
            .number()
            .int()
            .min(0)
            .max(MINUTES_IN_DAY - 1),
        enabled: z.boolean()
    })
    // On the object rather than on either field, because it is a fact about the
    // pair: equal ends are the one shape that cannot be read, since it is both
    // no time at all and the whole day and there is nothing to pick between them.
    .refine((rule) => rule.startMinute !== rule.endMinute, {
        message: "Give it a start and an end that differ",
        path: ["endMinute"]
    });

export type PresenceScheduleInput = z.infer<typeof presenceScheduleSchema>;

/** A window that is open right now, and the two moments that bound it. */
export interface OpenWindow {
    readonly rule: PresenceScheduleRule;
    /** When it opened. What a choice made by hand is compared against, which is
     *  what lets somebody overrule the window they are inside. */
    readonly openedAt: Date;
    /** And when it closes, which is what the picker shows as "until". */
    readonly closesAt: Date;
}

/**
 * Which window, if any, is open at this moment.
 *
 * Both the day this moment falls on and the day before it are considered, and
 * the second is not an edge case: a window that crosses midnight is open at one
 * in the morning because of a rule that names *yesterday*.
 *
 * Where two overlap the one that opened most recently wins. Somebody with "away
 * all Friday" and "do not disturb from four" on the same afternoon meant the
 * narrower thing they wrote second, and any other tie-break would have to be
 * explained on the screen.
 */
export function openWindow(
    rules: readonly PresenceScheduleRule[],
    timeZone: string,
    now: Date
): OpenWindow | null {
    let best: OpenWindow | null = null;
    for (const rule of rules) {
        if (!rule.enabled) continue;
        for (const startedDaysAgo of [0, 1]) {
            const window = windowAround(rule, timeZone, now, startedDaysAgo);
            if (!window) continue;
            if (now < window.openedAt || now >= window.closesAt) continue;
            if (!best || window.openedAt > best.openedAt) best = window;
        }
    }
    return best;
}

/** The window one rule opens on the day `startedDaysAgo` back from this moment,
 *  or null when it does not run that day. */
function windowAround(
    rule: PresenceScheduleRule,
    timeZone: string,
    now: Date,
    startedDaysAgo: number
): OpenWindow | null {
    const wall = wallClock(now, timeZone);
    // Calendar arithmetic on a UTC date, which is only ever a carrier for the
    // three numbers: building it in the zone would be circular, and a UTC date
    // rolls a month end over for free.
    const opensOn = new Date(Date.UTC(wall.year, wall.month - 1, wall.day - startedDaysAgo));
    if (!runsOnDay(rule.days, opensOn.getUTCDay())) return null;

    const openedAt = zonedInstant(readingOf(opensOn, rule.startMinute), timeZone);
    // The end is read as a wall clock too rather than as a length added to the
    // opening. On the night the clocks move those are different answers, and the
    // one somebody meant when they typed 07:00 is seven in the morning.
    const closesOn = new Date(opensOn);
    if (rule.endMinute <= rule.startMinute) closesOn.setUTCDate(closesOn.getUTCDate() + 1);
    const closesAt = zonedInstant(readingOf(closesOn, rule.endMinute), timeZone);
    return { rule, openedAt, closesAt };
}

function readingOf(date: Date, minute: number) {
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        hours: Math.floor(minute / 60),
        minutes: minute % 60
    };
}

/** What an account's presence actually is, once both halves have had their say. */
export interface PresenceInForce {
    readonly choice: PresenceChoice;
    /** When it stops applying, or null for "until I change it". */
    readonly until: Date | null;
    /** Whether a window decided it rather than the person. The picker says so,
     *  because a tick beside something nobody remembers choosing is the thing
     *  that makes people distrust the whole feature. */
    readonly scheduled: boolean;
}

/**
 * What this account appears as right now: what they chose, what their week says,
 * and which of the two wins.
 *
 * **A window takes over the moment it opens, and anything chosen inside it is
 * theirs until it closes.** That one sentence is the whole rule, and it is the
 * only one that behaves the way people expect at both ends. Setting do not
 * disturb at four in the afternoon does not disable tonight's window; setting
 * yourself online at one in the morning, inside the window that is hiding you,
 * takes - because you plainly meant that minute and not the rule you wrote in
 * March. When the window closes, whatever was chosen before it opened is back,
 * because it was never cleared.
 *
 * Which is why the moment of the choice is stored. Comparing the *value* instead
 * would make "online" impossible to choose inside a window that sets `auto`
 * aside, and comparing nothing at all would make one of the two settings a lie
 * for as long as the other one stood.
 */
export function presenceInForce(
    account: {
        readonly presence: string;
        readonly presenceUntil: Date | null;
        readonly presenceSetAt: Date | null;
    },
    rules: readonly PresenceScheduleRule[],
    timeZone: string,
    now: Date = new Date()
): PresenceInForce {
    const chosen = chosenPresence(account, now);
    const open = openWindow(rules, timeZone, now);
    if (open && !(account.presenceSetAt && account.presenceSetAt >= open.openedAt)) {
        return { choice: open.rule.presence, until: open.closesAt, scheduled: true };
    }
    return {
        choice: chosen,
        until: chosen === "auto" ? null : account.presenceUntil,
        scheduled: false
    };
}

/** What the stored choice is worth on its own. A window that has passed is not a
 *  choice: the account is back on `auto`, whatever the column still says. */
function chosenPresence(
    account: { readonly presence: string; readonly presenceUntil: Date | null },
    now: Date
): PresenceChoice {
    if (!(PRESENCE_CHOICES as readonly string[]).includes(account.presence)) return "auto";
    if (account.presenceUntil && account.presenceUntil.getTime() <= now.getTime()) return "auto";
    return account.presence as PresenceChoice;
}

/**
 * Whether a schedule can be trusted to run on this account's own clock.
 *
 * "Automatic" means the device's, and there is no device on the server that
 * resolves these - so a window written by somebody who never picked a zone runs
 * on whatever the deployment's clock says. Worth saying on the screen rather
 * than worth refusing over: for the many installs where those are the same zone
 * it works exactly as written.
 */
export function scheduleZoneIsAssumed(timeZone: string): boolean {
    return timeZone === AUTOMATIC_TIME_ZONE;
}

/** How far ahead an opening is looked for. Every rule repeats weekly, so a week
 *  and a day finds one wherever this moment falls in the week. */
const LOOKAHEAD_DAYS = 8;

/**
 * The next moment this account's presence changes on its own, or null when
 * nothing is due.
 *
 * The counterpart to `presenceInForce` for anything holding that answer rather
 * than recomputing it: a screen resolved once on the server has no way to know a
 * window is about to open, and the two edges are not symmetric - a lapse can be
 * seen coming in the answer itself, an opening cannot. Both are one moment here,
 * worked out on the clock the account's rules are read against, so a browser in
 * another zone is told when to ask again rather than left to guess.
 */
export function nextPresenceChange(
    account: {
        readonly presence: string;
        readonly presenceUntil: Date | null;
        readonly presenceSetAt: Date | null;
    },
    rules: readonly PresenceScheduleRule[],
    timeZone: string,
    now: Date = new Date()
): Date | null {
    const held = presenceInForce(account, rules, timeZone, now);
    let soonest = held.until && held.until > now ? held.until : null;
    for (const rule of rules) {
        if (!rule.enabled) continue;
        for (let ahead = 0; ahead < LOOKAHEAD_DAYS; ahead++) {
            const window = windowAround(rule, timeZone, now, -ahead);
            if (!window || window.openedAt <= now) continue;
            if (!soonest || window.openedAt < soonest) soonest = window.openedAt;
            break;
        }
    }
    return soonest;
}
