/**
 * The way up to something built in the sky: where its beam of light stands on
 * the ground, and who counts as standing in it.
 *
 * Two rules, both learned on a live server where the beam came down on the
 * corner of a house and only worked at the height of its roof - players had
 * to build up to it:
 *
 * - **Its height is the ground of its own column**, read by the heightmap
 *   there (`commands.summonOnGround`), never the top of a footprint, a
 *   neighbouring roof or where a player stands.
 * - **Stepping in is generous**: anywhere within `ENTRY_RADIUS` of the column,
 *   from `ENTRY_BELOW` under its ground to `ENTRY_ABOVE` over it, so a step, a
 *   slope or a jump never keeps anybody out.
 *
 * New runs take everybody up instead; a run that already has its beam keeps
 * it. Pure: asserted in tests.
 */

import * as stage from "./stage";

type Point = { readonly x: number; readonly y: number; readonly z: number };

/** Blocks from the beam's column to the edge of where stepping in counts. */
export const ENTRY_RADIUS = 2;
/** How far under the ground at the beam a player still counts as in it. */
export const ENTRY_BELOW = 2;
/** How far over the ground at the beam a player still counts as in it. */
export const ENTRY_ABOVE = 6;

/**
 * Who is standing in the beam and not up yet: anybody whose body is inside the
 * box `ENTRY_RADIUS` round its column, from `ENTRY_BELOW` under its ground to
 * `ENTRY_ABOVE` over it. A volume selector (`dx`/`dy`/`dz`, every version from
 * 1.13) - it keeps to the world it is asked in, the Overworld.
 */
export function inEntry(lift: Point): string {
    const box = [
        `x=${lift.x - ENTRY_RADIUS}`,
        `y=${lift.y - ENTRY_BELOW}`,
        `z=${lift.z - ENTRY_RADIUS}`,
        `dx=${2 * ENTRY_RADIUS}`,
        `dy=${ENTRY_BELOW + ENTRY_ABOVE}`,
        `dz=${2 * ENTRY_RADIUS}`
    ].join(",");
    return `execute in minecraft:overworld as @a[${box},tag=!${stage.IN_ARENA},gamemode=!creative,gamemode=!spectator] run data get entity @s Pos`;
}

/** A player's size, as the game measures it standing. */
const WIDTH = 0.6;
const HEIGHT = 1.8;

/**
 * Whether a player with their feet at `at` is counted in the beam by `inEntry`:
 * the game takes the selector's box from its corner to `d + 1` past it, and
 * counts anybody whose body touches it.
 */
export function standsIn(lift: Point, at: Point): boolean {
    const touches = (from: number, size: number, low: number, high: number) =>
        from + size > low && from < high;
    return (
        touches(at.x - WIDTH / 2, WIDTH, lift.x - ENTRY_RADIUS, lift.x + ENTRY_RADIUS + 1) &&
        touches(at.z - WIDTH / 2, WIDTH, lift.z - ENTRY_RADIUS, lift.z + ENTRY_RADIUS + 1) &&
        touches(at.y, HEIGHT, lift.y - ENTRY_BELOW, lift.y + ENTRY_ABOVE + 1)
    );
}
