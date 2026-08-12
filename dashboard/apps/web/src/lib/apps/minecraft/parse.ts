/**
 * Reading what a Minecraft server says back. Two sources, both of them the
 * server's own: the text RCON answers a command with, and the JSON files the
 * server keeps its roster in. Both are parsed here, away from the transport, so
 * the formats can be tested against real server output.
 */

import { z } from "zod";

/** Who is on the server right now, as `list` reports it. */
export interface PlayerList {
    readonly online: number;
    readonly max: number;
    readonly players: readonly string[];
}

/** A ban as the server recorded it. */
export interface BanEntry {
    readonly name: string;
    readonly reason: string | null;
    readonly source: string | null;
}

/** Minecraft colours its console output with section-sign codes, and a terminal
 *  in the middle may add ANSI on top. Neither is content. */
export function stripFormatting(text: string): string {
    return text.replace(/\[[0-9;]*m/g, "").replace(/[§&][0-9a-fk-orA-FK-OR]/g, "");
}

const MODERN_LIST = /There are (\d+) of a max of (\d+) players online:?(.*)/s;
// Bukkit and older releases answer with "There are 1/20 players online:".
const LEGACY_LIST = /There are (\d+)\/(\d+) players online:?(.*)/s;

/**
 * The `list` answer. Returns null when the text is not a player list at all -
 * an RCON error, an empty reply from a server still starting up, or a plugin
 * that replaced the command - which the caller reports as "not answering yet"
 * rather than as an empty server.
 */
export function parsePlayerList(output: string): PlayerList | null {
    const text = stripFormatting(output).trim();
    const match = MODERN_LIST.exec(text) ?? LEGACY_LIST.exec(text);
    if (!match) return null;
    const online = Number(match[1]);
    const max = Number(match[2]);
    if (!Number.isFinite(online) || !Number.isFinite(max)) return null;
    return { online, max, players: parseNameList(match[3] ?? "") };
}

/**
 * The most recent `list` answer in a console log. Bedrock has no RCON, so its
 * answer is not returned to the caller at all - it is printed to the server's own
 * console, where the newest one is the true one and the ones above it are
 * history.
 */
export function parsePlayerListFromLog(log: string): PlayerList | null {
    const lines = stripFormatting(log).split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? "";
        const counted = parsePlayerList(line);
        if (!counted) continue;
        // Bedrock prints the count and the names on separate lines. Only reach for
        // the line below when the count says there are names and this line carried
        // none - otherwise the next log line would be read as a player.
        if (counted.online > 0 && counted.players.length === 0) {
            const names = parseNameList(lines[index + 1] ?? "");
            return { ...counted, players: names };
        }
        return counted;
    }
    return null;
}

/** The trailing "Alice, Bob" of a list answer. Essentials-style suffixes and
 *  blank entries are dropped; a name Minecraft accepts has no spaces. */
function parseNameList(tail: string): string[] {
    return tail
        .split(",")
        .map((entry) => entry.trim().split(/\s+/)[0] ?? "")
        .filter((name) => name.length > 0 && name.length <= 32);
}

/** `whitelist list` answers "There are 2 whitelisted players: Alice, Bob". */
export function parseWhitelistAnswer(output: string): string[] {
    const text = stripFormatting(output).trim();
    const match = /whitelisted players:?(.*)/s.exec(text);
    return match ? parseNameList(match[1] ?? "") : [];
}

/** A player name as the server files record it. */
const playerNameSchema = z.string().trim().min(1).max(32);

/** `ops.json` and `whitelist.json` are both a list of players by name and uuid. */
const rosterFileSchema = z.array(z.object({ name: playerNameSchema }).passthrough()).catch([]);
const bansFileSchema = z
    .array(
        z
            .object({
                name: playerNameSchema,
                reason: z.string().max(512).nullish(),
                source: z.string().max(64).nullish()
            })
            .passthrough()
    )
    .catch([]);

/** Names out of `ops.json` / `whitelist.json`. An unreadable or half-written file
 *  reads as an empty roster rather than throwing: the file is written by the
 *  server while it runs, and a moderation screen that fails to open because a save
 *  was in flight would be worse than one that is briefly short a name. */
export function parseNameFile(content: string): string[] {
    return rosterFileSchema.parse(safeJson(content)).map((entry) => entry.name);
}

/** The addresses in `banned-ips.json`. */
export function parseBannedIps(content: string): string[] {
    return z
        .array(z.object({ ip: z.string().trim().min(1).max(64) }).passthrough())
        .catch([])
        .parse(safeJson(content))
        .map((entry) => entry.ip);
}

/** Entries out of `banned-players.json`, with why and by whom. */
export function parseBansFile(content: string): BanEntry[] {
    return bansFileSchema.parse(safeJson(content)).map((entry) => ({
        name: entry.name,
        reason: entry.reason ?? null,
        source: entry.source ?? null
    }));
}

/** `server.properties` as key/value pairs. Comment lines and anything without an
 *  `=` are skipped; the file is written by the server, but it is also the one
 *  file an operator may have edited by hand. */
