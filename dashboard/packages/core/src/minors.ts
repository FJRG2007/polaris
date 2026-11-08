/**
 * Minor accounts: the stages a child's account moves through, what each stage
 * may do by default, and the things no guardian can open whatever they set.
 *
 * Everything here is pure so the server, the screens and the daily transition
 * job read one answer. Every operator decision is a single named constant
 * (the stage ages, the consent age, the delay a guardian may ask for), so
 * changing one is one line.
 *
 * Ages are month-precise on purpose: an account stores the birth month and year
 * only (data minimization), and a stage changes on the 1st of the birth month.
 * "Today" is always read as a calendar date in a named time zone, so the answer
 * does not change with the server's clock zone.
 */

import { impliedBy, PERMISSIONS, type Permission } from "./permissions.js";

/** The stages in order, youngest first. An adult has no stage: no row. */
export const MINOR_STAGES = ["baby", "child", "preteen", "teen", "olderTeen"] as const;

export type MinorStage = (typeof MINOR_STAGES)[number];

/** What `stageFor` answers once the account is no longer a minor's. */
export const ADULT = "adult" as const;

export type StageOrAdult = MinorStage | typeof ADULT;

/** The age a stage starts at (D1). Each stage lasts until the next one starts. */
export const STAGE_START_AGE: Readonly<Record<MinorStage, number>> = {
    baby: 0,
    child: 4,
    preteen: 9,
    teen: 13,
    olderTeen: 16
};

/** The age supervision ends at and the account becomes simply its owner's (D1, D6). */
export const MAJORITY_AGE = 18;

/** The age below which consent comes from a guardian (D2, GDPR art. 8). Spain's
 *  14 by default; an instance may set anything in the range member states use. */
export const DEFAULT_DIGITAL_CONSENT_AGE = 14;
export const MIN_DIGITAL_CONSENT_AGE = 13;
export const MAX_DIGITAL_CONSENT_AGE = 16;

/** A birth month further back than this is a typo, not a person. */
export const MAX_AGE_YEARS = 120;

/** How long a guardian may hold back one automatic move (D5), once per stage. */
export const STAGE_DELAY_MAX_DAYS = 90;

/** How far ahead guardians and the minor are told a move is coming. */
export const STAGE_NOTICE_DAYS = 30;

/** A calendar date with no time and no zone. */
export interface CalendarDate {
    readonly year: number;
    readonly month: number;
    readonly day: number;
}

/** A birth month, `YYYY-MM`. */
export interface BirthMonth {
    readonly year: number;
    readonly month: number;
}

const BIRTH_MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Read `YYYY-MM`, or null when it is not one. */
export function parseBirthMonth(value: string): BirthMonth | null {
    const match = BIRTH_MONTH_PATTERN.exec(value);
    if (!match) return null;
    return { year: Number(match[1]), month: Number(match[2]) };
}

/** Read `YYYY-MM-DD`, or null when it is not a real day (February 30 is refused). */
export function parseCalendarDate(value: string): CalendarDate | null {
    const match = DATE_PATTERN.exec(value);
    if (!match) return null;
    const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
    if (check.getUTCMonth() !== date.month - 1) return null;
    return date;
}

/** `YYYY-MM-DD`, zero-padded. */
export function formatCalendarDate(date: CalendarDate): string {
    const pad = (value: number, width: number) => String(value).padStart(width, "0");
    return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

/** The calendar date an instant falls on in a time zone (UTC when none is named). */
export function calendarDateIn(at: Date, timeZone = "UTC"): CalendarDate {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric"
    }).formatToParts(at);
    const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
    return { year: part("year"), month: part("month"), day: part("day") };
}

