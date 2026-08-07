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
