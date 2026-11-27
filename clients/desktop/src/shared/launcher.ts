/**
 * What the launcher window and the main process say to each other, and the
 * ranking of what it lists. The window draws rows and sends back the id of the
 * one chosen; what a row does stays in the main process, so the page can never
 * ask to open an arbitrary address or program.
 */

import { normalizeSearchText } from "../../../../dashboard/packages/core/src/search-text";
import type { LauncherRowAction } from "./game-kinds";
import type { SystemCommandId } from "../../../../dashboard/packages/core/src/launcher-commands";

export const LAUNCHER_CHANNELS = {
    query: "launcher:query",
    run: "launcher:run",
    hide: "launcher:hide",
    opened: "launcher:opened",
    hidden: "launcher:hidden",
    clearClipboard: "launcher:clear-clipboard",
    open: "launcher:open",
    plugins: "launcher:plugins",
    act: "launcher:act"
} as const;

export type LauncherRowKind = "url" | "answer" | "polaris" | "page" | "system" | "app" | "polar" | "web" | "clip";

export interface LauncherRow {
    readonly id: string;
    readonly kind: LauncherRowKind;
    readonly title: string;
    readonly subtitle: string;
    /** A program's own icon, as a PNG data URL. */
    readonly icon?: string | null;
    /** A system command's id (`@polaris/core` `launcher-commands`), so a page draws its name in the reader's language. */
    readonly command?: SystemCommandId;
    /** A program that is a game (Raycast's Game kind): listed with the apps, drawn as a game, found by "games". */
    readonly game?: boolean;
    /** The store a game comes from ("Steam", "Epic Games"): a brand name, never translated. */
    readonly store?: string;
    /** What else the row can do besides opening it (Raycast's action panel, Ctrl+K), by id; a page names each in its own words. */
    readonly actions?: readonly LauncherRowAction[];
}

export interface LauncherAnswer {
    readonly rows: readonly LauncherRow[];
    /** Why Polaris results are missing, when they are: signed out, unreachable. */
    readonly notice: string | null;
    /** This answer's number, which an action on one of its rows names (`act`). */
    readonly version?: number;
}

/** The bridge the launcher page gets as `window.polarisLauncher`. */
export interface PolarisLauncher {
    /** `host-only`: the dashboard's palette asking, which lists Polaris's own rows itself. */
    query(text: string, mode?: "host-only"): Promise<LauncherAnswer>;
    /** Show a path of the instance in the main window (the dashboard's palette only). */
    open(href: string): Promise<void>;
    run(id: string): Promise<boolean>;
    /** Do one of a listed row's `actions`, naming the answer (`version`) the row was drawn from; the list should be asked
     *  again after, since the row changes. Absent on desktops that predate it. */
    act?(id: string, action: LauncherRowAction, version: number): Promise<boolean>;
    hide(): Promise<void>;
    clearClipboard(): Promise<void>;
    /** Heard on each open, with the text it opens with (empty from the key; what
     *  the main window's search field held when it was opened from there). */
    onOpened(listener: (query: string) => void): void;
    /** The window was put away by main (it lost focus), not by the page. */
    onHidden(listener: () => void): void;
    /** The device plugins on this computer, as the main window's bridge answers them (the dashboard's palette only). */
    plugins(): Promise<unknown>;
    /** @deprecated `plugins` by its name before the rename, for hosts that predate it. */
    addons(): Promise<unknown>;
}

/** Longest text the main window may hand the launcher to open with, as its own field caps it. */
export const LAUNCHER_QUERY_MAX = 200;

/** Text the main window asked the launcher to open with: one line, no control characters, capped. */
export function launcherQuery(raw: string): string {
    return raw
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, LAUNCHER_QUERY_MAX)
        .trim();
}

/** Something listed: its name, its context line and the words it is found by. */
/**
 * What lists every game and game launcher instead of searching (Raycast's
 * "Game Launcher" command, also found by "games"), in either language.
 */
const GAMES_QUERY = /^(games?|game launchers?|juegos?|lanzador de juegos)$/;

export function isGamesQuery(text: string): boolean {
    return GAMES_QUERY.test(normalizeSearchText(text).trim());
}

/**
 * A program that starts games rather than being one: the stores' own
 * clients, listed with the games by the games command (the stores Raycast's
 * Game Launcher covers).
 */
const GAME_LAUNCHER = /^(steam|epic games( launcher)?|gog galaxy|ubisoft connect|battle\.net|ea( app)?|itch|riot client|rockstar games launcher|xbox|battlestate games launcher|geforce now|roblox( player)?|amazon games|heroic games launcher|playnite)$/;

export function isGameLauncher(label: string): boolean {
    return GAME_LAUNCHER.test(normalizeSearchText(label).trim());
}

export interface Searchable {
    readonly label: string;
    readonly context: string;
    /** Other names it answers to as well as its label: a program's file name, its folder, a name somebody gave it. */
    readonly aliases?: readonly string[];
}

/** The score of each kind of match; a step is wider than `USE_BOOST_MAX` plus the finer order inside one kind. */
const SCORE = { exact: 100, start: 80, word: 60, inside: 40, letters: 20, context: 10 } as const;

/** Text as the launcher compares it: no accents, lowercase, one space between words. */
function folded(value: string): string {
    return normalizeSearchText(value);
}

/**
 * Where each word of a name starts, as Flow Launcher's acronym pass reads
 * them: after a space or a mark, a capital after a small letter
 * ("PowerShell"), and a run of digits ("Windows 11", "GTA5").
 */
