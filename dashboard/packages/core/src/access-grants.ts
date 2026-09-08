/**
 * Handing one thing to somebody who is not on its roster.
 *
 * Polaris already knows how to say "these people own this" - a space has
 * members, a Place answers to an instance permission. What it had no way to say
 * was any of this:
 *
 * - the security team gets the camera in the yard, and nothing else here;
 * - everybody holding the `support` role in this organization sees this
 *   conversation, without anybody adding them to it one at a time;
 * - the cleaner can open the front door on Tuesdays between nine and eleven,
 *   until the end of March, four more times.
 *
 * They are the same sentence with different nouns, which is why they are one
 * table and one evaluation rather than six. A grant names **what** is being
 * reached, **who** reaches it, **what they may do** there, and **when** - and
 * every part of the "when" is optional, because most grants have none of it.
 *
 * Two things this is not. It is not a share link - there is an account at the
 * other end of every one of these, so a grant can be revoked, counted and
 * attributed to a person. And it is not a permission.
 *
 * **How this differs from `ResourceGrant`, which is the other grant table.**
 * That one scopes a *permission* to a *thing*: it hands somebody `tasks.manage`
 * over one space, in the vocabulary of the instance's own permission system, and
 * it is answered inside `can`. This one hands over *the thing itself*, in the
 * thing's own vocabulary, and is answered beside the roster rather than inside
 * the permission engine. The split is not tidiness:
 *
 * - Chat's whole rule is that no permission reaches a conversation - there is no
 *   administrator override and no instance-wide read - so routing a conversation
 *   through the permission engine would put one there, since an administrator
 *   short-circuits every check it makes.
 * - A principal here is a person, an organization's **team**, or an
 *   organization's **role**. Those are not the instance's groups and roles, and
 *   they are the ones somebody running an organization actually has.
 * - And the hours. A weekly window and a number of uses belong to a door being
 *   lent to a visitor; putting them on the path every permission check in
 *   Polaris runs through would be paying for them everywhere to use them in one
 *   place.
 *
 * Neither replaces the other, and a subject may honestly have both: a task space
 * reached by a scoped permission and by a grant to a team is reached, and the
 * stronger answer wins.
 *
 * The arithmetic of "Tuesdays nine to eleven" is `weeklyWindow`, shared with
 * standing hours: a window that crosses midnight, and the night the clocks move,
 * are both easy to get wrong and are got right in one place.
 */

import { z } from "zod";
import {
    EVERY_DAY,
    MINUTES_IN_DAY,
    clockTime,
    nameDays,
    weeklyWindow
} from "./schemas/presence-schedule.js";

/**
 * What a grant can be about.
 *
 * Written as `<app>.<thing>` so a reader of one row knows which module owns it
 * without a lookup, and so a new one is a line here rather than a table.
 */
export const GRANT_SUBJECTS = [
    "chat.space",
    "chat.channel",
    "task.space",
    "task.folder",
    "note.space",
    "place.device",
    "place.camera"
] as const;

export type GrantSubject = (typeof GRANT_SUBJECTS)[number];

export function isGrantSubject(value: unknown): value is GrantSubject {
    return (GRANT_SUBJECTS as readonly unknown[]).includes(value);
}

/**
 * Who a grant is to.
 *
 * A person, or one of the two ways an organization already groups people. Teams
 * and roles are deliberately both offered rather than one being modelled in
 * terms of the other: a team is who you work with and a role is what you are
 * trusted with, organizations use them for different things, and the grant that
 * says "whoever is on security" should not have to be rewritten when somebody
 * joins.
 */
export const GRANT_PRINCIPALS = ["user", "team", "role"] as const;

export type GrantPrincipal = (typeof GRANT_PRINCIPALS)[number];

/**
 * What a grant may hand over, per subject, weakest first.
 *
 * Each subject keeps its own vocabulary rather than being forced into a shared
 * ladder, because the words mean different things and a screen has to say them:
 * `member` in a conversation and `control` over a lock are not two rungs of one
 * scale. Order is what `atLeast` reads, so a stronger capability answers for a
 * weaker one and nothing downstream has to enumerate them.
 */
