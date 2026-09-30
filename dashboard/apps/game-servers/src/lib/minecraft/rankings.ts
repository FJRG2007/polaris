/**
 * Leaderboards for the side panel and announcements: who has the highest level,
 * who has died most, killed most, played longest, travelled furthest, mined most.
 *
 * Level is read from the players who are on, as it is now. Everything else is
 * the game's own statistics file for every player the world has seen, online or
 * not - which the game writes when it saves, so a ranking is a few minutes
 * behind the game and never ahead of it.
 *
 * Pure: turning figures into ranked lines, and spreading a list over the panel.
 */

import { miningFigures } from "./xray";
import type { PlayerStats } from "../games-activity";

/**
 * The game's counters a ranking reads beyond the four every screen shows. All of
 * them are in the same file as those, kept since the player first joined, so a
 * ranking of one covers the world's whole history and costs no reading of its own.
 */
export interface PlayerTallies {
    /** Centimetres on foot, swimming, climbing, gliding and riding - not flying,
     *  which is creative mode, and not falling. */
    readonly travelledCm: number;
    readonly mined: number;
    readonly enchanted: number;
    readonly jumps: number;
    /** Tenths of a health point, the game's unit: a heart is two points. */
    readonly damageDealt: number;
    readonly damageTaken: number;
    readonly fishCaught: number;
    readonly animalsBred: number;
    readonly villagerTrades: number;
    readonly crafted: number;
    readonly diamonds: number;
    /** Since the last death, in ticks: the game keeps the current run, not the record. */
    readonly aliveTicks: number;
    readonly slept: number;
    readonly chestsOpened: number;
    /** Times the player has left the game, which is how many visits they have made. */
    readonly sessions: number;
    readonly bossesSlain: number;
}

const TRAVEL = [
    "walk_one_cm",
    "sprint_one_cm",
    "crouch_one_cm",
    "swim_one_cm",
    "walk_on_water_one_cm",
    "walk_under_water_one_cm",
    "climb_one_cm",
    "aviate_one_cm",
    "boat_one_cm",
    "horse_one_cm",
    "minecart_one_cm",
    "pig_one_cm",
    "strider_one_cm"
];

/** One player's tallies out of their stats file, or null when it is not one. */
export function readTallies(json: string): PlayerTallies | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }
    const stats = (parsed as { stats?: unknown } | null)?.stats;
    if (typeof stats !== "object" || stats === null) return null;
    const category = (name: string) => {
        const value = (stats as Record<string, unknown>)[`minecraft:${name}`];
        return (typeof value === "object" && value !== null ? value : {}) as Record<
            string,
            unknown
        >;
    };
    const count = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? value : 0;
    const some = (name: string, ...keys: string[]) => {
        const held = category(name);
        return keys.reduce((sum, key) => sum + count(held[`minecraft:${key}`]), 0);
    };
    const all = (name: string) =>
        Object.values(category(name)).reduce<number>((sum, value) => sum + count(value), 0);

    return {
        travelledCm: some("custom", ...TRAVEL),
        mined: all("mined"),
        enchanted: some("custom", "enchant_item"),
        jumps: some("custom", "jump"),
        damageDealt: some("custom", "damage_dealt"),
        damageTaken: some("custom", "damage_taken"),
        fishCaught: some("custom", "fish_caught"),
        animalsBred: some("custom", "animals_bred"),
        villagerTrades: some("custom", "traded_with_villager"),
        crafted: all("crafted"),
        diamonds: miningFigures(json)?.diamonds ?? 0,
        aliveTicks: some("custom", "time_since_death"),
        slept: some("custom", "sleep_in_bed"),
        chestsOpened: some(
            "custom",
            "open_chest",
            "open_barrel",
            "open_enderchest",
            "open_shulker_box"
        ),
        sessions: some("custom", "leave_game"),
        bossesSlain: some("killed", "ender_dragon", "wither")
    };
}