export function parseProperties(content: string): Record<string, string> {
    const properties: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        const separator = trimmed.indexOf("=");
        if (separator <= 0) continue;
        properties[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    }
    return properties;
}

/**
 * The address each player last connected from, out of the server's own log.
 *
 * This is the only place a player's address appears: the roster files record who
 * may join, never from where, and RCON has no command that reports it. Java prints
 * it on the login line (`Alice[/203.0.113.9:52344] logged in`); Bedrock prints the
 * gamertag and XUID and no address at all, which is why address rules can only be
 * enforced on Java.
 *
 * The newest line wins - a player who reconnects from somewhere else is at the new
 * address, and judging them by the first line in the log would be judging where
 * they were an hour ago.
 */
export function parseJoinAddresses(log: string): Map<string, string> {
    const found = new Map<string, string>();
    const pattern = /([A-Za-z0-9_]{3,16})\[\/((?:\d{1,3}\.){3}\d{1,3}):\d+\]\s+logged in/g;
    for (const match of stripFormatting(log).matchAll(pattern)) {
        const [, name, address] = match;
        if (name && address) found.set(name.toLowerCase(), address);
    }
    return found;
}

/** Lines worth repeating out of a starting server's log: what the image says it
 *  is doing, and what it says went wrong. Everything else is the game's own
 *  chatter, which is what the console screen is for. */
const LOG_SIGNAL = /^(?:\S+\s+)?(?:\[init\]|\[mc-image-helper\]|.*\bERROR\b|.*\bWARN\b)/;

/**
 * Lines a server printed because Polaris asked it something, not because anything
 * went wrong.
 *
 * Polaris asks `list` over RCON every few seconds to know who is on. A server that
 * is still coming up, or on its way down, has no main thread to hand the command to
 * and runs it on the connection's own instead, and Paper answers that with a stack
 * trace and two red lines - every few seconds, for as long as the server is in that
 * state. Which is precisely the state of a server that will not start.
 *
 * So the loudest thing in a broken server's log is Polaris talking to itself, and
 * any rule that reads the last error line reads that: a real server was reported as
 * having died of "Asynchronous command dispatch", which is the question rather than
 * the answer. Recognised in one place because two rules quote log lines back to
 * people, and both have to skip these.
 */
export function isPollNoise(line: string): boolean {
    return /Asynchronous command dispatch|failed main thread check|while parsing console command/i.test(line);
}

/**
 * The last thing the container said that explains what it is doing, or null.
 *
 * A server takes real minutes to start the first time - it is fetching its own
 * jar and every plugin - and one that will never start looks exactly the same
 * from outside. The difference is in the log, one line of it, and this is that
 * line: the step the image is on, or the error it stopped at. Enough to tell a
 * slow boot from a boot loop without opening anything.
 */
export function lastStartupSignal(log: string): string | null {
    return (
        log
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && LOG_SIGNAL.test(line) && !isPollNoise(line))
            .at(-1) ?? null
    );
}

/**
 * What a starting server is doing right now, in words.
 *
 * "Starting" covers a span of minutes and several genuinely different things -
 * downloading a server, unpacking a map, installing plugins, building the world -
 * and while it is one word for all of them nobody can tell a server that is working
 * from one that is stuck. Especially on a map, where the wait includes a download
 * that is not the server's own.
 *
 * Read backwards for the last line that names a step, because the newest one is the
 * step it is on. Every phrase here is matched against a line these images actually
 * print; a log that says nothing recognisable gets null and the caller falls back
 * to quoting the line itself, which is what it did before any of this.
 */
const STARTUP_PHASES: readonly (readonly [RegExp, string])[] = [
    [/Done \(\d/, "Nearly there."],
    [/Preparing (?:level|start region|spawn area)/i, "Building the world."],
    [/Loading server plugin|Enabling [\w-]+ v/i, "Starting the plugins."],
    [/Starting minecraft server version|Loading libraries/i, "Loading the server."],
    [/\[init\] Starting the Minecraft server/i, "Handing over to the server."],
    [/\[init\] Copying any (?:plugins|configs)/i, "Putting the settings in place."],
    [/\[init\] Resolving type given|Downloading|\[mc-image-helper\]/i, "Downloading what it needs."],
    [/\[init\] Running as uid=/i, "Getting the container up."]
];

/** The step the server is on, or null when nothing in the log names one. */
export function startupPhase(log: string): string | null {
    const lines = stripFormatting(log)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !isPollNoise(line));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? "";
        const phase = STARTUP_PHASES.find(([pattern]) => pattern.test(line));
        if (phase) return phase[1];
    }
    return null;
}

/** The version the running server announced, from its startup log. Null when the
 *  log no longer reaches back that far. */
export function parseServerVersion(log: string): string | null {
    const matches = [...log.matchAll(/Starting minecraft server version (\S+)/g)];
    return matches.at(-1)?.[1] ?? null;
}

function safeJson(content: string): unknown {
    try {
        return JSON.parse(content);
    } catch {
        return [];
    }
}