/** Whole days from one calendar date to another; negative when `to` is earlier. */
export function calendarDaysBetween(from: CalendarDate, to: CalendarDate): number {
    const utc = (date: CalendarDate) => Date.UTC(date.year, date.month - 1, date.day);
    return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** Why a birth month cannot be somebody's, or null when it can. */
export type BirthMonthIssue = "invalid" | "future" | "tooOld";

export function birthMonthIssue(birthMonth: string, today: CalendarDate): BirthMonthIssue | null {
    const birth = parseBirthMonth(birthMonth);
    if (!birth) return "invalid";
    const months = today.year * 12 + today.month - (birth.year * 12 + birth.month);
    if (months < 0) return "future";
    if (Math.floor(months / 12) > MAX_AGE_YEARS) return "tooOld";
    return null;
}

/**
 * Completed years on a day, counting a birthday from the 1st of the birth month.
 * Throws a RangeError for a birth month that `birthMonthIssue` refuses: callers
 * validate it on the way in, so reaching this with one is a bug, not input.
 */
export function ageOn(birthMonth: string, today: CalendarDate): number {
    const issue = birthMonthIssue(birthMonth, today);
    if (issue) throw new RangeError(`Birth month ${birthMonth} is ${issue}`);
    const birth = parseBirthMonth(birthMonth) as BirthMonth;
    const months = today.year * 12 + today.month - (birth.year * 12 + birth.month);
    return Math.floor(months / 12);
}

/** The stage an age falls in, or adult from the majority age on. */
export function stageForAge(age: number): StageOrAdult {
    if (age >= MAJORITY_AGE) return ADULT;
    for (let index = MINOR_STAGES.length - 1; index >= 0; index--) {
        const stage = MINOR_STAGES[index] as MinorStage;
        if (age >= STAGE_START_AGE[stage]) return stage;
    }
    return "baby";
}

/** The stage somebody born in `birthMonth` is in on `today`. */
export function stageFor(birthMonth: string, today: CalendarDate): StageOrAdult {
    return stageForAge(ageOn(birthMonth, today));
}

/** The stage after this one, or adult after the last. */
export function nextMinorStage(stage: MinorStage): StageOrAdult {
    return MINOR_STAGES[MINOR_STAGES.indexOf(stage) + 1] ?? ADULT;
}

/** Whether `a` is a later stage than `b` (adult is later than every stage). */
export function isLaterStage(a: StageOrAdult, b: StageOrAdult): boolean {
    const rank = (stage: StageOrAdult) =>
        stage === ADULT ? MINOR_STAGES.length : MINOR_STAGES.indexOf(stage);
    return rank(a) > rank(b);
}

/** The day somebody born in `birthMonth` reaches an age: the 1st of the birth month. */
export function dayOfAge(birthMonth: string, age: number): CalendarDate {
    const birth = parseBirthMonth(birthMonth);
    if (!birth) throw new RangeError(`Birth month ${birthMonth} is invalid`);
    return { year: birth.year + age, month: birth.month, day: 1 };
}

/** The next automatic move from where the birth month puts somebody on `today`:
 *  which stage, and the day. Null for an adult, who has nothing left to move to. */
export function nextStageChange(
    birthMonth: string,
    today: CalendarDate
): { stage: StageOrAdult; on: CalendarDate } | null {
    const current = stageFor(birthMonth, today);
    if (current === ADULT) return null;
    const stage = nextMinorStage(current);
    const age = stage === ADULT ? MAJORITY_AGE : STAGE_START_AGE[stage];
    return { stage, on: dayOfAge(birthMonth, age) };
}

/** Why a guardian's delay is refused, or null when it may be set. */
export type DelayRefusal = "majority" | "alreadyDelayed" | "notLater" | "tooLong" | "pastMajority";

/**
 * Whether a guardian may hold back a move until `until` (D5): only a move to a
 * stage (majority is never delayed), once per stage, later than the day it is
 * due, at most `STAGE_DELAY_MAX_DAYS` after it, and never onto or past the
 * majority day.
 */
export function delayRefusal(input: {
    readonly to: StageOrAdult;
    readonly dueOn: CalendarDate;
    readonly until: CalendarDate;
    readonly alreadyDelayed: boolean;
    readonly birthMonth: string;
}): DelayRefusal | null {
    if (input.to === ADULT) return "majority";
    if (input.alreadyDelayed) return "alreadyDelayed";
    const days = calendarDaysBetween(input.dueOn, input.until);
    if (days <= 0) return "notLater";
    if (days > STAGE_DELAY_MAX_DAYS) return "tooLong";
    if (calendarDaysBetween(input.until, dayOfAge(input.birthMonth, MAJORITY_AGE)) <= 0)
        return "pastMajority";
    return null;
}

/** Things a minor's account is limited on that are not permissions. */
export const MINOR_FEATURES = [
    "app:polar",
    "feature:polarMemories",
    "feature:publicLinks",
    "feature:thirdParty",
    "feature:vpnTor",
    "feature:ageRestricted",
    "feature:purchases"
] as const;

export type MinorFeature = (typeof MINOR_FEATURES)[number];

/** Every key a stage preset, a guardian override or the floor speaks about. */
export type MinorCapability = Permission | MinorFeature;

export const MINOR_CAPABILITIES: readonly MinorCapability[] = [...PERMISSIONS, ...MINOR_FEATURES];

/**
 * The rules no guardian can loosen, at any stage. Administration of the
 * instance, of other people's things and of other minors; purchases; the Tor
 * exit; age-restricted channels.
 */
export const MINOR_FLOOR = [
    "connections.manage",
    "shares.manage",
    "requests.manage",
    "mailserver.manage",
    "automations.secrets",
    "status.manage",
    "home.manage",
    "inbox.read",
    "inbox.manage",
    "users.manage",
    "settings.manage",
    "system.manage",
    "family.manage",
    // Billed to the deployment's administrator, the same as a purchase.
    "polar.spend",
    "feature:vpnTor",
    "feature:ageRestricted",
    "feature:purchases"
] as const satisfies readonly MinorCapability[];

export type MinorFloorCapability = (typeof MINOR_FLOOR)[number];

export type PresetCapability = Exclude<MinorCapability, MinorFloorCapability>;

/**
 * What a stage gives by default:
 * - `off`: not at this stage. A guardian cannot open it; moving up a stage does.
 * - `guardian`: off until a guardian turns it on.
 * - `contacts`: on, with people a guardian approved only.
 * - `on`: on; a guardian may still turn it off.
 */
export const MINOR_LEVELS = ["off", "guardian", "contacts", "on"] as const;

export type MinorLevel = (typeof MINOR_LEVELS)[number];

/** A level per stage, in `MINOR_STAGES` order. */
type StageLevels = readonly [MinorLevel, MinorLevel, MinorLevel, MinorLevel, MinorLevel];

const O = "off";
const G = "guardian";
const C = "contacts";
const Y = "on";

const EVERYDAY: StageLevels = [O, Y, Y, Y, Y];
const PUBLIC_ADDRESS: StageLevels = [O, O, O, G, Y];
const BUILDER: StageLevels = [O, O, O, G, G];

/**
 * The defaults per stage. Typed over every non-floor key, so a permission added
 * to the catalogue does not compile until somebody decides what a child gets.
 */
export const STAGE_PRESETS: Readonly<Record<PresetCapability, StageLevels>> = {
    "drive.read": EVERYDAY,
    "drive.write": EVERYDAY,
    "drive.delete": EVERYDAY,
    "shares.create": PUBLIC_ADDRESS,
    "requests.create": PUBLIC_ADDRESS,
    "snippets.read": EVERYDAY,
    "snippets.write": PUBLIC_ADDRESS,
    "vault.use": [O, O, Y, Y, Y],
    "notes.use": EVERYDAY,
    "office.use": EVERYDAY,
    "vpn.use": [O, O, G, Y, Y],
    "mail.use": [O, O, G, Y, Y],
    "calendar.use": EVERYDAY,
    "crm.use": BUILDER,
    "translate.use": EVERYDAY,
    "automations.use": BUILDER,
    "chat.use": [O, C, C, Y, Y],
    "chat.spaces": [O, O, O, Y, Y],
    "chat.groups": [O, O, C, Y, Y],
    "chat.attach": [O, G, Y, Y, Y],
    "chat.call": [O, C, C, Y, Y],
    "chat.meetings": [O, O, O, O, G],
    "arcade.open": EVERYDAY,
    "arcade.calls": [O, C, C, Y, Y],
    "deploy.read": BUILDER,
    "deploy.manage": BUILDER,
    "games.read": [O, O, Y, Y, Y],
    "games.moderate": BUILDER,
    "games.console": BUILDER,
    "games.manage": BUILDER,
    "agents.read": BUILDER,
    "agents.manage": BUILDER,
    "home.read": [O, O, G, Y, Y],
    "home.control": BUILDER,
    "tools.use": EVERYDAY,
    "tools.manage": PUBLIC_ADDRESS,
    "tasks.read": EVERYDAY,
    "tasks.manage": EVERYDAY,
    "polar.use": PUBLIC_ADDRESS,
    "app:polar": PUBLIC_ADDRESS,
    "feature:polarMemories": [O, O, O, O, Y],
    "feature:publicLinks": PUBLIC_ADDRESS,
    "feature:thirdParty": PUBLIC_ADDRESS
};

/** What is only a guardian's to give below the consent age, whatever the stage
 *  says: profiling and handing their content to a third party. */
export const CONSENT_GATED: readonly PresetCapability[] = [
    "feature:polarMemories",
    "feature:thirdParty"
];

const FLOOR_SET: ReadonlySet<MinorCapability> = new Set(MINOR_FLOOR);

export function isFloorCapability(key: MinorCapability): key is MinorFloorCapability {
    return FLOOR_SET.has(key);
}

/** The level a stage gives one key, or `floor` for a key nobody can open. */
export function stageLevel(
    stage: MinorStage,
    key: MinorCapability,
    belowConsentAge: boolean
): MinorLevel | "floor" {
    if (isFloorCapability(key)) return "floor";
    const level = STAGE_PRESETS[key][MINOR_STAGES.indexOf(stage)] as MinorLevel;
    if (belowConsentAge && level === "on" && CONSENT_GATED.includes(key)) return "guardian";
    return level;
}

/** A guardian's exception to the stage preset. */
export interface MinorOverride {
    readonly key: MinorCapability;
    readonly effect: "allow" | "deny";
}

/** Why an override did not take: the floor, a stage that does not offer it yet,
 *  or a permission it cannot be held without that is not allowed. */
export type IgnoredReason = "floor" | "stageLocked" | "needs";

export interface MinorCeiling {
    readonly stage: MinorStage;
    /** What the account may use. Anything absent is denied. */
    readonly allowed: ReadonlySet<MinorCapability>;
    /** Allowed, with guardian-approved people only. A subset of `allowed`. */
    readonly contactsOnly: ReadonlySet<MinorCapability>;
    readonly ignored: readonly {
        readonly override: MinorOverride;
        readonly reason: IgnoredReason;
    }[];
}

/**
 * The effective limits: the stage preset, then the guardian's overrides, under
 * the floor. A deny always takes; an allow opens a `guardian` key and is
 * ignored on a floor or `off` key. An allowed permission whose implied ones are
 * not allowed is dropped, so the ceiling never holds a grant that only looks
 * narrower than it is.
 */
export function minorCeiling(input: {
    readonly stage: MinorStage;
    readonly overrides?: readonly MinorOverride[];
    readonly belowConsentAge: boolean;
}): MinorCeiling {
    const effects = new Map<MinorCapability, MinorOverride["effect"]>();
    for (const override of input.overrides ?? []) {
        // A deny written after an allow, or before it, is still a deny.
        if (effects.get(override.key) !== "deny") effects.set(override.key, override.effect);
    }
    const allowed = new Set<MinorCapability>();
    const contactsOnly = new Set<MinorCapability>();
    const ignored: { override: MinorOverride; reason: IgnoredReason }[] = [];
    for (const key of MINOR_CAPABILITIES) {
        const level = stageLevel(input.stage, key, input.belowConsentAge);
        const effect = effects.get(key);
        if (level === "floor" || level === "off") {
            if (effect === "allow") {
                ignored.push({
                    override: { key, effect },
                    reason: level === "floor" ? "floor" : "stageLocked"
                });
            }
            continue;
        }
        if (effect === "deny") continue;
        if (level === "guardian" && effect !== "allow") continue;
        allowed.add(key);
        if (level === "contacts") contactsOnly.add(key);
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const key of [...allowed]) {
            if (!(PERMISSIONS as readonly string[]).includes(key)) continue;
            if (impliedBy(key as Permission).every((implied) => allowed.has(implied))) continue;
            allowed.delete(key);
            contactsOnly.delete(key);
            changed = true;
            const effect = effects.get(key);
            if (effect === "allow") ignored.push({ override: { key, effect }, reason: "needs" });
        }
    }
    return { stage: input.stage, allowed, contactsOnly, ignored };
}

