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
 * Its spot is chosen in open ground (`rankEntries`): flat across the whole of
 * where stepping in counts, nothing built within `BUILT_MARGIN` of it, no
 * water or lava, nearest the players first. Pure: asserted in tests.
 */

import * as stage from "./stage";

type Point = { readonly x: number; readonly y: number; readonly z: number };
type Column2 = { readonly x: number; readonly z: number };

/** Blocks from the beam's column to the edge of where stepping in counts. */
export const ENTRY_RADIUS = 2;
/** How far under the ground at the beam a player still counts as in it. */
export const ENTRY_BELOW = 2;
/** How far over the ground at the beam a player still counts as in it. */
export const ENTRY_ABOVE = 6;
/** How far past the edge of the entry nothing anybody built may stand. */
export const BUILT_MARGIN = 4;
/** The most the ground across the entry may rise or fall. */
export const FLAT_SPREAD = 2;

/** The rings it is looked for in, nearest the players first: how far out each
 *  reaches and how far apart its columns are read. */
export const ENTRY_RINGS: readonly { readonly half: number; readonly step: number }[] = [
    { half: 10, step: 2 },
    { half: 24, step: 3 }
];

/** How many of the best spots are checked for a walk there before a ring is given up. */
export const WALK_CHECKS = 3;

/** Every column of a ring's square, `step` apart, the players' center among them. */
export function entryColumns(
    center: Column2,
    ring: { readonly half: number; readonly step: number }
): Column2[] {
    const offsets: number[] = [];
    const steps = Math.floor(ring.half / ring.step);
    for (let at = -steps; at <= steps; at += 1) offsets.push(at * ring.step);
    return offsets.flatMap((dx) => offsets.map((dz) => ({ x: center.x + dx, z: center.z + dz })));
}

/**
 * What one column was read to be: where its ground is (null when nothing came
 * down there - a column not loaded), and what that ground is - the world's own,
 * a tree, open water or lava, or something somebody built.
 */
export interface EntryColumn {
    readonly x: number;
    readonly z: number;
    readonly y: number | null;
    readonly kind: "ground" | "tree" | "wet" | "built";
}

export interface EntrySpot {
    readonly point: Point;
    /** Lower is better: further from the players, and less flat, cost more. */
    readonly score: number;
}

/**
 * Every column that would do for the beam, best first. A column does when
 * every column read within `ENTRY_RADIUS` of it (at least the ones next to it
 * on the grid) is the world's own dry ground, all within `FLAT_SPREAD` of each
 * other, and nothing built stands within `ENTRY_RADIUS + BUILT_MARGIN`. A
 * neighbour not read at all - the edge of the ring, a column not loaded - is
 * not known, and the column is passed over.
 */
export function rankEntries(
    center: Column2,
    columns: readonly EntryColumn[],
    step: number
): EntrySpot[] {
    const key = (x: number, z: number) => `${x},${z}`;
    const at = new Map(columns.map((one) => [key(one.x, one.z), one]));
    const near = Math.max(1, Math.ceil(ENTRY_RADIUS / step));
    const clear = ENTRY_RADIUS + BUILT_MARGIN;
    const built = columns.filter((one) => one.kind === "built");
    const spots: EntrySpot[] = [];
    for (const one of columns) {
        if (one.kind !== "ground" || one.y === null) continue;
        if (
            built.some(
                (other) => Math.max(Math.abs(other.x - one.x), Math.abs(other.z - one.z)) <= clear
            )
        )
            continue;
        let low = one.y;
        let high = one.y;
        let fine = true;
        for (let dx = -near; dx <= near && fine; dx += 1) {
            for (let dz = -near; dz <= near && fine; dz += 1) {
                const other = at.get(key(one.x + dx * step, one.z + dz * step));
                if (!other || other.kind !== "ground" || other.y === null) {
                    fine = false;
                    break;
                }
                low = Math.min(low, other.y);
                high = Math.max(high, other.y);
            }
        }
        if (!fine || high - low > FLAT_SPREAD) continue;
        const distance = Math.hypot(one.x - center.x, one.z - center.z);
        spots.push({ point: { x: one.x, y: one.y, z: one.z }, score: distance + 3 * (high - low) });
    }
    return spots.sort(
        (a, b) => a.score - b.score || a.point.x - b.point.x || a.point.z - b.point.z
    );
}

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
