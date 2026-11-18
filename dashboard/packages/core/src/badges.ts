/**
 * Profile badges: what they are, how a level is reached, and how somebody
 * arranges theirs.
 *
 * Three kinds share one key space so a single ordered list can hold them:
 *
 * - `staff` follows the administrator role of this instance. Nobody grants it.
 * - `custom:<id>` is a badge an administrator made and gave to somebody.
 * - `ladder:<id>` is a progress badge, climbed by activity Polaris already
 *   records. Each ladder is a list of thresholds; reaching the n-th one is
 *   level n. The level names are shared by every ladder so "Nova" means the
 *   same height wherever it is shown.
 *
 * Everything here is pure, so the server and the screens agree on what a
 * number means without asking each other.
 */

import { z } from "zod";
import { PRIVACY_AUDIENCES, MOST_LISTED } from "./schemas/privacy.js";

/** Level names, lowest first. A ladder with six steps uses the first six. */
export const BADGE_LEVELS = [
    "spark",
    "ember",
    "flare",
    "beacon",
    "comet",
    "nova",
    "pulsar",
    "quasar",
    "magnetar",
    "singularity"
] as const;

/**
 * Game Time keeps the level names Discord gives the same ladder, so somebody
 * who knows one reads the other: "Ironclad" is a thousand hours in both.
 */
export const GAME_TIME_LEVELS = [
    "casual",
    "recreational",
    "dedicated",
    "committed",
    "serious",
    "devoted",
    "seasoned",
    "ironclad",
    "unshakeable",
    "eternal"
] as const;

export type BadgeLevelName = (typeof BADGE_LEVELS)[number] | (typeof GAME_TIME_LEVELS)[number];

/**
 * The ten steps every activity ladder climbs: the curve Discord's own activity
 * badges use (Game Time, Streaming - 1 to 5,000 hours), so a top level is
 * years of use rather than a week of it.
 */
const ACTIVITY_CURVE = [1, 5, 20, 75, 150, 300, 500, 1000, 2000, 5000] as const;

/**
 * The progress badges. Each is read from data that exists without this
 * feature: the day the account was made, chat messages written, time in
 * calls and meetings, tasks completed as an assignee, games started in the
 * arcade, hours on a linked game server, and - from the desktop app's game
 * detection - hours played and how many different games.
 *
 * Tenure is a year a level, one to ten, as Discord's account-age badge is.
 * Messages are the curve ten times over, since one is a few seconds' work.
 */
export const BADGE_LADDERS = {
    tenure: { unit: "days", thresholds: [365, 730, 1095, 1460, 1825, 2190, 2555, 2920, 3285, 3650] },
    messages: { unit: "messages", thresholds: ACTIVITY_CURVE.map((step) => step * 10) },
    calls: { unit: "hours", thresholds: ACTIVITY_CURVE },
    tasks: { unit: "tasks", thresholds: ACTIVITY_CURVE },
    arcade: { unit: "games", thresholds: ACTIVITY_CURVE },
    servers: { unit: "hours", thresholds: ACTIVITY_CURVE },
    gameTime: { unit: "hours", thresholds: ACTIVITY_CURVE, levels: GAME_TIME_LEVELS },
    gameVariety: { unit: "games", thresholds: [2, 5, 10, 15, 20, 30, 40, 60, 80, 100] }
} as const satisfies Record<
    string,
    { unit: string; thresholds: readonly number[]; levels?: readonly BadgeLevelName[] }
>;

export type BadgeLadderId = keyof typeof BADGE_LADDERS;

export const BADGE_LADDER_IDS = Object.keys(BADGE_LADDERS) as BadgeLadderId[];

/** The drawn icons a custom badge may use. */
export const BADGE_ICONS = [
    "star",
    "heart",
    "shield",
    "flag",
    "bolt",
    "crown",
    "leaf",
    "gem"
] as const;

export type BadgeIcon = (typeof BADGE_ICONS)[number];

export const STAFF_BADGE = "staff";

export type BadgeKind = "staff" | "custom" | "ladder";

const LADDER_PREFIX = "ladder:";
const CUSTOM_PREFIX = "custom:";

export function ladderKey(id: BadgeLadderId): string {
    return `${LADDER_PREFIX}${id}`;
}

export function customKey(id: string): string {
    return `${CUSTOM_PREFIX}${id}`;
}

/** What a stored key names, or null for one this version does not know. */
export function parseBadgeKey(
    key: string
):
    | { kind: "staff" }
    | { kind: "ladder"; id: BadgeLadderId }
    | { kind: "custom"; id: string }
    | null {
    if (key === STAFF_BADGE) return { kind: "staff" };
    if (key.startsWith(LADDER_PREFIX)) {
        const id = key.slice(LADDER_PREFIX.length);
        return id in BADGE_LADDERS ? { kind: "ladder", id: id as BadgeLadderId } : null;
    }
    if (key.startsWith(CUSTOM_PREFIX)) {
        const id = key.slice(CUSTOM_PREFIX.length);
        return z.string().uuid().safeParse(id).success ? { kind: "custom", id } : null;
    }
    return null;
}

