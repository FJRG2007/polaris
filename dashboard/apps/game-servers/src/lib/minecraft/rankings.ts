/**
 * Leaderboards for the side panel and announcements: who has the highest level,
 * who has died most, killed most, played longest.
 *
 * Level is read from the players who are on, as it is now. Everything else is
 * the game's own statistics file for every player the world has seen, online or
 * not - which the game writes when it saves, so a ranking is a few minutes
 * behind the game and never ahead of it.
 *
 * Pure: turning figures into ranked lines, and spreading a list over the panel.
 */

import type { PlayerStats } from "../games-activity";

/** The rankings on offer, by variable. */
export const RANKINGS = {
    "rank.deaths": { label: "Most deaths", of: (stats: PlayerStats) => stats.deaths },
    "rank.kills": { label: "Most mobs killed", of: (stats: PlayerStats) => stats.mobKills },
    "rank.pvp": { label: "Most players killed", of: (stats: PlayerStats) => stats.playerKills },
    "rank.playtime": { label: "Most time played", of: (stats: PlayerStats) => stats.playedMs }
} as const;

export type StatsRanking = keyof typeof RANKINGS;

/** The ranking read from the players who are on. */
export const LEVEL_RANKING = "rank.level";

export const STATS_RANKINGS = Object.keys(RANKINGS) as StatsRanking[];

/** Every variable that is a list on the side panel. */
export const LIST_VARIABLES: readonly string[] = [
    "server.levels",
    LEVEL_RANKING,
    ...STATS_RANKINGS
];

/** How many a ranking names when it is written into one line, in an
 *  announcement or beside other words. */
export const INLINE_TOP = 5;

/** One player's figures, as the statistics files give them. */
export interface PlayerFigures {
    readonly name: string;
    readonly stats: PlayerStats;
}

/** Time played, the way a leaderboard reads it: hours, or minutes under one. */
export function playedText(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

/**
 * A ranking's lines, best first: "1. Steve 42". Nobody at zero - a leaderboard
 * of people who have never died is a list of everybody - and ties share the
 * order of their names.
 */
export function rankLines(
    entries: readonly { readonly name: string; readonly value: number }[],
    format: (value: number) => string = String
): string[] {
    return entries
        .filter((one) => one.value > 0)
        .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
        .map((one, index) => `${index + 1}. ${one.name} ${format(one.value)}`);
}

/** One statistics ranking over every player the world has figures for. */
export function statsRanking(ranking: StatsRanking, players: readonly PlayerFigures[]): string[] {
    const pick = RANKINGS[ranking].of;
    return rankLines(
        players.map((one) => ({ name: one.name, value: pick(one.stats) })),
        ranking === "rank.playtime" ? playedText : String
    );
}

const TOKEN = (name: string) =>
    new RegExp(`\\{\\s*${name.replace(/\./g, "\\.")}\\s*(?:\\|\\s*"[^"{}]*"\\s*)?\\}`, "i");

/**
 * The panel's lines with each one that shows a list written out once per row,
 * in whatever colours that line has around it.
 *
 * The lists share the room the other lines leave, evenly. Everybody's level
 * counts what did not fit in its last row; a ranking is a top, and simply stops.
 * A list with nothing in it leaves its line as written, for its fallback.
 */
export function spreadListLines(
    lines: readonly string[],
    lists: Readonly<Record<string, readonly string[]>>,
    max: number
): string[] {
    const listOf = (line: string) => LIST_VARIABLES.find((name) => TOKEN(name).test(line)) ?? null;
    const listLines = lines.filter((line) => listOf(line) !== null).length;
    if (listLines === 0) return [...lines];
    const room = Math.max(listLines, max - (lines.length - listLines));
    const each = Math.max(1, Math.floor(room / listLines));

    return lines.flatMap((line) => {
        const name = listOf(line);
        if (!name) return [line];
        const rows = lists[name] ?? [];
        if (rows.length === 0) return [line];
        const shown =
            rows.length <= each
                ? rows
                : name === "server.levels"
                  ? [...rows.slice(0, each - 1), `+${rows.length - (each - 1)} more`]
                  : rows.slice(0, each);
        return shown.map((row) => line.replace(TOKEN(name), row));
    });
}