/** A player's tallies from each of their files, added together - except the run
 *  since the last death, which is one life and not a sum of two: it is the first
 *  file's, the one the player joined under last, since a file they no longer use
 *  stopped counting it the day they left it. */
export function addTallies(all: readonly PlayerTallies[]): PlayerTallies | null {
    if (all.length === 0) return null;
    return all.reduce((sum, one) => {
        const added = { ...sum };
        for (const key of Object.keys(one) as (keyof PlayerTallies)[]) {
            if (key !== "aliveTicks") added[key] = sum[key] + one[key];
        }
        return added;
    });
}

const TICK_MS = 50;

/** A count that stays short on a line: 9999, then 12.3k, then 1.2M. */
export function countText(value: number): string {
    const rounded = Math.round(value);
    if (rounded < 10_000) return String(rounded);
    const thousands = Number((value / 1_000).toFixed(1));
    if (thousands < 1_000) return `${thousands}k`;
    return `${Number((value / 1_000_000).toFixed(1))}M`;
}

/** Distance from centimetres: metres, or kilometres from one. */
export function distanceText(cm: number): string {
    const metres = cm / 100;
    return metres < 1_000 ? `${Math.floor(metres)}m` : `${Number((metres / 1_000).toFixed(1))}km`;
}

/** Damage in hearts, from the game's tenths of a health point; a tenth under
 *  one heart, so nobody on the board reads as none. */
function heartsText(tenths: number): string {
    const hearts = tenths / 20;
    return hearts < 1 ? String(Number(hearts.toFixed(1)) || 0.1) : countText(Math.round(hearts));
}

interface Ranking {
    readonly label: string;
    readonly of: (figures: PlayerFigures) => number;
    readonly text?: (value: number) => string;
    /** Two rows, for the editor's preview. */
    readonly sample: readonly [string, string];
}

const tally = (key: keyof PlayerTallies) => (figures: PlayerFigures) => figures.tallies?.[key] ?? 0;

/** The rankings on offer, by variable. */
export const RANKINGS = {
    "rank.deaths": {
        label: "Most deaths", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: (figures) => figures.stats.deaths,
        sample: ["1. Steve 42", "2. Alex 30"]
    },
    "rank.kills": {
        label: "Most mobs killed", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: (figures) => figures.stats.mobKills,
        sample: ["1. Alex 812", "2. Steve 640"]
    },
    "rank.pvp": {
        label: "Most players killed", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: (figures) => figures.stats.playerKills,
        sample: ["1. Alex 9", "2. Steve 4"]
    },
    "rank.playtime": {
        label: "Most time played", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: (figures) => figures.stats.playedMs,
        text: (ms) => playedText(ms),
        sample: ["1. Steve 120h", "2. Alex 86h"]
    },
    "rank.explorer": {
        label: "Furthest traveled", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("travelledCm"),
        text: distanceText,
        sample: ["1. Alex 412.5km", "2. Steve 230.1km"]
    },
    "rank.mined": {
        label: "Most blocks mined", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("mined"),
        text: countText,
        sample: ["1. Steve 37.4k", "2. Alex 17k"]
    },
    "rank.diamonds": {
        label: "Most diamonds mined", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("diamonds"),
        sample: ["1. Steve 214", "2. Alex 96"]
    },
    "rank.enchanted": {
        label: "Most items enchanted", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("enchanted"),
        sample: ["1. Alex 48", "2. Steve 31"]
    },
    "rank.crafted": {
        label: "Most items crafted", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("crafted"),
        text: countText,
        sample: ["1. Steve 12.8k", "2. Alex 7.6k"]
    },
    "rank.fish": {
        label: "Most fish caught", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("fishCaught"),
        sample: ["1. Alex 62", "2. Steve 14"]
    },
    "rank.bred": {
        label: "Most animals bred", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("animalsBred"),
        sample: ["1. Steve 120", "2. Alex 35"]
    },
    "rank.trades": {
        label: "Most villager trades", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("villagerTrades"),
        sample: ["1. Alex 88", "2. Steve 23"]
    },
    "rank.damage": {
        label: "Most damage dealt, in hearts", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("damageDealt"),
        text: heartsText,
        sample: ["1. Alex 2.5k", "2. Steve 1.9k"]
    },
    "rank.hurt": {
        label: "Most damage taken, in hearts", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("damageTaken"),
        text: heartsText,
        sample: ["1. Steve 860", "2. Alex 640"]
    },
    "rank.alive": {
        label: "Longest alive right now", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("aliveTicks"),
        text: (ticks) => playedText(ticks * TICK_MS),
        sample: ["1. Alex 26h", "2. Steve 3h"]
    },
    "rank.bosses": {
        label: "Most bosses slain", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("bossesSlain"),
        sample: ["1. Steve 3", "2. Alex 1"]
    },
    "rank.jumps": {
        label: "Most jumps", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("jumps"),
        text: countText,
        sample: ["1. Alex 64.2k", "2. Steve 41k"]
    },
    "rank.sleep": {
        label: "Most nights slept", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("slept"),
        sample: ["1. Steve 96", "2. Alex 40"]
    },
    "rank.chests": {
        label: "Most chests opened", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("chestsOpened"),
        text: countText,
        sample: ["1. Alex 3.1k", "2. Steve 2.4k"]
    },
    "rank.sessions": {
        label: "Most visits", // i18n-ignore: also the in-game heading; screens read sidebar.blocks
        of: tally("sessions"),
        sample: ["1. Steve 97", "2. Alex 58"]
    }
} as const satisfies Record<string, Ranking>;

