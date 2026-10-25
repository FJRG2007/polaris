/**
 * Ranks: the symbol, tag and colour a player's name carries in chat and in the
 * tab list - `⚔ [ADMIN] Steve`.
 *
 * Built on the game's own scoreboard teams rather than on a plugin, because a
 * team prefix is what vanilla, Paper and NeoForge all draw in front of a name
 * in chat and in the tab list, and teams are reachable through the console on
 * every Java server Polaris runs. Neither the Polaris plugin nor the mod formats
 * chat or the tab list, so nothing competes with it. Bedrock has no `team`
 * command at all, so ranks are Java only and the screen says why.
 *
 * The tab list sorts players by the name of their team, so each rank's team is
 * named after its place in the list (`pr01_admin`): moving a rank up moves its
 * players up. Teams persist in the world, and a player joined to a team keeps it
 * across visits, but Polaris applies them again on save, on start and on join -
 * every command here is safe to send twice.
 *
 * Pure, and safe in the browser: the screen validates with the same schema and
 * previews with the same runs the server is sent.
 */

import { z } from "zod";
import { gameMessage } from "../game-message";

export const RANKS_KEY = "ranks";
export const MAX_RANKS = 20;
export const MAX_RANK_PLAYERS = 200;
export const MAX_RANKED_PLAYERS = 500;
export const NAME_MAX = 32;
export const TAG_MAX = 16;
export const SYMBOL_MAX = 2;
export const ID_MAX = 11;

/** The sixteen colours a team can give a name, by the names every version reads,
 *  with the MOTD palette key that holds their hex and their words. */
export const RANK_COLORS = {
    black: "0",
    dark_blue: "1",
    dark_green: "2",
    dark_aqua: "3",
    dark_red: "4",
    dark_purple: "5",
    gold: "6",
    gray: "7",
    dark_gray: "8",
    blue: "9",
    green: "a",
    aqua: "b",
    red: "c",
    light_purple: "d",
    yellow: "e",
    white: "f"
} as const;

export type RankColor = keyof typeof RANK_COLORS;
const COLOR_NAMES = Object.keys(RANK_COLORS) as [RankColor, ...RankColor[]];

/** Symbols the game's default font draws, for the picker. Any other short
 *  symbol may still be typed. */
export const RANK_SYMBOLS: readonly string[] = [
    "⚔",
    "✦",
    "◆",
    "★",
    "✪",
    "♛",
    "♦",
    "❖",
    "☠",
    "⚡",
    "❤",
    "✚",
    "☀",
    "✿",
    "♠",
    "⛏"
];

/** A Java name, or a Bedrock player through Floodgate (`.Name`). */
export const PLAYER_NAME = /^\.?[A-Za-z0-9_]{1,16}$/;
const ID = /^[a-z0-9_]{1,11}$/;
/** What a team name may be on every version: the unquoted characters, and at
 *  most sixteen of them, which servers before 1.18 enforce. */
const TEAM_NAME = /^[A-Za-z0-9_.+-]{1,16}$/;
/** Nothing a line of text in the game cannot hold, and no section sign, which
 *  older clients read as formatting. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}§]/u;
const UNSAFE_TEXT_ALL = new RegExp(UNSAFE_TEXT.source, "gu");

/** One normalizer for the screen and the server: trimmed, single spaces. */
export function cleanText(value: unknown): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

const text = (max: number, required: boolean) =>
    z.preprocess(
        cleanText,
        z
            .string()
            .min(required ? 1 : 0, { message: gameMessage("minecraft", "ranks.errors.required") })
            .refine((value) => [...value].length <= max, {
                message: gameMessage("minecraft", "ranks.errors.tooLong", { max })
            })
            .refine((value) => !UNSAFE_TEXT.test(value), {
                message: gameMessage("minecraft", "ranks.errors.badCharacters")
            })
    );

const playerName = z.preprocess(
    cleanText,
    z.string().regex(PLAYER_NAME, { message: gameMessage("minecraft", "ranks.errors.badPlayer") })
);

export const rankSchema = z.object({
    id: z.string().regex(ID),
    name: text(NAME_MAX, true),
    tag: text(TAG_MAX, true),
    symbol: text(SYMBOL_MAX, false).refine((value) => !/\s/.test(value), {
        message: gameMessage("minecraft", "ranks.errors.badCharacters")
    }),
    color: z.enum(COLOR_NAMES),
    bold: z.boolean(),
    players: z.array(playerName).max(MAX_RANK_PLAYERS),
    /** The server team this rank was imported from, replaced by it on save. */
    source: z.string().regex(TEAM_NAME).optional()
});

export type Rank = z.infer<typeof rankSchema>;

