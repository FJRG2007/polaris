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
import { addressRuleFields } from "./schemas/link-rules.js";
import {
    EVERY_DAY,
    MINUTES_IN_DAY,
    clockMinute,
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
    "office.document",
    "place.device",
    "place.camera",
    "place.ups",
    "place.nas",
    "place.server",
    "place.domain",
    "place.room",
    "watch.connectivity",
    "watch.alarm",
    "status.page",
    "calendar.calendar"
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
 * Who a grant on a subject may be to, where that is not everybody. A subject
 * whose app already keeps people and teams in a table of its own takes only
 * what that table cannot hold, so the same person is never handed one thing
 * twice in two places.
 */
export const GRANT_SUBJECT_PRINCIPALS: Partial<Record<GrantSubject, readonly GrantPrincipal[]>> = {
    "calendar.calendar": ["role"]
};

/** The principals a grant on this subject may be to. */
export function subjectPrincipals(subject: GrantSubject): readonly GrantPrincipal[] {
    return GRANT_SUBJECT_PRINCIPALS[subject] ?? GRANT_PRINCIPALS;
}

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
    // A document's own three, and the middle one earns its place: commenting
    // without editing is how a draft gets read by the people it is for, and
    // collapsing it into "edit" makes everybody either a spectator or a risk.
    "office.document": ["viewer", "commenter", "editor"],
    // A lock, an opener, a switch. Seeing that a door is shut and opening it are
    // genuinely different things to be given, which is the whole of what
    // somebody sharing a door with a visitor is deciding.
    "place.device": ["view", "control"],
    // Watching is all there is to give: nothing here points a camera or wipes
    // its footage on somebody else's behalf.
    "place.camera": ["view"],
    // A UPS: reading its status and history, or also sending it commands,
    // writing its variables and running its self-test. The same split NUT
    // itself draws - Home Assistant's NUT integration reads with no login and
    // offers commands only to a NUT user with instant-command rights
    // (https://www.home-assistant.io/integrations/nut).
    "place.ups": ["view", "control"],
    // A NAS: its status, storage and history, or also its fan profile and
    // running its backup tasks. Its connection, shares and settings stay with
    // whoever connected it.
    "place.nas": ["view", "control"],
    // A server or a domain, as a device in Places: its load, its answers and
    // its alarm history. Watching only - its shell, files, containers and
    // settings stay with whoever owns it.
    "place.server": ["view"],
    "place.domain": ["view"],
    // A room: every door, switch and camera in it, as one key. What a hotel
    // hands a guest at check-in and an office hands a team - the room-level
    // key Salto and Kisi issue rather than one credential per lock
    // (https://saltosystems.com/en/solutions/hospitality/,
    // https://docs.getkisi.com/docs/groups). Devices put in the room later are
    // covered; ones taken out are not.
    "place.room": ["view", "control"],
    // This deployment's connectivity record: its state, its outages and their
    // history. Reading is all there is - checking now and the merge window stay
    // with the administrators the internet alert goes to.
    "watch.connectivity": ["view"],
    // One alarm: its rule, its state and whether it is firing. Changing,
    // pausing and deleting it stay with whoever made it.
    "watch.alarm": ["view"],
    // One status page: its components, checks, incidents and maintenance, and
    // its title and address. Deleting it and its custom domain stay with the
    // people who run status pages.
    "status.page": ["edit"],
    // A calendar, handed to an organization's role: seeing every detail, or
    // also changing its events. People and teams keep their own table
    // (CalendarShare, with its four levels); a grant here is only ever a role.
    "calendar.calendar": ["view", "edit"]
} as const satisfies Record<GrantSubject, readonly string[]>;

export type GrantCapability = (typeof GRANT_CAPABILITIES)[GrantSubject][number];

/**
 * What a grant may be used FOR, per subject - the cut inside a capability.
 *
 * `control` over a door says the visitor may operate it; this says which way.
 * Lock brands sell exactly this (a key that only opens, a code that only
 * works some hours), and Home Assistant has no per-entity sharing at all - its
 * users are administrators or not, and a hidden card is not a refused call
 * (https://github.com/orgs/home-assistant/discussions/1171,
 * https://developers.home-assistant.io/docs/auth_permissions) - so the
 * vocabulary is ours:
 *
 * - a device: `open` (unlock, unlatch), `close` (lock) and `operate`
 *   (everything a switch, a light or an air conditioner does);
 * - a camera: `watch`;
 * - a UPS: `watch` (status, history) and `control` (commands, variables, test);
 * - a NAS: `watch` (status, storage, history), `fan` (its fan profile) and
 *   `backup` (running one of its backup tasks);
 * - a server or a domain: `watch` (load, answers, alarm history).
 *
 * `watch` is what `view` reaches; every other action needs `control`.
 */