/** How many thresholds a value has reached: 0 is none, n is level n. */
export function levelFor(thresholds: readonly number[], value: number): number {
    let level = 0;
    for (const threshold of thresholds) {
        if (value >= threshold) level += 1;
        else break;
    }
    return level;
}

export interface LadderProgress {
    value: number;
    level: number;
    /** Highest level the ladder has. */
    top: number;
    /** The threshold of the next level, null at the top. */
    next: number | null;
    /** 0..1 of the way from the current level's threshold to the next one. */
    fraction: number;
}

export function ladderProgress(thresholds: readonly number[], raw: number): LadderProgress {
    const value = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    const level = levelFor(thresholds, value);
    const top = thresholds.length;
    if (level >= top) return { value, level, top, next: null, fraction: 1 };
    const floor = level === 0 ? 0 : thresholds[level - 1]!;
    const next = thresholds[level]!;
    const fraction = Math.min(1, Math.max(0, (value - floor) / (next - floor)));
    return { value, level, top, next, fraction };
}

/** The names one ladder's levels go by, lowest first. */
export function ladderLevels(id: BadgeLadderId): readonly BadgeLevelName[] {
    const ladder = BADGE_LADDERS[id];
    return "levels" in ladder ? ladder.levels : BADGE_LEVELS;
}

export function levelName(level: number, ladder?: BadgeLadderId): BadgeLevelName | null {
    const names = ladder ? ladderLevels(ladder) : BADGE_LEVELS;
    return level >= 1 ? (names[Math.min(level, names.length) - 1] ?? null) : null;
}

export const MOST_BADGE_PREFERENCES = 200;

const badgeKeySchema = z
    .string()
    .max(64)
    .refine((key) => parseBadgeKey(key) !== null, "Unknown badge");

/**
 * One badge as its owner arranges it. `audience` null follows the account's
 * badges setting; anything else replaces it for this badge alone.
 */
export const badgePreferenceSchema = z.object({
    badge: badgeKeySchema,
    hidden: z.boolean().default(false),
    audience: z.enum(PRIVACY_AUDIENCES).nullable().default(null),
    listId: z.string().uuid().nullable().default(null),
    people: z.array(z.string().uuid()).max(MOST_LISTED).default([])
});

export type BadgePreferenceInput = z.infer<typeof badgePreferenceSchema>;

/** The whole arrangement, in display order. A badge named twice is refused. */
export const badgePreferencesSchema = z
    .array(badgePreferenceSchema)
    .max(MOST_BADGE_PREFERENCES)
    .refine(
        (rows) => new Set(rows.map((row) => row.badge)).size === rows.length,
        "A badge is listed twice"
    );

/**
 * Order owned badges by their owner's arrangement. Badges never arranged keep
 * their natural order after the arranged ones, so a newly earned one appears
 * at the end instead of jumping the queue.
 */
export function orderBadges<T extends { key: string }>(
    badges: readonly T[],
    positions: ReadonlyMap<string, number>
): T[] {
    return badges
        .map((badge, index) => ({ badge, index }))
        .sort((a, b) => {
            const pa = positions.get(a.badge.key);
            const pb = positions.get(b.badge.key);
            if (pa !== undefined && pb !== undefined) return pa - pb || a.index - b.index;
            if (pa !== undefined) return -1;
            if (pb !== undefined) return 1;
            return a.index - b.index;
        })
        .map((entry) => entry.badge);
}

/** Move one entry of a list by `delta` places, clamped. Pure, for the keyboard. */
export function moveEntry<T>(list: readonly T[], from: number, delta: number): T[] {
    const to = Math.min(list.length - 1, Math.max(0, from + delta));
    if (from < 0 || from >= list.length || to === from) return [...list];
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
}

/** What an administrator types to make a badge. */
export const badgeDefinitionSchema = z.object({
    name: z.string().trim().min(1, "Give the badge a name").max(40),
    description: z.string().trim().max(160).default(""),
    icon: z.enum(BADGE_ICONS).default("star")
});

export type BadgeDefinitionInput = z.infer<typeof badgeDefinitionSchema>;

/** Share of people with a badge as a whole percent, at least 1 when anybody has it. */
export function rarityPercent(holders: number, people: number): number {
    if (people <= 0 || holders <= 0) return 0;
    return Math.max(1, Math.min(100, Math.round((holders / people) * 100)));
}
