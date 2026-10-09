/**
 * A meteor's infection: the ground round where it came down grows sculk veins,
 * which creep outwards a little at a time; standing in them poisons and slows
 * whoever does, and breaking them cleanses the ground.
 *
 * Nothing of anybody's is touched, the way the meteor's own ore is placed
 * (`meteor-shower.ts`):
 *
 * - A vein goes only into air, over a block of the game's own ground
 *   (`#minecraft:sculk_replaceable` - stone, dirt, sand and the like, never a
 *   player's planks or glass), with `setblock ... keep`. Only a cell the game
 *   answers it changed is remembered as the event's.
 * - At the end a remembered cell is taken away only while it is still a vein
 *   (`removeIfVein`); one somebody broke - cleansed - is never touched again.
 * - It is bounded: a few cells looked at a tick for each meteor, never further
 *   than `RADIUS` from it, and two caps that stop it, counted apart: at most
 *   `MAX_CELLS` infected, and at most `MAX_MISSES` tried and missed.
 *
 * Sculk veins and the tag are 1.19's: on an older server a meteor leaves no
 * infection (`SINCE`).
 *
 * Pure: every line is a function of what it is given.
 */

type Point = { readonly x: number; readonly y: number; readonly z: number };

/** The version veins and the ground they grow on are the game's from. */
export const SINCE = [1, 19] as const;
/** How far from the meteor the infection may creep. */
export const RADIUS = 7;
/** The most cells one meteor ever infects, cleansed ones included. */
export const MAX_CELLS = 40;
/** The most cells one meteor tries and misses - air over air, inside the
 *  ground, a flower in the way - before it stops trying: kept apart from
 *  `MAX_CELLS`, so misses never shrink a crater that can grow. */
export const MAX_MISSES = 60;
/** Cells round the crater infected as the meteor lands. */
export const SEEDS = 6;
/** Cells tried, each tick, to creep onto, for each meteor. */
export const TRIES_PER_TICK = 2;
/** Cells tried each tick over every meteor together: one question to the game
 *  each, so a shower of thirty meteors costs no more than one of three. */
export const BUDGET = 6;

const VEIN = "minecraft:sculk_vein[down=true]";
const VEIN_ID = "minecraft:sculk_vein";
const GROUND = "#minecraft:sculk_replaceable";

const at = (point: Point) => `${point.x} ${point.y} ${point.z}`;

/** The crater's ring, two blocks out round where the meteor landed, at the
 *  height of the air over the ground it landed on - shuffled, the first
 *  `SEEDS` of them not already `missed`. */
export function seedCells(
    meteor: Point,
    random: () => number,
    missed: readonly Point[] = []
): Point[] {
    const tried = new Set(missed.map(at));
    const ring: Point[] = [];
    for (let dx = -2; dx <= 2; dx += 1)
        for (let dz = -2; dz <= 2; dz += 1)
            if (Math.max(Math.abs(dx), Math.abs(dz)) === 2) {
                const cell = { x: meteor.x + dx, y: meteor.y, z: meteor.z + dz };
                if (!tried.has(at(cell))) ring.push(cell);
            }
    for (let index = ring.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [ring[index], ring[other]] = [ring[other]!, ring[index]!];
    }
    return ring.slice(0, SEEDS);
}

/**
 * The next cells to try to creep onto: next to an infected cell (one a side,
 * a block up or down), within `RADIUS` of the meteor, not one already infected
 * or `missed`, and no more than the meteor has left to try. Each with the cell
 * it grows from, which must still be a vein for it to grow.
 */