export type StatsRanking = keyof typeof RANKINGS;

/** The ranking read from the players who are on. */
export const LEVEL_RANKING = "rank.level";

export const STATS_RANKINGS = Object.keys(RANKINGS) as StatsRanking[];

/** The ranking of Polaris's own events: who has won most. */
export const EVENTS_RANKING = "rank.events";

/** Every variable that is a list on the side panel. */
export const LIST_VARIABLES: readonly string[] = [
    "server.levels",
    LEVEL_RANKING,
    ...STATS_RANKINGS,
    EVENTS_RANKING
];

/** How many a ranking names when it is written into one line, in an
 *  announcement or beside other words. */
export const INLINE_TOP = 5;

/** One player's figures, as the statistics files give them. */
export interface PlayerFigures {
    readonly name: string;
    readonly stats: PlayerStats;
    readonly tallies?: PlayerTallies;
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
    const chosen: Ranking = RANKINGS[ranking];
    return rankLines(
        players.map((one) => ({ name: one.name, value: chosen.of(one) })),
        chosen.text ?? String
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
    return spreadListRows(lines, lists, max).map((row) => row.text);
}

/** The same, with the line each row came from - for what is drawn on a row by
 *  the line's own settings, like the side panel's effects. */
export function spreadListRows(
    lines: readonly string[],
    lists: Readonly<Record<string, readonly string[]>>,
    max: number
): { readonly text: string; readonly from: number }[] {
    const listOf = (line: string) => LIST_VARIABLES.find((name) => TOKEN(name).test(line)) ?? null;
    const listLines = lines.filter((line) => listOf(line) !== null).length;
    if (listLines === 0) return lines.map((text, from) => ({ text, from }));
    const room = Math.max(listLines, max - (lines.length - listLines));
    const each = Math.max(1, Math.floor(room / listLines));

    return lines.flatMap((line, from) => {
        const name = listOf(line);
        if (!name) return [{ text: line, from }];
        const rows = lists[name] ?? [];
        if (rows.length === 0) return [{ text: line, from }];
        const shown =
            rows.length <= each
                ? rows
                : name === "server.levels"
                  ? [...rows.slice(0, each - 1), `+${rows.length - (each - 1)} more`]
                  : rows.slice(0, each);
        return shown.map((row) => ({ text: line.replace(TOKEN(name), row), from }));
    });
}
