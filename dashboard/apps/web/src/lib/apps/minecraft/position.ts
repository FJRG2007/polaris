/**
 * Where a player is standing, out of what the server answers.
 *
 * `data get entity <player> Pos` replies with a three-number SNBT list and
 * `... Dimension` with a namespaced string, so both are read the same way the
 * inventory is - see ./snbt.
 *
 * Two questions rather than one because `data get entity <player>` returns the
 * whole entity: hundreds of lines through RCON to learn three numbers.
 */

import { readBalanced, readFloat, splitTopLevel, unquote } from "./snbt";

/** Where somebody is, as the server has it. */
export interface PlayerPosition {
    /** Exactly as reported - fractions and all, because that is what was said. */
    readonly x: number;
    readonly y: number;
    readonly z: number;
    /** "minecraft:overworld" and the like, or null when it was not asked or not
     *  answered. */
    readonly dimension: string | null;
}

/** The three vanilla worlds in the words the game uses. A custom dimension keeps
 *  its id, which is the only name its operator has for it. */
const DIMENSIONS: Readonly<Record<string, string>> = {
    "minecraft:overworld": "Overworld",
    "minecraft:the_nether": "The Nether",
    "minecraft:the_end": "The End"
};

/**
 * The coordinates in a `data get entity ... Pos` reply, or null.
 *
 * Null rather than zeroes for anything that is not one - a player who logged out
 * mid-request, a server that refused. 0 0 0 is a real place somebody could be
 * standing, so it must never be what "we do not know" looks like.
 */
export function parsePosition(output: string): { x: number; y: number; z: number } | null {
    const start = output.indexOf("[");
    if (start === -1) return null;
    const list = readBalanced(output, start);
    if (list === null) return null;
    const values = splitTopLevel(list.slice(1, -1)).map((part) => readFloat(part));
    if (values.length !== 3) return null;
    const [x, y, z] = values;
    if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") return null;
    return { x, y, z };
}

/** The world in a `data get entity ... Dimension` reply, or null. */
export function parseDimension(output: string): string | null {
    const colon = output.indexOf(":");
    if (colon === -1) return null;
    // The reply is `<name> has the following entity data: "minecraft:overworld"`,
    // so the value is whatever follows the sentence's own colon - and the id
    // inside it carries a second one, which is why this splits on the first only.
    const value = unquote(output.slice(colon + 1).trim());
    return /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value) ? value : null;
}

/** A dimension in words. */
export function dimensionLabel(id: string): string {
    return DIMENSIONS[id] ?? id;
}

/**
 * The coordinates as somebody writes them down: whole blocks, space separated.
 *
 * Floored rather than rounded, so they name the block being stood in - which is
 * what the game's own debug screen shows and what gets pasted into a `tp`.
 */
export function formatCoordinates(position: { x: number; y: number; z: number }): string {
    return [position.x, position.y, position.z].map((value) => Math.floor(value)).join(" ");
}