export function creepCells(
    meteor: Point,
    infected: readonly Point[],
    random: () => number,
    missed: readonly Point[] = []
): { from: Point; to: Point }[] {
    const left = Math.min(TRIES_PER_TICK, MAX_CELLS - infected.length, MAX_MISSES - missed.length);
    if (left <= 0 || infected.length === 0) return [];
    const taken = new Set([...infected, ...missed].map(at));
    const picked: { from: Point; to: Point }[] = [];
    for (let tries = 0; tries < left * 6 && picked.length < left; tries += 1) {
        const from = infected[Math.floor(random() * infected.length)]!;
        const side = Math.floor(random() * 4);
        const dy = Math.floor(random() * 3) - 1;
        const to = {
            x: from.x + (side === 0 ? 1 : side === 1 ? -1 : 0),
            y: from.y + dy,
            z: from.z + (side === 2 ? 1 : side === 3 ? -1 : 0)
        };
        if (Math.max(Math.abs(to.x - meteor.x), Math.abs(to.z - meteor.z)) > RADIUS) continue;
        if (Math.abs(to.y - meteor.y) > 3) continue;
        if (taken.has(at(to))) continue;
        taken.add(at(to));
        picked.push({ from, to });
    }
    return picked;
}

/** One cell to try, of the meteor at `meteor` in the run's list. */
export interface Try {
    readonly meteor: number;
    readonly to: Point;
    readonly from?: Point;
}

/**
 * This tick's tries over every meteor, within `BUDGET`: a meteor with nothing
 * infected yet is seeded round its crater, the rest creep. A cell tried and
 * `missed` is never tried again and counts towards `MAX_MISSES`, so a crater
 * that cannot grow stops costing anything. The meteors taken in turn from
 * `turn`, so each gets its go however many there are.
 */
export function plan(
    meteors: readonly (Point & {
        readonly infected: readonly Point[];
        readonly missed?: readonly Point[];
    })[],
    turn: number,
    random: () => number
): Try[] {
    const tries: Try[] = [];
    for (let step = 0; step < meteors.length && tries.length < BUDGET; step += 1) {
        const index = (turn + step) % meteors.length;
        const meteor = meteors[index]!;
        const missed = meteor.missed ?? [];
        const cells =
            meteor.infected.length === 0
                ? seedCells(meteor, random, missed)
                      .slice(0, Math.max(0, MAX_MISSES - missed.length))
                      .map((to) => ({ to }))
                : creepCells(meteor, meteor.infected, random, missed);
        for (const cell of cells.slice(0, BUDGET - tries.length))
            tries.push({ meteor: index, ...cell });
    }
    return tries;
}

/** A vein into air over the game's own ground, and nowhere else - growing
 *  from `from` only while that is still a vein. */
export function growLine(to: Point, from?: Point): string {
    const still = from ? `if block ${at(from)} ${VEIN_ID} ` : "";
    return `execute in minecraft:overworld ${still}if block ${at(to)} minecraft:air if block ${to.x} ${to.y - 1} ${to.z} ${GROUND} run setblock ${at(to)} ${VEIN} keep`;
}

/** Whether the game answered a `growLine` with the block changed. */
export function grew(output: string): boolean {
    return /changed the block/i.test(output);
}

/** The cell cleared only while it is still a vein: one broken by a player was
 *  cleansed, and whatever is there now is theirs. */
export function removeIfVein(cell: Point): string {
    return `execute in minecraft:overworld if block ${at(cell)} ${VEIN_ID} run setblock ${at(cell)} minecraft:air`;
}

/** Whoever stands in a vein near this meteor, poisoned and slowed for a
 *  moment. Poison never takes the last half heart. */
export function hurtLines(meteor: Point): string[] {
    const near = `execute in minecraft:overworld positioned ${meteor.x + 0.5} ${meteor.y} ${meteor.z + 0.5}`;
    return [
        `${near} as @a[distance=..${RADIUS + 2}] at @s if block ~ ~ ~ ${VEIN_ID} run effect give @s minecraft:poison 3 0`,
        `${near} as @a[distance=..${RADIUS + 2}] at @s if block ~ ~ ~ ${VEIN_ID} run effect give @s minecraft:slowness 3 1`
    ];
}

/** A little spore over the infected ground, so it is seen from a way off -
 *  only while `vein`, one of its cells, is still a vein: a cleansed crater
 *  goes quiet. */
export function sporeLine(meteor: Point, vein: Point): string {
    return `execute in minecraft:overworld if block ${at(vein)} ${VEIN_ID} run particle minecraft:sculk_soul ${meteor.x + 0.5} ${meteor.y + 0.5} ${meteor.z + 0.5} ${RADIUS / 2} 0.3 ${RADIUS / 2} 0 6 normal`;
}
