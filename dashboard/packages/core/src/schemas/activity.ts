/**
 * What somebody is doing right now, drawn beside their presence: the game on
 * their computer, the song their music service is playing, the server they are
 * on here.
 *
 * Not a status. A status is a sentence somebody typed; an activity is a fact
 * something observed, which is why every source of one is a machine rather than
 * a text field - the desktop app looking at what is running, the music service
 * saying what is playing, a game server saying who is on.
 *
 * Three rules hold wherever one is shown, and they are stated here so that no
 * screen has to rediscover them:
 *
 * - **Only beside a presence the reader can see.** Somebody who appears offline
 *   to a reader - because they are, because they chose invisible, or because
 *   their last-seen setting hides them - is doing nothing as far as that reader
 *   knows. The `activity` audience narrows that further and never widens it.
 * - **Every source can be switched off on its own**, and the whole thing with
 *   one switch, and a game can be hidden by name. Off is enforced where it is
 *   written AND where it is read, so turning it off takes effect on the next
 *   read rather than on the next report.
 * - **It lapses on its own.** Every stored activity carries the moment it stops
 *   being believed, so a crashed desktop app or a closed laptop does not leave
 *   somebody "playing" for a week.
 */

import { z } from "zod";

/** Where an activity comes from. */
export const ACTIVITY_SOURCES = ["spotify", "game", "minecraft"] as const;

export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/** What each source is called on the settings screen. */
export const ACTIVITY_SOURCE_LABELS: Record<ActivitySource, string> = {
    spotify: "Spotify",
    game: "Games on your computer",
    minecraft: "Minecraft servers here"
};

/** The most games one account may hide. A ceiling rather than a rule anybody will
 *  meet: the list is read on every report. */
export const MOST_HIDDEN_GAMES = 200;

/** The most programs one account may tell the desktop app are games. */
export const MOST_CUSTOM_GAMES = 100;

/** How many games the desktop app has seen are remembered, for the hide list. */
export const MOST_SEEN_GAMES = 30;

/**
 * A game, as it is recognized: the name of the program that runs it, lowercased,
 * without the folder it is in.
 *
 * The program rather than the title, because the program is what the computer
 * reports and the title is what a person calls it - two players of the same game
 * may call it two things, and the list of hidden games has to match whatever the
 * desktop app sees next time.
 */
export function gameKeyOf(executable: string): string {
    const base = executable.trim().split(/[\\/]/).at(-1) ?? "";
    return base.trim().toLowerCase();
}

/** Anything that is not a printable line, and the characters a path is built from. */
const UNPRINTABLE = /[\u0000-\u001f\u007f/\\]/;

export const gameKeySchema = z
    .string()
    .transform(gameKeyOf)
    .pipe(
        z
            .string()
            .min(1, "Name the program")
            .max(120, "That program name is too long")
            .refine((value) => !UNPRINTABLE.test(value), "That is not a program name")
    );

export const gameNameSchema = z
    .string()
    .trim()
    .min(1, "Give the game a name")
    .max(100, "Keep the name under 100 characters")
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "That name has characters it cannot show");

/** A program somebody told the desktop app is a game. */
export const customGameSchema = z.object({
    executable: gameKeySchema,
    name: gameNameSchema
});

export type CustomGame = z.infer<typeof customGameSchema>;

/** A game the desktop app has seen, remembered so it can be hidden by name. */
export const seenGameSchema = z.object({
    key: gameKeySchema,
    name: gameNameSchema,
    seenAt: z.string().datetime()
});

export type SeenGame = z.infer<typeof seenGameSchema>;

/**
 * Whether somebody shares what they are doing, and from where.
 *
 * Everything on by default, which is what a new account is on: absence is not a
 * stricter setting, and who sees it is the separate `activity` audience in the
 * privacy settings.
 */