export const GRANT_CAPABILITIES = {
    "chat.space": ["member", "admin"],
    "chat.channel": ["member", "admin"],
    "task.space": ["guest", "member", "admin"],
    "task.folder": ["guest", "member", "admin"],
    "note.space": ["guest", "member", "admin"],
    // A lock, an opener, a switch. Seeing that a door is shut and opening it are
    // genuinely different things to be given, which is the whole of what
    // somebody sharing a door with a visitor is deciding.
    "place.device": ["view", "control"],
    // Watching is all there is to give: nothing here points a camera or wipes
    // its footage on somebody else's behalf.
    "place.camera": ["view"]
} as const satisfies Record<GrantSubject, readonly string[]>;

export type GrantCapability = (typeof GRANT_CAPABILITIES)[GrantSubject][number];

/** Whether `held` is `wanted` or stronger, in that subject's own ladder. An
 *  unknown word is weaker than everything, which is the safe way to be wrong. */
export function atLeast(subject: GrantSubject, held: string, wanted: string): boolean {
    const ladder = GRANT_CAPABILITIES[subject] as readonly string[];
    const have = ladder.indexOf(held);
    const need = ladder.indexOf(wanted);
    return have >= 0 && need >= 0 && have >= need;
}

/** The strongest of a handful, or "" when there are none. */
export function strongest(subject: GrantSubject, held: readonly string[]): string {
    const ladder = GRANT_CAPABILITIES[subject] as readonly string[];
    let best = "";
    for (const one of held) {
        if (ladder.indexOf(one) > ladder.indexOf(best)) best = one;
    }
    return best;
}

/**
 * When a grant applies, as it is stored.
 *
 * Every bound is optional and absent means unbounded, so the ordinary grant -
 * "the security team gets this camera" - carries none of them and reads as
 * plainly as it should. The three are independent: a date range, a part of the
 * week, and a number of uses.
 */
export interface GrantSchedule {
    /** Not before this moment. */
    readonly startsAt: Date | null;
    /** Not after it. */
    readonly endsAt: Date | null;
    /** Days of the week it opens on, as the presence-schedule bitmask. Every day
     *  unless somebody narrowed it. */
    readonly days: number;
    /** Minutes past midnight, in `timeZone`. Both null is "at any hour"; a end
     *  at or before the start crosses midnight, which is what a night shift is. */
    readonly startMinute: number | null;
    readonly endMinute: number | null;
    /** Whose midnight. Empty means the instance's own, resolved by the caller -
     *  a wall-clock rule has to be somebody's wall. */
    readonly timeZone: string;
    /** How many times it may be spent, or null for as often as they like. */
    readonly maxUses: number | null;
    readonly uses: number;
}

/** Why a grant is not in force, or that it is. */
export type GrantStanding =
    /** In force this instant. */
    | "live"
    /** Its first day has not come. */
    | "waiting"
    /** Its last day has gone. */
    | "expired"
    /** Right day, wrong hour. */
    | "closed"
    /** Every use it had is spent. */
    | "spent";

/** A grant, judged. `until` is when the open window shuts, for a screen that
 *  wants to say how long is left rather than that it is fine. */
export interface GrantVerdict {
    readonly standing: GrantStanding;
    readonly until: Date | null;
}

/**
 * Whether a grant applies right now.
 *
 * The order the answers are tried in is the order somebody would want to be
 * told: a grant that has run out of uses says so even during its hours, and one
 * whose dates have passed says that rather than complaining about the hour.
 */
