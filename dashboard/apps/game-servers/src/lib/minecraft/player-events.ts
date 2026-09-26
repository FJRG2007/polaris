/**
 * What the side panel and announcements can say about the players beyond who is
 * online: who died last and how, and everybody's level.
 *
 * The last death is read out of the server's log, where the game writes every
 * death message as it happens, and recognised against the game's own templates
 * (`death-messages`) rather than guessed from the shape of a line - so a chat
 * message that happens to read "Steve fell" is never one. It is kept on the
 * install once seen, because the log starts again with every restart.
 *
 * Levels are one command for everybody at once, answered a line a player.
 *
 * Pure: the commands to send and the reading of what comes back. Sending is the
 * caller's.
 */

import { z } from "zod";
import { stripFormatting } from "./parse";
import { DEATH_TEMPLATES } from "./death-messages";

/** Where the last death is kept on the install. */
export const LAST_DEATH_KEY = "lastDeath";

/** The server's log, as the container has it. */
export const SERVER_LOG = "/data/logs/latest.log";

/** How much of the end of the log is read for the last death. A death a few
 *  hundred lines back is still in it; one older than that is already kept. */
export const DEATH_LOG_BYTES = 65_536;

/** Every player's level, a line each. */
export const LEVELS_COMMAND = "execute as @a run data get entity @s XpLevel";

export interface LastDeath {
    readonly player: string;
    /** The message as the game wrote it: "Steve fell from a high place". */
    readonly message: string;
    /** When Polaris first saw it, in ms. */
    readonly at: number;
}

const lastDeathSchema = z.object({
    player: z.string().min(1).max(40),
    message: z.string().min(1).max(256),
    at: z.number().int().nonnegative()
});

/** The last death kept on the install, or null. Anything malformed is none. */
export function readLastDeath(config: Record<string, unknown>): LastDeath | null {
    const parsed = lastDeathSchema.safeParse(config[LAST_DEATH_KEY]);
    return parsed.success ? parsed.data : null;
}

/** A player's name as a log line writes it: a Java name, or a Bedrock one
 *  carried over with a prefix of its own. */
const NAME = "[A-Za-z0-9_.*]{1,20}";

function escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One pattern per template: the victim captured, anything else matched. */
const PATTERNS: readonly RegExp[] = DEATH_TEMPLATES.map((template) => {
    const rest = template.slice("%1$s ".length);
    const body = escape(rest).replace(/%\d\\\$s/g, ".+");
    return new RegExp(`^(${NAME}) ${body}$`);
});

/** Who died, if this message is a death message. */
export function deathIn(message: string): { player: string; message: string } | null {
    const text = stripFormatting(message).trim();
    for (const pattern of PATTERNS) {
        const found = pattern.exec(text);
        if (found) return { player: found[1] as string, message: text };
    }
    return null;
}

/**
 * The last death in a stretch of the log, or null.
 *
 * What a line says is what follows its first "]: ", which is the same for the
 * vanilla log and Paper's. A chat line reads "<Steve> ..." there, so nothing a
 * player types can pass for a death.
 */
export function lastDeathInLog(log: string): { player: string; message: string } | null {
    const lines = log.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] as string;
        const at = line.indexOf("]: ");
        if (at < 0) continue;
        const death = deathIn(line.slice(at + 3));
        if (death) return death;
    }
    return null;
}

export interface PlayerLevel {
    readonly name: string;
    readonly level: number;
}

/** Everybody's level out of `LEVELS_COMMAND`, highest first. */
export function readLevels(output: string): PlayerLevel[] {
    const found: PlayerLevel[] = [];
    const pattern = /^(\S{1,40}) has the following entity data: (\d+)/gm;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        found.push({ name: match[1] as string, level: Number(match[2]) });
    }
    return found.sort((left, right) => right.level - left.level || left.name.localeCompare(right.name));
}

/** One player's level as it reads on a line. */
export function levelText(player: PlayerLevel): string {
    return `${player.name} Lv ${player.level}`;
}

/** The variable that becomes a line a player on the side panel. */
export const LEVELS_VARIABLE = "server.levels";

/**
 * The panel's lines with the one that shows `{server.levels}` written out once
 * per player, highest first, in whatever colours that line has around it.
 *
 * Only the first such line is spread out; the panel has one list of players,
 * not two. It takes the room the other lines leave, and past that the last row
 * says how many more there are rather than dropping them without a word.
 */
export function spreadLevelLines(
    lines: readonly string[],
    rows: readonly string[],
    max: number
): string[] {
    const token = /\{\s*server\.levels\s*(?:\|\s*"[^"{}]*"\s*)?\}/i;
    const at = lines.findIndex((line) => token.test(line));
    if (at < 0) return [...lines];
    const room = Math.max(1, max - (lines.length - 1));
    const shown =
        rows.length > room
            ? [...rows.slice(0, room - 1), `+${rows.length - (room - 1)} more`]
            : rows;
    // Nobody online: the line stays as it is, and its fallback says so.
    if (shown.length === 0) return [...lines];
    const line = lines[at] as string;
    return [
        ...lines.slice(0, at),
        ...shown.map((row) => line.replace(token, row)),
        ...lines.slice(at + 1)
    ];
}