export const ranksSchema = z
    .array(rankSchema)
    .max(MAX_RANKS, {
        message: gameMessage("minecraft", "ranks.errors.tooMany", { max: MAX_RANKS })
    })
    .superRefine((ranks, context) => {
        const ids = new Set<string>();
        const players = new Map<string, string>();
        let total = 0;
        ranks.forEach((rank, index) => {
            if (ids.has(rank.id))
                context.addIssue({
                    code: "custom",
                    path: [index, "id"],
                    message: gameMessage("minecraft", "ranks.errors.duplicate")
                });
            ids.add(rank.id);
            rank.players.forEach((player, at) => {
                total += 1;
                const key = player.toLowerCase();
                const other = players.get(key);
                if (other !== undefined)
                    context.addIssue({
                        code: "custom",
                        path: [index, "players", at],
                        message: gameMessage("minecraft", "ranks.errors.twice", {
                            player,
                            rank: other
                        })
                    });
                else players.set(key, rank.name);
            });
        });
        if (total > MAX_RANKED_PLAYERS)
            context.addIssue({
                code: "custom",
                path: [],
                message: gameMessage("minecraft", "ranks.errors.tooManyPlayers", {
                    max: MAX_RANKED_PLAYERS
                })
            });
    });

/** What was last sent, so the next apply can undo what is no longer wanted. */
export interface AppliedRanks {
    readonly teams: readonly string[];
    readonly players: readonly string[];
}

export interface RanksState {
    readonly ranks: readonly Rank[];
    readonly applied: AppliedRanks;
}

export const NO_RANKS: RanksState = { ranks: [], applied: { teams: [], players: [] } };

/** The stored ranks, or none for a config that holds none or holds something
 *  that no longer passes the schema. */
export function readRanks(config: Record<string, unknown>): RanksState {
    const raw = config[RANKS_KEY];
    if (typeof raw !== "object" || raw === null) return NO_RANKS;
    const row = raw as Record<string, unknown>;
    const ranks = ranksSchema.safeParse(row.ranks);
    const applied = (row.applied ?? {}) as Record<string, unknown>;
    const names = (value: unknown, pattern: RegExp): string[] =>
        Array.isArray(value)
            ? value.filter((one): one is string => typeof one === "string" && pattern.test(one))
            : [];
    return {
        ranks: ranks.success ? ranks.data : [],
        applied: {
            teams: names(applied.teams, TEAM_NAME),
            players: names(applied.players, PLAYER_NAME)
        }
    };
}

/** A rank id from its name: lowercase letters, digits and underscores, unique
 *  among `taken`. */