/** The permissions the ceiling denies, in catalogue order: what the server adds
 *  as deny statements over whatever the account's roles grant. */
export function deniedPermissions(ceiling: MinorCeiling): Permission[] {
    return PERMISSIONS.filter((permission) => !ceiling.allowed.has(permission));
}

/** What a guardian may see about a minor's account. Never message contents. */
export const GUARDIAN_VIEWS = [
    "signIns",
    "appUsage",
    "contacts",
    "requests",
    "restrictions"
] as const;

export type GuardianView = (typeof GUARDIAN_VIEWS)[number];

const CLOSE_VIEW: Readonly<Record<GuardianView, boolean>> = {
    signIns: true,
    appUsage: true,
    contacts: true,
    requests: true,
    restrictions: true
};

const TEEN_VIEW: Readonly<Record<GuardianView, boolean>> = {
    ...CLOSE_VIEW,
    appUsage: false,
    contacts: false
};

/** What guardians see: everything up to preteen, less from teen or from the
 *  consent age, whichever comes first (D6). Supervision itself lasts to 18. */
export function guardianVisibility(
    stage: MinorStage,
    pastConsentAge: boolean
): Readonly<Record<GuardianView, boolean>> {
    if (pastConsentAge || isLaterStage(stage, "preteen")) return TEEN_VIEW;
    return CLOSE_VIEW;
}

/** Whether somebody has reached the consent age on `today`. */
export function isPastConsentAge(
    birthMonth: string,
    today: CalendarDate,
    consentAge = DEFAULT_DIGITAL_CONSENT_AGE
): boolean {
    return ageOn(birthMonth, today) >= consentAge;
}