export const activitySettingsSchema = z.object({
    share: z.boolean().default(true),
    spotify: z.boolean().default(true),
    games: z.boolean().default(true),
    minecraft: z.boolean().default(true),
    hiddenGames: z.array(gameKeySchema).max(MOST_HIDDEN_GAMES).default([]),
    customGames: z
        .array(customGameSchema)
        .max(MOST_CUSTOM_GAMES)
        .default([])
        .refine(
            (games) => new Set(games.map((game) => game.executable)).size === games.length,
            "That program is already on the list"
        )
});

export type ActivitySettings = z.infer<typeof activitySettingsSchema>;

export const DEFAULT_ACTIVITY_SETTINGS: ActivitySettings = activitySettingsSchema.parse({});

/** Whether a source is on, with the master switch taken into account. */
export function activitySourceOn(settings: ActivitySettings, source: ActivitySource): boolean {
    if (!settings.share) return false;
    if (source === "game") return settings.games;
    return settings[source];
}

/**
 * A JSON list column read back, keeping only the entries that still parse.
 *
 * A stored list is older than the code reading it, and one entry that no longer
 * fits the schema must cost that entry rather than the whole list - a hide list
 * that came back empty would publish every game on it.
 */
export function readStoredList<T>(raw: string | null | undefined, item: z.ZodType<T>): T[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw ?? "[]");
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const kept: T[] = [];
    for (const entry of parsed) {
        const one = item.safeParse(entry);
        if (one.success) kept.push(one.data);
    }
    return kept;
}

/**
 * What the desktop app reports: the game it sees running, or none.
 *
 * `startedAt` is when the program was first seen, on the reporting computer's
 * clock. It is taken as a claim and clamped where it is stored - a clock an hour
 * fast must not make somebody look like they started playing in the future.
 */
export const gameReportSchema = z.object({
    game: z
        .object({
            key: gameKeySchema,
            name: gameNameSchema,
            startedAt: z.string().datetime()
        })
        .nullable()
});

export type GameReport = z.infer<typeof gameReportSchema>;

/**
 * One activity, as a screen is handed it.
 *
 * Times travel as ISO strings and elapsed time is worked out on the reader's own
 * clock, so a card keeps counting without asking again.
 */
export interface ActivityView {
    readonly source: ActivitySource;
    /** What it is, stably: a game's program, a track's id. */
    readonly key: string;
    /** The first line: the game, the track. */
    readonly name: string;
    /** The second: the artists, or the server somebody is playing on. */
    readonly details: string;
    /** The third: the album. */
    readonly state: string;
    readonly imageUrl: string | null;
    /** Where pressing the title goes, when it goes anywhere. */
    readonly linkUrl: string | null;
    readonly startedAt: string;
    /** When a track ends, for the progress bar. Null for anything without an end. */
    readonly endsAt: string | null;
}

/** The line a card is headed with, the way people say it. */
export function activityHeadline(activity: Pick<ActivityView, "source" | "name">): string {
    if (activity.source === "spotify") return "Listening to Spotify";
    return `Playing ${activity.name}`;
}

/** The one line a crowded row has room for: "Playing Hollow Knight", "Listening
 *  to <track>". */
export function activityShortLine(activity: Pick<ActivityView, "source" | "name">): string {
    if (activity.source === "spotify") return `Listening to ${activity.name}`;
    return `Playing ${activity.name}`;
}

/**
 * A length of time as a clock reads it: 3:07, 1:02:09.
 *
 * Negative time is none: a clock a few seconds behind the server's would
 * otherwise start a card at -0:03.
 */
export function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (value: number) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * How far through a track is, held inside its length.
 *
 * Past the end is the end rather than more than the whole: the next reading is
 * at most one poll away, and a bar that ran off its own edge in the meantime
 * would look broken.
 */
export function trackProgress(
    activity: Pick<ActivityView, "startedAt" | "endsAt">,
    now: number
): { elapsedMs: number; totalMs: number } | null {
    if (!activity.endsAt) return null;
    const start = Date.parse(activity.startedAt);
    const end = Date.parse(activity.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    const totalMs = end - start;
    return { elapsedMs: Math.min(Math.max(0, now - start), totalMs), totalMs };
}