export const GRANT_ACTIONS = {
    "chat.space": [],
    "chat.channel": [],
    "task.space": [],
    "task.folder": [],
    "note.space": [],
    "office.document": [],
    "place.device": ["open", "close", "operate"],
    "place.camera": ["watch"],
    "place.ups": ["watch", "control"],
    "place.nas": ["watch", "fan", "backup"],
    "place.server": ["watch"],
    "place.domain": ["watch"],
    "place.room": ["watch", "open", "close", "operate"],
    "watch.connectivity": [],
    "watch.alarm": [],
    "status.page": [],
    "calendar.calendar": []
} as const satisfies Record<GrantSubject, readonly string[]>;

/**
 * The actions one grant really allows.
 *
 * An empty list is a row written before grants named their actions (or by a
 * dashboard that had not been updated yet) and means everything the capability
 * reaches - which is what it allowed when it was written. A listed action the
 * capability does not reach is dropped rather than honoured: a `view` grant
 * that somehow says `open` still opens nothing.
 */
export function grantActions(
    subject: GrantSubject,
    capability: string,
    actions: readonly string[]
): string[] {
    const all = GRANT_ACTIONS[subject] as readonly string[];
    const ladder = GRANT_CAPABILITIES[subject] as readonly string[];
    const controls = ladder.includes("control") && atLeast(subject, capability, "control");
    const reachable = all.filter((action) => action === "watch" || controls);
    return actions.length === 0
        ? reachable
        : reachable.filter((action) => actions.includes(action));
}

/** Whether one grant allows one action. */
export function allowsAction(
    subject: GrantSubject,
    capability: string,
    actions: readonly string[],
    wanted: string
): boolean {
    return grantActions(subject, capability, actions).includes(wanted);
}

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
    | "spent"
    /** A link only: in force, but not for the address or region asking. */
    | "elsewhere";

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
    spent: "Used up",
    elsewhere: "Not from here"
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
 * A day at a wall-clock time in the reader's own zone: a hotel's check-in at
 * 15:00 and check-out at 11:00, the way a PMS hands a key its stay
 * (https://www.mews.com/en/blog/keyless-entry-hotels). Null for a day or a
 * time that does not read.
 */
export function dayAt(day: string, clock: string): Date | null {
    const begins = dayBegins(day);
    const minute = clockMinute(clock);
    if (!begins || minute === null) return null;
    begins.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    return begins;
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

/** The narrowest and widest "only near the place" fence a grant may draw. A
 *  browser's fix is rarely better than tens of metres, and past a few
 *  kilometres it is not "near" any more. */
export const NEARBY_MIN_M = 25;
export const NEARBY_MAX_M = 5000;

/**
 * What a screen sends to make or replace one.
 *
 * The subject is never in here: it comes from the route being called, so a
 * request cannot name a thing the caller was not already resolved against.
 */
const grantBounds = z.object({
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
    // Which of the subject's actions it allows (GRANT_ACTIONS); empty is all
    // of them. Checked against the subject where the subject is known.
    actions: z.array(z.string().trim().min(1).max(32)).max(8).default([]),
    // Only near the place: the act is allowed when the browser says it is
    // within this many metres of where the subject stands. A convenience
    // fence, not a lock - a browser's location can be made up.
    nearbyMeters: z.number().int().min(NEARBY_MIN_M).max(NEARBY_MAX_M).nullable().default(null),
    note: z.string().trim().max(200).default("")
});

/** The facts about how a grant's bounds go together, for either kind of grant. */
function withGrantRules<T extends typeof grantBounds>(
    schema: T
): z.ZodEffects<z.ZodEffects<z.ZodEffects<T>>> {
    // Typed from T because `refine` reads its output from the constraint, which
    // would drop whatever the caller extended the bounds with.
    return (
        schema
            // On the object because they are facts about the pair. Half an hour window
            // is not a window, and equal ends cannot be read - it is both no time at all
            // and the whole day, and there is nothing to pick between them.
            .refine((grant) => (grant.startMinute === null) === (grant.endMinute === null), {
                message: "Give the hours a start and an end, or neither",
                path: ["endMinute"]
            })
            .refine(
                (grant) => grant.startMinute === null || grant.startMinute !== grant.endMinute,
                {
                    message: "Give it a start and an end that differ",
                    path: ["endMinute"]
                }
            )
            .refine(
                (grant) =>
                    !grant.startsAt ||
                    !grant.endsAt ||
                    new Date(grant.startsAt) < new Date(grant.endsAt),
                { message: "The last day is before the first", path: ["endsAt"] }
            ) as z.ZodEffects<z.ZodEffects<z.ZodEffects<T>>>
    );
}

export const accessGrantSchema = withGrantRules(
    grantBounds.extend({
        principalType: z.enum(GRANT_PRINCIPALS),
        principalId: z.string().trim().min(1).max(64)
    })
);

export type AccessGrantInput = z.infer<typeof accessGrantSchema>;

/**
 * A grant handed out as a link, for somebody with no Polaris account: the same
 * bounds, nobody named. Whoever holds the link holds the grant, so what a link
 * may do is narrower than what a person may (`linkCapabilities`).
 */
export const grantLinkSchema = withGrantRules(grantBounds.extend(addressRuleFields));

export type GrantLinkInput = z.infer<typeof grantLinkSchema>;

/**
 * What may be handed out as a link: everything in Places, and the
 * connectivity record in Watch. A door and a UPS may be driven through one; a
 * camera is only watched (no PTZ, no recordings); the rest only seen - see
 * `LINK_WATCH_ONLY_SUBJECTS`.
 */
export const GRANT_LINK_SUBJECTS = [
    "place.device",
    "place.camera",
    "place.ups",
    "place.nas",
    "place.server",
    "place.domain",
    "place.room",
    "watch.connectivity"
] as const satisfies readonly GrantSubject[];

export type GrantLinkSubject = (typeof GRANT_LINK_SUBJECTS)[number];

export function isGrantLinkSubject(value: unknown): value is GrantLinkSubject {
    return (GRANT_LINK_SUBJECTS as readonly unknown[]).includes(value);
}

/**
 * Subjects a link only ever shows. A NAS's fan and backups, and anything a
 * server or a domain could ever be given control of, need an account at the
 * other end: a link cannot be attributed to anybody, and those reach machines
 * other people depend on.
 */
export const LINK_WATCH_ONLY_SUBJECTS = [
    "place.nas",
    "place.server",
    "place.domain",
    "watch.connectivity"
] as const satisfies readonly GrantLinkSubject[];

/**
 * The one connectivity record a deployment keeps, as a grant's subject id.
 * There is nothing to choose between, so the id is a constant rather than a
 * row: a grant over it reads the whole record.
 */
export const WATCH_CONNECTIVITY_ID = "deployment";

/** The capabilities a link to this subject may carry, weakest first. */
export function linkCapabilities(subject: GrantLinkSubject): readonly string[] {
    const ladder = GRANT_CAPABILITIES[subject] as readonly string[];
    return (LINK_WATCH_ONLY_SUBJECTS as readonly string[]).includes(subject)
        ? ladder.slice(0, 1)
        : ladder;
}

/** The principal a link grant is written under; its id is the link's hash. */
export const LINK_PRINCIPAL = "link";

/** Where the browser says it is, at the moment of an act. */
export interface ReportedLocation {
    readonly latitude: number;
    readonly longitude: number;
    /** The browser's own radius of uncertainty, in metres. */
    readonly accuracy: number;
}

/**
 * Where this browser says it is, asked once for an act fenced to its place.
 *
 * Only ever asked when a press needs it - the server answers "near the place
 * only" first - so nobody is asked for their location to look at a door. Null
 * when there is no browser location, the person said no, or it took too long:
 * the server's refusal then stands, in its own words. Safe to import on a
 * server; it answers null there.
 */
export function whereNow(timeoutMs = 10_000): Promise<ReportedLocation | null> {
    // Typed here rather than from the DOM library, which this package does not
    // compile against: the one call it makes.
    const geolocation = (
        globalThis as {
            navigator?: {
                geolocation?: {
                    getCurrentPosition(
                        found: (position: { coords: ReportedLocation }) => void,
                        failed: () => void,
                        options: {
                            enableHighAccuracy: boolean;
                            timeout: number;
                            maximumAge: number;
                        }
                    ): void;
                };
            };
        }
    ).navigator?.geolocation;
    if (!geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
        geolocation.getCurrentPosition(
            (position) =>
                resolve({
                    latitude: position.coords.latitude,
                    longitude: position.coords.longitude,
                    accuracy: position.coords.accuracy
                }),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 }
        );
    });
}