export function judgeGrant(schedule: GrantSchedule, now: Date, fallbackZone = "UTC"): GrantVerdict {
    if (schedule.maxUses !== null && schedule.uses >= schedule.maxUses) {
        return { standing: "spent", until: null };
    }
    if (schedule.startsAt && now < schedule.startsAt) {
        return { standing: "waiting", until: null };
    }
    if (schedule.endsAt && now > schedule.endsAt) {
        return { standing: "expired", until: null };
    }

    // No hour bound and every day: in force for as long as the dates say.
    if (schedule.startMinute === null || schedule.endMinute === null) {
        return schedule.days === EVERY_DAY
            ? { standing: "live", until: schedule.endsAt }
            : judgeDays(schedule, now, fallbackZone);
    }
    return judgeWindow(schedule, now, fallbackZone);
}

/** Days named but no hours: the window is the whole of each of those days. */
function judgeDays(schedule: GrantSchedule, now: Date, fallbackZone: string): GrantVerdict {
    return judgeWindow(
        { ...schedule, startMinute: 0, endMinute: MINUTES_IN_DAY - 1 },
        now,
        fallbackZone
    );
}

function judgeWindow(schedule: GrantSchedule, now: Date, fallbackZone: string): GrantVerdict {
    const zone = schedule.timeZone || fallbackZone;
    const rule = {
        days: schedule.days,
        startMinute: schedule.startMinute ?? 0,
        endMinute: schedule.endMinute ?? MINUTES_IN_DAY - 1
    };
    // Yesterday as well as today, and that is not an edge case: a window written
    // as 23:00 to 07:00 is open at one in the morning because of the day before.
    for (const startedDaysAgo of [0, 1]) {
        const window = weeklyWindow(rule, zone, now, startedDaysAgo);
        if (!window) continue;
        if (now < window.openedAt || now >= window.closesAt) continue;
        // Whichever comes first: the hours shutting, or the last day passing.
        const until =
            schedule.endsAt && schedule.endsAt < window.closesAt
                ? schedule.endsAt
                : window.closesAt;
        return { standing: "live", until };
    }
    return { standing: "closed", until: null };
}

/** Whether a grant is in force, for the many callers that only want the yes. */
export function grantIsLive(schedule: GrantSchedule, now: Date, fallbackZone = "UTC"): boolean {
    return judgeGrant(schedule, now, fallbackZone).standing === "live";
}

/** What each standing is called on screen, for the badge beside a grant. */
export const GRANT_STANDING_LABELS: Record<GrantStanding, string> = {
    live: "In force",
    waiting: "Not started",
    expired: "Expired",
    closed: "Outside its hours",
    spent: "Used up"
};

/**
 * The bounds in one line: "Tue, Thu, 09:00 to 11:00, 4 of 10 uses".
 *
 * Empty for a grant with no bounds at all, so a caller can print it or not
 * without asking - an unbounded grant should read as plainly as it behaves, and
 * "always, every day, unlimited" is three words saying nothing.
 */
export function describeGrant(
    schedule: GrantSchedule,
    weekOrder: readonly number[],
    formatDate: (date: Date) => string
): string {
    const parts: string[] = [];
    if (schedule.startsAt && schedule.endsAt) {
        parts.push(`${formatDate(schedule.startsAt)} to ${formatDate(schedule.endsAt)}`);
    } else if (schedule.startsAt) {
        parts.push(`from ${formatDate(schedule.startsAt)}`);
    } else if (schedule.endsAt) {
        parts.push(`until ${formatDate(schedule.endsAt)}`);
    }
    if (schedule.days !== EVERY_DAY) parts.push(nameDays(schedule.days, weekOrder));
    if (schedule.startMinute !== null && schedule.endMinute !== null) {
        parts.push(`${clockTime(schedule.startMinute)} to ${clockTime(schedule.endMinute)}`);
    }
    if (schedule.maxUses !== null) {
        parts.push(`${schedule.uses} of ${schedule.maxUses} uses`);
    }
    return parts.join(" - ");
}

/** Whether a grant is bounded at all, which is what decides whether a row shows
 *  a second line. */