function wordStarts(name: string): string[] {
    const spaced = name
        .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{L})(\p{N})/gu, "$1 $2")
        .replace(/(\p{N})(\p{L})/gu, "$1 $2");
    return folded(spaced)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

/** Whether every letter of `q` is the first of a word of the name, in order: "gta" for Grand Theft Auto V. */
function acronymOf(q: string, words: readonly string[]): boolean {
    if (q.length < 2 || /\s/.test(q)) return false;
    let at = 0;
    for (const word of words) {
        if (at < q.length && word[0] === q[at]) at += 1;
    }
    return at === q.length;
}

/**
 * The letters of `q` in order inside `name`, scored under 1 so it only orders
 * matches of the same kind: an earlier first letter and a tighter span rank
 * higher, as Flow Launcher's fuzzy pass does. Null when they are not all there.
 */
function lettersInOrder(q: string, name: string): number | null {
    const letters = q.replace(/\s+/g, "");
    if (letters.length < 2) return null;
    let at = 0;
    let first = -1;
    let last = -1;
    for (let index = 0; index < name.length && at < letters.length; index += 1) {
        if (name[index] !== letters[at]) continue;
        if (first < 0) first = index;
        last = index;
        at += 1;
    }
    if (at < letters.length) return null;
    const span = last - first + 1;
    return 0.5 * (letters.length / span) + 0.4 / (1 + first);
}

/** How one name of the thing is found by `q`, already folded; 0 for not at all. */
function nameScore(q: string, raw: string): number {
    const name = folded(raw);
    if (!name) return 0;
    // A shorter name that matches as well is the likelier one: "Steam" before "Steam Link".
    const short = 0.4 / (1 + Math.max(0, name.length - q.length));
    if (name === q) return SCORE.exact;
    if (name.startsWith(q)) return SCORE.start + short;
    const words = wordStarts(raw);
    if (name.split(/[\s\-_/.]+/).some((word) => word.startsWith(q)) || words.some((word) => word.startsWith(q))) return SCORE.word + short;
    if (acronymOf(q, words)) return SCORE.word + short / 2;
    if (name.includes(q)) return SCORE.inside + short;
    const order = lettersInOrder(q, name);
    return order === null ? 0 : SCORE.letters + order;
}

/**
 * How well `query` finds `item`, or 0 for not at all: the whole name first,
 * then its start, a word's start or its initials ("gta", "vsc"), anywhere in
 * it, its letters in order, and last a match in the context line. Accents
 * never matter, and every alias is scored the same way, the best one counting.
 */
export function matchScore(query: string, item: Searchable): number {
    const q = folded(query);
    if (!q) return 0;
    let best = nameScore(q, item.label);
    for (const alias of item.aliases ?? []) {
        // An alias never ties the label above it: the label is what is shown.
        best = Math.max(best, nameScore(q, alias) - 0.05);
    }
    if (best > 0) return best;
    return folded(item.context).includes(q) ? SCORE.context : 0;
}

/** The best `limit` matches, best first; ties keep their order. */
export function topMatches<T extends Searchable>(query: string, items: readonly T[], limit: number): T[] {
    return items
        .map((item, index) => ({ item, index, score: matchScore(query, item) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit)
        .map((entry) => entry.item);
}

/** The most a row's use adds to its match: less than the step between two kinds of match, so use reorders within one and never above a better one. */
export const USE_BOOST_MAX = 19;

/** What a use score (`@polaris/core` `frecency`) adds to a match: grows with use, flattening out. */
export function useBoost(score: number): number {
    return score > 0 ? Math.min(USE_BOOST_MAX, 8 * Math.log2(1 + score)) : 0;
}

/**
 * The best `limit` matches like `topMatches`, with what was chosen more often
 * and lately first among matches of one kind. `keyOf` is the item's usage key.
 */
export function rankedMatches<T extends Searchable>(
    query: string,
    items: readonly T[],
    limit: number,
    keyOf: (item: T) => string,
    uses: ReadonlyMap<string, number>
): T[] {
    return items
        .map((item, index) => ({ item, index, match: matchScore(query, item) }))
        .filter((entry) => entry.match > 0)
        .map((entry) => ({ ...entry, score: entry.match + useBoost(uses.get(keyOf(entry.item)) ?? 0) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit)
        .map((entry) => entry.item);
}

/** The search engines a web search can go to, the first the default. */
export const SEARCH_ENGINES = {
    google: { name: "Google", url: "https://www.google.com/search?q=" },
    duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
    bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
    brave: { name: "Brave Search", url: "https://search.brave.com/search?q=" },
    startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?q=" }
} as const;

export type SearchEngine = keyof typeof SEARCH_ENGINES;

export const SEARCH_ENGINE_IDS = Object.keys(SEARCH_ENGINES) as [SearchEngine, ...SearchEngine[]];

/** Where a web search goes until somebody picks another engine. */
export const DEFAULT_SEARCH_ENGINE: SearchEngine = "google";

/**
 * The engine a web search goes to: what somebody chose, else the default.
 * DuckDuckGo used to be the default and every saved settings file carries it
 * whether or not anybody picked it, so it only counts with the marker a choice
 * made since then writes. Any other engine was always somebody's pick.
 */
export function launcherEngineOf(stored: SearchEngine, chosen: boolean): SearchEngine {
    return chosen || stored !== "duckduckgo" ? stored : DEFAULT_SEARCH_ENGINE;
}

export function webSearchUrl(engine: SearchEngine, query: string): string {
    return `${SEARCH_ENGINES[engine].url}${encodeURIComponent(query.trim())}`;
}