export const reportedLocationSchema = z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().min(0).max(100_000)
});

/** Metres between two points on the Earth (haversine, mean radius). */
export function metresBetween(
    a: { latitude: number; longitude: number },
    b: { latitude: number; longitude: number }
): number {
    const R = 6_371_008.8;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = rad(b.latitude - a.latitude);
    const dLon = rad(b.longitude - a.longitude);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether an act is near enough, for a grant fenced to `meters` around a place.
 *
 * - `near`: the browser's point is inside the fence;
 * - `far`: it is outside;
 * - `vague`: the browser's own uncertainty is wider than the fence, so it says
 *   nothing either way - refused rather than given the benefit of the doubt;
 * - `unasked`: no location came with the act (the screen asks and tries again);
 * - `unplaced`: the place has no coordinates to measure from - refused, since
 *   a fence nobody can check is not one.
 */
export type NearbyVerdict = "near" | "far" | "vague" | "unasked" | "unplaced";

export function nearbyVerdict(
    place: { latitude: number | null; longitude: number | null } | null,
    where: ReportedLocation | null,
    meters: number
): NearbyVerdict {
    if (!place || place.latitude === null || place.longitude === null) return "unplaced";
    if (!where) return "unasked";
    if (where.accuracy > meters) return "vague";
    const distance = metresBetween({ latitude: place.latitude, longitude: place.longitude }, where);
    return distance <= meters ? "near" : "far";
}