export function grantIsBounded(schedule: GrantSchedule): boolean {
    return (
        schedule.startsAt !== null ||
        schedule.endsAt !== null ||
        schedule.days !== EVERY_DAY ||
        schedule.startMinute !== null ||
        schedule.maxUses !== null
    );
}

/** The most grants one thing may carry. Far above what anybody writes, and a
 *  ceiling on what a screen has to draw and a check has to walk. */
export const MAX_GRANTS_PER_SUBJECT = 100;

/**
 * The moment a picked day begins, in the reader's own zone.
 *
 * A date field answers with "2026-03-31", and `new Date` reads a bare date as
 * midnight **UTC**. West of it that moment is the evening before, so a grant
 * meant to begin today would already be in force while it was still yesterday.
 * "From this day" has to mean the start of that day where the reader is.
 */
export function dayBegins(day: string): Date | null {
    const parts = day.split("-").map(Number);
    const [year, month, date] = parts;
    if (parts.length !== 3 || !year || !month || !date) return null;
    const at = new Date(year, month - 1, date, 0, 0, 0, 0);
    return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * And the moment it ends, which is the one that matters.
 *
 * `judgeGrant` expires a grant once now is past `endsAt`, so a door lent "until
 * 31 March" against midnight at the start of the 31st stops working a whole day
 * early. The last day is part of what was lent.
 */
export function dayEnds(day: string): Date | null {
    const begins = dayBegins(day);
    if (!begins) return null;
    begins.setHours(23, 59, 59, 999);
    return begins;
}

/**
 * One end of the date range, as a moment that can actually be read.
 *
 * Checked for parseability here rather than left to the write: an unparseable
 * bound becomes an Invalid Date, the database refuses it, and what comes back is
 * the generic "that share could not be written" instead of a sentence naming the
 * field somebody has to fix.
 */
function grantMoment(message: string) {
    return z
        .string()
        .trim()
        .max(40)
        .refine((value) => !Number.isNaN(Date.parse(value)), { message });
}

/**
 * What a screen sends to make or replace one.
 *
 * The subject is never in here: it comes from the route being called, so a
 * request cannot name a thing the caller was not already resolved against.
 */
export const accessGrantSchema = z
    .object({
        principalType: z.enum(GRANT_PRINCIPALS),
        principalId: z.string().trim().min(1).max(64),
        capability: z.string().trim().min(1).max(32),
        startsAt: grantMoment("Give the first day as a date").optional(),
        endsAt: grantMoment("Give the last day as a date").optional(),
        days: z.number().int().min(1).max(EVERY_DAY).default(EVERY_DAY),
        startMinute: z
            .number()
            .int()
            .min(0)
            .max(MINUTES_IN_DAY - 1)
            .nullable()
            .default(null),
        endMinute: z
            .number()
            .int()
            .min(0)
            .max(MINUTES_IN_DAY - 1)
            .nullable()
            .default(null),
        timeZone: z.string().trim().max(64).default(""),
        // Zero would be a grant that is spent before it is written, which is a
        // way of saying "no" that looks like a way of saying "yes".
        maxUses: z.number().int().min(1).max(100_000).nullable().default(null),
        note: z.string().trim().max(200).default("")
    })
    // On the object because they are facts about the pair. Half an hour window
    // is not a window, and equal ends cannot be read - it is both no time at all
    // and the whole day, and there is nothing to pick between them.
    .refine((grant) => (grant.startMinute === null) === (grant.endMinute === null), {
        message: "Give the hours a start and an end, or neither",
        path: ["endMinute"]
    })
    .refine((grant) => grant.startMinute === null || grant.startMinute !== grant.endMinute, {
        message: "Give it a start and an end that differ",
        path: ["endMinute"]
    })
    .refine(
        (grant) =>
            !grant.startsAt || !grant.endsAt || new Date(grant.startsAt) < new Date(grant.endsAt),
        { message: "The last day is before the first", path: ["endsAt"] }
    );

export type AccessGrantInput = z.infer<typeof accessGrantSchema>;