export function rankId(name: string, taken: readonly string[]): string {
    const base =
        cleanText(name)
            .normalize("NFKD")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, ID_MAX) || "rank";
    if (!taken.includes(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${base.slice(0, ID_MAX - String(suffix).length)}${suffix}`;
        if (!taken.includes(candidate)) return candidate;
    }
}

/** The team a rank is kept in, named after its place so the tab list sorts by it. */
export function teamName(rank: Pick<Rank, "id">, position: number): string {
    return `pr${String(position + 1).padStart(2, "0")}_${rank.id}`;
}

/** Whether a team on the server is one Polaris named for a rank. */
export function isRankTeam(name: string): boolean {
    return /^pr\d{2}_[a-z0-9_]{1,11}$/.test(name);
}

/** One styled run of the prefix, as the preview draws it and the game is sent it. */
export interface RankRun {
    readonly text: string;
    readonly color: RankColor | null;
    readonly bold: boolean;
}

/** The prefix a rank puts before a name: the symbol, the bracketed tag, a space. */
export function prefixRuns(rank: Pick<Rank, "symbol" | "tag" | "color" | "bold">): RankRun[] {
    const runs: RankRun[] = [];
    if (rank.symbol) runs.push({ text: `${rank.symbol} `, color: rank.color, bold: false });
    runs.push({ text: `[${rank.tag}]`, color: rank.color, bold: rank.bold });
    runs.push({ text: " ", color: null, bold: false });
    return runs;
}

/**
 * The prefix as a text component. The runs are children of an empty root, never
 * an array, because in an array every element inherits the first one's style
 * and a bold tag would make the name after it bold too.
 *
 * `JSON.stringify` does all of the escaping: a quote or backslash in a tag is
 * escaped, and no control character can reach it (the schema refuses them).
 * The same text is valid SNBT, which 1.21.5 and later read components as.
 */
export function prefixComponent(rank: Pick<Rank, "symbol" | "tag" | "color" | "bold">): string {
    return JSON.stringify({
        text: "",
        extra: prefixRuns(rank).map((run) => ({
            text: run.text,
            ...(run.color ? { color: run.color } : {}),
            ...(run.bold ? { bold: true } : {})
        }))
    });
}

/** Every command that makes the server match `ranks`, given what was sent last
 *  time. Safe to send again: each one either changes nothing or fails harmlessly
 *  ("already exists"). */
export function rankCommands(ranks: readonly Rank[], applied: AppliedRanks): string[] {
    const setup: string[] = [];
    const joins: string[] = [];
    const wanted = new Set<string>();
    const ranked = new Set<string>();
    ranks.forEach((rank, position) => {
        const team = teamName(rank, position);
        wanted.add(team);
        setup.push(
            `team add ${team}`,
            `team modify ${team} displayName ${JSON.stringify({ text: rank.name })}`,
            `team modify ${team} prefix ${prefixComponent(rank)}`,
            `team modify ${team} color ${rank.color}`
        );
        for (const player of rank.players) {
            ranked.add(player.toLowerCase());
            joins.push(`team join ${team} ${player}`);
        }
    });
    const leaves = applied.players
        .filter((player) => !ranked.has(player.toLowerCase()))
        .map((player) => `team leave ${player}`);
    // Removed last, once their players are in the team that replaces them.
    const removes = [
        ...applied.teams.filter((team) => !wanted.has(team)),
        ...ranks.flatMap((rank) => (rank.source && !wanted.has(rank.source) ? [rank.source] : []))
    ];
    return [
        ...setup,
        ...joins,
        ...leaves,
        ...[...new Set(removes)].map((team) => `team remove ${team}`)
    ];
}

/** What a later apply needs to know about this one. */
export function appliedBy(ranks: readonly Rank[]): AppliedRanks {
    return {
        teams: ranks.map((rank, position) => teamName(rank, position)),
        players: ranks.flatMap((rank) => rank.players)
    };
}

/** The stored ranks once applied: the teams they came from are gone, so they no
 *  longer name one. */
export function withoutSources(ranks: readonly Rank[]): Rank[] {
    return ranks.map(({ source: _source, ...rank }) => rank);
}

/** The commands for players who have just joined: their rank's team, nothing for
 *  anybody without one. */
export function joinCommands(ranks: readonly Rank[], players: readonly string[]): string[] {
    const teamOf = new Map<string, string>();
    ranks.forEach((rank, position) => {
        for (const player of rank.players)
            teamOf.set(player.toLowerCase(), teamName(rank, position));
    });
    return players.flatMap((player) => {
        const team = teamOf.get(player.toLowerCase());
        return team && PLAYER_NAME.test(player) ? [`team join ${team} ${player}`] : [];
    });
}

/** Which teams saving would remove that Polaris did not create: the ones the
 *  operator adopted on import. The save dialog lists them. */
export function replacedTeams(ranks: readonly Rank[]): string[] {
    const wanted = new Set(ranks.map((rank, position) => teamName(rank, position)));
    return [
        ...new Set(
            ranks.flatMap((rank) => (rank.source && !wanted.has(rank.source) ? [rank.source] : []))
        )
    ];
}

/** Whether a command answer is the game refusing it, rather than an answer that
 *  only says nothing changed. */
export function refusedAnswer(answer: string): boolean {
    if (/already exists|nothing changed|already|is not on a team|no team/i.test(answer))
        return false;
    return /unknown|incorrect|invalid|expected|cannot be found|not found|error/i.test(answer);
}

// ---------------------------------------------------------------- import

/** A team as the server's scoreboard file holds it, already decoded. */
export interface ServerTeam {
    readonly name: string;
    readonly displayName: unknown;
    readonly prefix: unknown;
    readonly color: string | null;
    readonly players: readonly string[];
}

/** The text runs of a component in any of the shapes a server stores: a JSON
 *  string (up to 1.21.4), a compound or list (1.21.5 on), or legacy `§` text. */
export function componentRuns(
    value: unknown,
    inherited: { color: string | null; bold: boolean } = { color: null, bold: false }
): { text: string; color: string | null; bold: boolean }[] {
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (
            (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) &&
            trimmed.length > 1
        ) {
            try {
                return componentRuns(JSON.parse(trimmed), inherited);
            } catch {
                // Not JSON: plain or legacy text.
            }
        }
        return legacyRuns(value, inherited);
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return [];
        // An array is its first element with the rest as its children.
        const [first, ...rest] = value;
        const head = componentRuns(first, inherited);
        const style = styleOf(first, inherited);
        return [...head, ...rest.flatMap((one) => componentRuns(one, style))];
    }
    if (typeof value === "object" && value !== null) {
        const node = value as Record<string, unknown>;
        const style = styleOf(node, inherited);
        const own = typeof node.text === "string" ? legacyRuns(node.text, style) : [];
        const extra = Array.isArray(node.extra)
            ? node.extra.flatMap((one) => componentRuns(one, style))
            : [];
        return [...own, ...extra];
    }
    return [];
}

function styleOf(value: unknown, inherited: { color: string | null; bold: boolean }) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return inherited;
    const node = value as Record<string, unknown>;
    return {
        color: typeof node.color === "string" ? node.color : inherited.color,
        bold: node.bold === undefined ? inherited.bold : node.bold === true || node.bold === 1
    };
}

const LEGACY_COLORS = Object.fromEntries(
    Object.entries(RANK_COLORS).map(([name, code]) => [code, name])
) as Record<string, RankColor>;

function legacyRuns(value: string, inherited: { color: string | null; bold: boolean }) {
    const runs: { text: string; color: string | null; bold: boolean }[] = [];
    let style = { ...inherited };
    for (const [index, part] of value.split(/§/).entries()) {
        if (index === 0) {
            if (part) runs.push({ text: part, ...style });
            continue;
        }
        const code = part.charAt(0).toLowerCase();
        if (LEGACY_COLORS[code]) style = { color: LEGACY_COLORS[code]!, bold: false };
        else if (code === "l") style = { ...style, bold: true };
        else if (code === "r") style = { color: null, bold: false };
        const rest = part.slice(1);
        if (rest) runs.push({ text: rest, ...style });
    }
    return runs;
}

function asColor(value: string | null | undefined): RankColor | null {
    return value && value in RANK_COLORS ? (value as RankColor) : null;
}

/**
 * A server team as a rank to edit: the symbol and tag read out of its prefix,
 * its colour from the prefix or the team, its players as they are. Polaris's own
 * teams are skipped - they are the ranks already - and so is a team no name can
 * be made of.
 */
export function rankFromTeam(team: ServerTeam, taken: readonly string[]): Rank | null {
    if (isRankTeam(team.name) || !TEAM_NAME.test(team.name)) return null;
    const runs = componentRuns(team.prefix).filter((run) => run.text.length > 0);
    const plain = runs
        .map((run) => run.text)
        .join("")
        .replace(UNSAFE_TEXT_ALL, "")
        .replace(/\s+/g, " ")
        .trim();
    const displayName = cleanText(
        componentRuns(team.displayName)
            .map((run) => run.text)
            .join("")
    ).replace(UNSAFE_TEXT_ALL, "");
    let symbol = "";
    let tag = plain;
    const bracketed = /^(?:(\S{1,2})\s+)?[[(](.+?)[\])]$/u.exec(plain);
    if (bracketed) {
        symbol = bracketed[1] ?? "";
        tag = bracketed[2] ?? "";
    }
    tag = cleanText(tag) || displayName || team.name;
    tag = [...tag].slice(0, TAG_MAX).join("").trim();
    if ([...symbol].length > SYMBOL_MAX) symbol = "";
    const tagRun = runs.find((run) => run.text.includes(tag)) ?? runs[0];
    const color = asColor(tagRun?.color) ?? asColor(team.color) ?? "white";
    const name = [...(displayName || team.name)].slice(0, NAME_MAX).join("").trim() || team.name;
    const candidate = {
        id: rankId(name, taken),
        name,
        tag,
        symbol,
        color,
        bold: tagRun?.bold ?? false,
        players: team.players
            .filter((player) => PLAYER_NAME.test(player))
            .slice(0, MAX_RANK_PLAYERS),
        source: team.name
    };
    const parsed = rankSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

/** Every server team that can become a rank, with ids unique among `existing`. */
export function ranksFromTeams(teams: readonly ServerTeam[], existing: readonly Rank[]): Rank[] {
    const taken = existing.map((rank) => rank.id);
    const found: Rank[] = [];
    for (const team of teams) {
        if (existing.some((rank) => rank.source === team.name)) continue;
        const rank = rankFromTeam(team, taken);
        if (!rank) continue;
        taken.push(rank.id);
        found.push(rank);
    }
    return found;
}

/** The teams in a decoded `scoreboard.dat` (`data.Teams`), as far as each can be
 *  read; a malformed entry is skipped, never guessed at. */
export function teamsFromScoreboard(root: Record<string, unknown>): ServerTeam[] {
    const data = root.data;
    if (typeof data !== "object" || data === null) return [];
    const list = (data as Record<string, unknown>).Teams;
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry): ServerTeam[] => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
        const team = entry as Record<string, unknown>;
        if (typeof team.Name !== "string") return [];
        return [
            {
                name: team.Name,
                displayName: team.DisplayName ?? null,
                prefix: team.MemberNamePrefix ?? null,
                color: typeof team.TeamColor === "string" ? team.TeamColor : null,
                players: Array.isArray(team.Players)
                    ? team.Players.filter((one): one is string => typeof one === "string")
                    : []
            }
        ];
    });
}
