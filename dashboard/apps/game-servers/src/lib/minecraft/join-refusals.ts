/**
 * Players a modded server turned away for the mods they joined with.
 *
 * A mod loader refuses a client whose mods do not match the server's: one that
 * lacks a mod the server needs on both sides, or that brings one the server
 * does not have. All it leaves behind is a line in the log that says
 * "Incompatible client!", which reads like a fault in the server rather than
 * what it nearly always is - a player whose game carries another server's mods,
 * or not this one's. The console says so beside it.
 *
 * Pure: it reads a log tail.
 */

/** The line a loader logs when it turns a client away for its mods. */
const INCOMPATIBLE = /incompatible client/i;

/** A player's name where the line carries one: "<name> lost connection: ...",
 *  or the profile the game prints with `name=`. */
const NAMED = [
    /\b([A-Za-z0-9_]{2,16}) (?:\(\/[^)]*\) )?lost connection:/,
    /\bname=([A-Za-z0-9_]{2,16})\b/
];

export interface JoinRefusals {
    /** How many lines in the tail turned somebody away. */
    readonly count: number;
    /** Who, where the log names them, without repeats, in the order seen. */
    readonly players: readonly string[];
}

/** The refusals in a log tail, or null when there are none. */
export function incompatibleClients(log: string): JoinRefusals | null {
    let count = 0;
    const players: string[] = [];
    for (const line of log.split("\n")) {
        if (!INCOMPATIBLE.test(line)) continue;
        count += 1;
        for (const pattern of NAMED) {
            const name = pattern.exec(line)?.[1];
            if (name && !players.includes(name)) {
                players.push(name);
                break;
            }
        }
    }
    return count > 0 ? { count, players } : null;
}
