/**
 * SkyWars' islands, their chests and the rules of the play area.
 *
 * One island per player in a ring round a bigger one in the middle, all drawn
 * from the run's id (`layoutFor`). Each is a blob with a wavy edge - grass on
 * top, dirt under it, stone tapering to a point below, flecked with andesite
 * and ore - with a tree or a mossy boulder and flowers on it, an invisible cage
 * round its start that comes down at "Go!", and two chests; the middle one is
 * wider, has a tree at its heart and four chests with better loot. What every
 * chest holds is drawn from the run's id too (`lootFor`), so a restart fills
 * them the same.
 *
 * The ring is laid out by searching, not by chance: the islands are drawn
 * first, then the ring's radius is the least - from what the islands' widths
 * need, a block at a time - at which every rule holds (`layoutProblems`). The
 * rule that matters most: no jump reaches another island, from any block a
 * player can stand on (`parkour-layout.reachAcross`, counted the long way on
 * a diagonal) - to get anywhere, a player bridges. And none is so far that the
 * blocks in its own chests cannot bridge it to the middle.
 *
 * Out is out, never dead: brought low (the duel's shield first), fallen under
 * the islands or gone past the play area, a player is taken up to an invisible
 * gallery over the middle to watch, their kit taken. The box the arena takes
 * reaches `MARGIN` past the play area on every side but the top's gallery, and
 * a player is put out the moment they cross it (the quick look): blocks are
 * placed only against blocks within reach (`REACH`), and a player put out has
 * nothing to place - so nothing placed is ever outside the box, and barrier
 * walls round it are the backstop.
 *
 * Pure; the loop is `sky-wars-service.ts`.
 */

import { z } from "zod";
import { marked } from "./arena";
import type { Spot } from "./arena";
import type { Fill } from "./arena-game";
import type { Box, Marker } from "../state";
import { reachAcross } from "./parkour-layout";
import type { EventOptions } from "../catalog";
import { seeded, shuffled } from "../trivia-bank";

/** The layout's version, written into the run when it is built. */
export const DESIGN = 1;

/** How many can play: an island each. */
export const MOST = 8;

/** The least air between two islands, whatever a jump would say. */
const MIN_GAP = 5;
/** How far a block is placed from where a player stands, at the most:
 *  reach and the block itself, rounded up. */
export const REACH = 6;
/** Room past the play area to the box's wall: a player's reach, and how far
 *  they get in one quick look falling or running before they are put out. */
export const MARGIN = 12;
/** Room round the islands that is still the play area: a fight on a bridge's end. */
const PAD = 4;
/** How far under the lowest island the play area goes, and over the highest
 *  thing on one. */
const BELOW = 2;
const ABOVE = 8;
/** The gallery, over the play area's top. */
const GALLERY_LIFT = 3;
const GALLERY_HALF = 3;

/** The blocks a player must have to bridge from their island to the middle,
 *  past what it takes: a staircase's worth more. */
const BRIDGE_SPARE = 8;

const BARRIER = "minecraft:barrier";
const GRASS = "minecraft:grass_block";
const DIRT = "minecraft:dirt";
const STONE = "minecraft:stone";
const SPECKS = ["minecraft:andesite", "minecraft:coal_ore", "minecraft:iron_ore"] as const;
const LOG = "minecraft:oak_log";
const LEAVES = "minecraft:oak_leaves[persistent=true]";
const BOULDER = "minecraft:mossy_cobblestone";
const FLOWERS = [
    "minecraft:poppy",
    "minecraft:dandelion",
    "minecraft:cornflower",
    "minecraft:oxeye_daisy"
] as const;
const CHEST = "minecraft:chest";

/** What each island's bridging blocks are: one kind an island, drawn. */
export const BRIDGES = [
    "minecraft:oak_planks",
    "minecraft:cobblestone",
    "minecraft:spruce_planks",
    "minecraft:stone_bricks",
    "minecraft:white_wool"
] as const;

/** What a bridging block can be put against: an island, a bridge. */
export const PLACE_ON: readonly string[] = [
    GRASS,
    DIRT,
    STONE,
    ...SPECKS,
    LOG,
    "minecraft:oak_leaves",
    BOULDER,
    ...BRIDGES
];

/** Every kind of block the arena holds, built or placed, as bare ids: the
 *  flowers first, which come down before the grass they grow on
 *  (`arena.teardown`). */
export const ARENA_BLOCKS: readonly string[] = [
    ...FLOWERS,
    BARRIER,
    GRASS,
    DIRT,
    STONE,
    ...SPECKS,
    LOG,
    "minecraft:oak_leaves",
    BOULDER,
    CHEST,
    ...BRIDGES
];

// ------------------------------------------------------------------ the islands

/** A block of an island, from the ring's middle at the islands' base level. */
export interface Block {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly block: string;
}

export interface Island {
    /** Its middle, from the ring's. */
    readonly x: number;
    readonly z: number;
    /** The level of its grass. */
    readonly top: number;
    readonly blocks: readonly Block[];
    /** Its chests, in the order their loot is drawn. */
    readonly chests: readonly { x: number; y: number; z: number }[];
    /** Where its player starts, on the grass in the middle; null for the middle island. */
    readonly spawn: { x: number; y: number; z: number } | null;
    /** The bridging block its chests hold. */
    readonly bridge: string;
}

export interface Layout {
    readonly islands: readonly Island[];
    /** The middle one: the last of `islands`. */
    readonly ring: number;
}

/** One island's shape and what stands on it, about its own middle. */
interface Shape {
    readonly blocks: Block[];
    readonly chests: { x: number; y: number; z: number }[];
    readonly spawn: { x: number; y: number; z: number } | null;
    /** How far its widest part reaches from its middle, leaves included. */
    readonly extent: number;
}

const key = (x: number, z: number) => `${x},${z}`;

/**
 * An island about its own middle: a blob whose edge waves round it, grass on
 * top at level `top`, dirt under that, then stone narrowing a block or so a
 * level down to a point - with what stands on it.
 */
function shapeOf(random: () => number, radius: number, top: number, middle: boolean): Shape {
    const k1 = 2 + Math.floor(random() * 3);
    const k2 = 4 + Math.floor(random() * 3);
    const p1 = random() * Math.PI * 2;
    const p2 = random() * Math.PI * 2;
    const a1 = 0.1 + random() * 0.1;
    const a2 = 0.04 + random() * 0.06;
    const taper = 0.9 + random() * 0.5;
    const edge = (dx: number, dz: number) => {
        const angle = Math.atan2(dz, dx);
        return radius * (1 + a1 * Math.sin(k1 * angle + p1) + a2 * Math.sin(k2 * angle + p2));
    };
    const reach = Math.ceil(radius * 1.3) + 1;
    const blocks: Block[] = [];
    const surface = new Set<string>();
    for (let depth = 0; ; depth += 1) {
        const level = top - depth;
        let any = false;
        for (let dx = -reach; dx <= reach; dx += 1)
            for (let dz = -reach; dz <= reach; dz += 1) {
                const away = Math.hypot(dx, dz);
                const room = edge(dx, dz) - depth * taper - (depth > 0 ? random() * 0.35 : 0);
                // The tip: the middle column goes one level past the rest.
                if (away > room && !(dx === 0 && dz === 0 && room > -taper)) continue;
                any = true;
                if (depth === 0) surface.add(key(dx, dz));
                const inner = away < room - 1;
                const fleck = random();
                const block =
                    depth === 0
                        ? GRASS
                        : depth === 1 || (depth === 2 && inner)
                          ? DIRT
                          : inner && fleck < 0.06
                            ? SPECKS[0]
                            : inner && fleck < 0.1
                              ? SPECKS[1]
                              : inner && fleck < 0.12
                                ? SPECKS[2]
                                : STONE;
                blocks.push({ x: dx, y: level, z: dz, block });
            }
        if (!any || depth > 12) break;
    }
    const on = (dx: number, dz: number) => surface.has(key(dx, dz));
    const used = new Set<string>();
    const chests: { x: number; y: number; z: number }[] = [];
    let spawn: Shape["spawn"] = null;
    let extent = Math.max(
        ...[...surface].map((one) =>
            Math.hypot(...(one.split(",").map(Number) as [number, number]))
        )
    );
    const decor: Block[] = [];
    if (middle) {
        // A tree at its heart, four chests round it.
        decor.push(...treeAt(0, top, 0, 5, random));
        used.add(key(0, 0));
        for (const [dx, dz] of [
            [2, 0],
            [-2, 0],
            [0, 2],
            [0, -2]
        ] as const) {
            chests.push({ x: dx, y: top + 1, z: dz });
            used.add(key(dx, dz));
        }
    } else {
        spawn = { x: 0, y: top + 1, z: 0 };
        for (let dx = -1; dx <= 1; dx += 1)
            for (let dz = -1; dz <= 1; dz += 1) used.add(key(dx, dz));
        // Two chests on opposite sides of the start, where there is grass.
        const sides = shuffled(
            [
                [
                    [2, 0],
                    [-2, 0]
                ],
                [
                    [0, 2],
                    [0, -2]
                ]
            ] as const,
            random
        );
        for (const pair of sides) {
            if (chests.length > 0) break;
            if (pair.every(([dx, dz]) => on(dx, dz)))
                for (const [dx, dz] of pair) {
                    chests.push({ x: dx, y: top + 1, z: dz });
                    used.add(key(dx, dz));
                }
        }
        // A tree, or a mossy boulder, on grass clear of the start and the chests.
        const free = [...surface]
            .map((one) => one.split(",").map(Number) as [number, number])
            .filter(
                ([dx, dz]) =>
                    Math.max(Math.abs(dx), Math.abs(dz)) >= 2 &&
                    !used.has(key(dx, dz)) &&
                    [
                        [1, 0],
                        [-1, 0],
                        [0, 1],
                        [0, -1]
                    ].every(([ox, oz]) => !used.has(key(dx + ox!, dz + oz!)))
            );
        const spot = free.length > 0 ? free[Math.floor(random() * free.length)]! : null;
        if (spot) {
            const [dx, dz] = spot;
            used.add(key(dx, dz));
            if (random() < 0.65) decor.push(...treeAt(dx, top, dz, 4, random));
            else decor.push({ x: dx, y: top + 1, z: dz, block: BOULDER });
        }
    }
    // Flowers on a few of the free grass blocks.
    for (const one of surface) {
        const [dx, dz] = one.split(",").map(Number) as [number, number];
        if (used.has(one) || decor.some((d) => d.x === dx && d.z === dz) || random() > 0.12)
            continue;
        decor.push({
            x: dx,
            y: top + 1,
            z: dz,
            block: FLOWERS[Math.floor(random() * FLOWERS.length)]!
        });
    }
    for (const one of decor) extent = Math.max(extent, Math.hypot(one.x, one.z));
    return { blocks: [...blocks, ...decor], chests, spawn, extent: Math.ceil(extent) };
}

/** A small oak: its trunk, and a crown of leaves that never wither. */
function treeAt(x: number, top: number, z: number, height: number, random: () => number): Block[] {
    const out: Block[] = [];
    for (let level = 1; level <= height; level += 1) out.push({ x, y: top + level, z, block: LOG });
    const crown = top + height - 1;
    for (let dy = 0; dy <= 2; dy += 1) {
        const r = dy === 2 ? 1 : 2;
        for (let dx = -r; dx <= r; dx += 1)
            for (let dz = -r; dz <= r; dz += 1) {
                if (dx === 0 && dz === 0 && dy < 2) continue;
                // The crown's corners trimmed, a few at random: a rounder top.
                if (Math.abs(dx) === r && Math.abs(dz) === r && (dy === 2 || random() < 0.6))
                    continue;
                out.push({ x: x + dx, y: crown + dy, z: z + dz, block: LEAVES });
            }
    }
    return out;
}

/** The ring's least radius: the islands' widths apart, round the middle and
 *  round each other, with `MIN_GAP` between - the search starts there. */
function leastRing(shapes: readonly Shape[], middle: Shape): number {
    const widest = Math.max(...shapes.map((one) => one.extent));
    const toMiddle = middle.extent + MIN_GAP + widest + 1;
    const n = shapes.length;
    const round = n < 2 ? 0 : (2 * widest + MIN_GAP + 1) / (2 * Math.sin(Math.PI / n));
    return Math.ceil(Math.max(toMiddle, round));
}

/**
 * A run's islands for `players`: each drawn from the run's id, then the ring
 * laid out at the least radius at which every rule holds - a block wider at a
 * time, which always ends, since far enough apart nothing reaches anything.
 */
export function layoutFor(seed: string, players: number): Layout {
    const count = Math.max(2, Math.min(MOST, players));
    const random = seeded(`${seed}-islands`);
    const turn = random() * Math.PI * 2;
    const shapes = Array.from({ length: count }, () => {
        const top = Math.floor(random() * 3) - 1;
        return { shape: shapeOf(random, 3.6 + random() * 0.8, top, false), top };
    });
    const middle = shapeOf(random, 6.2 + random() * 1, 0, true);
    const bridges = shuffled(BRIDGES, random);
    const placedAt = (ring: number): Layout => {
        const islands: Island[] = shapes.map(({ shape, top }, index) => {
            const angle = turn + (index / count) * Math.PI * 2;
            const x = Math.round(Math.cos(angle) * ring);
            const z = Math.round(Math.sin(angle) * ring);
            return moved(shape, x, z, top, bridges[index % bridges.length]!);
        });
        islands.push(moved(middle, 0, 0, 0, bridges[0]!));
        return { islands, ring };
    };
    for (
        let ring = leastRing(
            shapes.map((one) => one.shape),
            middle
        );
        ;
        ring += 1
    ) {
        const layout = placedAt(ring);
        if (layoutProblems(layout).length === 0) return layout;
        if (ring > 200) return layout;
    }
}

function moved(shape: Shape, x: number, z: number, top: number, bridge: string): Island {
    const shift = <T extends { x: number; z: number }>(one: T): T => ({
        ...one,
        x: one.x + x,
        z: one.z + z
    });
    return {
        x,
        z,
        top,
        blocks: shape.blocks.map(shift),
        chests: shape.chests.map(shift),
        spawn: shape.spawn ? shift(shape.spawn) : null,
        bridge
    };
}

// ------------------------------------------------------------------ the rules

/** Every block a player can stand on: something whole, two blocks of air over it. */
function standable(island: Island): { x: number; y: number; z: number }[] {
    const known = standing.get(island.blocks);
    if (known) return known;
    // Packed as one number a block: an island never reaches 512 blocks from
    // the ring's middle, nor 64 levels from its base.
    const pack = (x: number, y: number, z: number) =>
        ((x + 512) * 1024 + (z + 512)) * 128 + (y + 64);
    const solid = new Set<number>();
    const points: { x: number; y: number; z: number }[] = [];
    for (const one of [...island.blocks, ...island.chests]) {
        if ("block" in one && FLOWERS.includes(one.block as never)) continue;
        solid.add(pack(one.x, one.y, one.z));
        points.push(one);
    }
    const out = points
        .filter(
            (one) =>
                !solid.has(pack(one.x, one.y + 1, one.z)) &&
                !solid.has(pack(one.x, one.y + 2, one.z))
        )
        .map(({ x, y, z }) => ({ x, y, z }));
    standing.set(island.blocks, out);
    return out;
}

/** What each island can be stood on, worked out once: its blocks never change. */
const standing = new WeakMap<readonly Block[], { x: number; y: number; z: number }[]>();

/** The square an island covers across the ground. */
function footprintOf(points: readonly { x: number; z: number }[]) {
    return {
        x1: Math.min(...points.map((one) => one.x)),
        x2: Math.max(...points.map((one) => one.x)),
        z1: Math.min(...points.map((one) => one.z)),
        z2: Math.max(...points.map((one) => one.z))
    };
}

/** Blocks of air across from a point to a square, a diagonal counted as touching. */
function awayFrom(point: { x: number; z: number }, square: ReturnType<typeof footprintOf>): number {
    const dx = Math.max(square.x1 - point.x, point.x - square.x2, 0);
    const dz = Math.max(square.z1 - point.z, point.z - square.z2, 0);
    return Math.max(dx, dz) - 1;
}

/** The least air between two islands' blocks a level or less apart. Only
 *  the blocks of one near the other's square are compared. */
function nearest(a: Island, b: Island): number {
    const square = footprintOf(b.blocks);
    let least = Number.POSITIVE_INFINITY;
    for (const one of a.blocks) {
        if (awayFrom(one, square) >= least) continue;
        for (const other of b.blocks) {
            if (Math.abs(one.y - other.y) > 1) continue;
            least = Math.min(
                least,
                Math.max(Math.abs(one.x - other.x), Math.abs(one.z - other.z)) - 1
            );
        }
    }
    return least;
}

/** The longest any jump carries, falling as far as it likes (`reachAcross`). */
const LONGEST_JUMP = reachAcross(-64);

/** The blocks it takes to bridge from one island to another: the shortest
 *  walk from any block of one to any of the other, a block a step. */
export function bridgeNeed(a: Island, b: Island): number {
    const from = standable(a);
    const to = standable(b);
    const square = footprintOf(to);
    let least = Number.POSITIVE_INFINITY;
    for (const one of from) {
        // No block of the other is nearer than its square.
        const near =
            Math.max(square.x1 - one.x, one.x - square.x2, 0) +
            Math.max(square.z1 - one.z, one.z - square.z2, 0) -
            1;
        if (near >= least) continue;
        for (const other of to)
            least = Math.min(
                least,
                Math.abs(one.x - other.x) +
                    Math.abs(one.z - other.z) -
                    1 +
                    Math.abs(one.y - other.y)
            );
    }
    return least;
}

/**
 * Every rule a layout breaks, one line each; empty when it keeps them all.
 * What the tests run over thousands of seeds, and what the ring is searched
 * against.
 */
/** How far an island reaches from its middle, across x and across z. */
function extentOf(island: Island): [number, number] {
    const square = footprintOf(island.blocks);
    return [
        Math.max(island.x - square.x1, square.x2 - island.x),
        Math.max(island.z - square.z1, square.z2 - island.z)
    ];
}

export function layoutProblems(layout: Layout): string[] {
    const problems: string[] = [];
    const islands = layout.islands;
    const stands = islands.map(standable);
    for (let i = 0; i < islands.length; i += 1)
        for (let j = i + 1; j < islands.length; j += 1) {
            const a = islands[i]!;
            const b = islands[j]!;
            // Cheap first: far enough apart that nothing can come near.
            const apart = Math.max(
                awayFrom({ x: a.x, z: a.z }, footprintOf(b.blocks)) -
                    Math.ceil(Math.hypot(...extentOf(a))),
                0
            );
            if (apart > LONGEST_JUMP + MIN_GAP) continue;
            if (nearest(a, b) < MIN_GAP) problems.push(`islands ${i} and ${j} are too close`);
            for (const [from, to, fi, ti] of [
                [stands[i]!, stands[j]!, i, j],
                [stands[j]!, stands[i]!, j, i]
            ] as const) {
                const square = footprintOf(to);
                const reached = from.some(
                    (one) =>
                        awayFrom(one, square) <= LONGEST_JUMP &&
                        to.some((other) => {
                            const across =
                                Math.max(Math.abs(one.x - other.x), Math.abs(one.z - other.z)) - 1;
                            const reach = reachAcross(other.y - one.y);
                            return reach >= 0 && across <= reach;
                        })
                );
                if (reached) problems.push(`island ${ti} can be jumped to from island ${fi}`);
            }
        }
    const middle = islands.at(-1)!;
    islands.slice(0, -1).forEach((island, index) => {
        if (!island.spawn) problems.push(`island ${index} has no start`);
        if (island.chests.length !== 2)
            problems.push(`island ${index} has ${island.chests.length} chests`);
        if (bridgeNeed(island, middle) + BRIDGE_SPARE > BRIDGE_BLOCKS)
            problems.push(`island ${index} is too far to bridge to the middle`);
        // Its start and its chests on its own grass, walked to from the start.
        const walk = walkable(island);
        if (island.spawn && !walk.has(`${island.spawn.x},${island.spawn.z}`))
            problems.push(`island ${index}'s start is not on its grass`);
        for (const chest of island.chests)
            if (
                ![
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1]
                ].some(([dx, dz]) => walk.has(`${chest.x + dx!},${chest.z + dz!}`))
            )
                problems.push(`a chest on island ${index} cannot be walked to`);
    });
    if (middle.chests.length !== 4) problems.push("the middle has not four chests");
    return problems;
}

/** The grass of an island a player can walk on from its start (or its middle),
 *  round its tree, its boulder and its chests. */
function walkable(island: Island): Set<string> {
    const grass = new Set(
        island.blocks.filter((one) => one.block === GRASS).map((one) => key(one.x, one.z))
    );
    const blocked = new Set([
        ...island.blocks
            .filter(
                (one) =>
                    one.y > island.top &&
                    !FLOWERS.includes(one.block as never) &&
                    one.y <= island.top + 2
            )
            .map((one) => key(one.x, one.z)),
        ...island.chests.map((one) => key(one.x, one.z))
    ]);
    const start = island.spawn ?? { x: island.x + 1, z: island.z + 1 };
    const seen = new Set<string>();
    const queue = [key(start.x, start.z)];
    if (!grass.has(queue[0]!) || blocked.has(queue[0]!)) return seen;
    seen.add(queue[0]!);
    while (queue.length > 0) {
        const [x, z] = queue.pop()!.split(",").map(Number) as [number, number];
        for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1]
        ] as const) {
            const next = key(x + dx, z + dz);
            if (grass.has(next) && !blocked.has(next) && !seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    return seen;
}

// ------------------------------------------------------------------ the box and the play area

/** How the islands sit in the world: the ring's middle, at the islands' base level. */
export interface Placed {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** The islands' bounds, from the ring's middle at their base level. */
function bounds(layout: Layout) {
    const all = layout.islands.flatMap((one) => one.blocks);
    return {
        x1: Math.min(...all.map((one) => one.x)),
        x2: Math.max(...all.map((one) => one.x)),
        y1: Math.min(...all.map((one) => one.y)),
        y2: Math.max(...all.map((one) => one.y)),
        z1: Math.min(...all.map((one) => one.z)),
        z2: Math.max(...all.map((one) => one.z))
    };
}

/** Where a player still plays: round the islands, a little under them and
 *  over them. Past it they are out. */
export function playArea(layout: Layout, at: Placed): Box {
    const b = bounds(layout);
    return {
        x1: at.x + b.x1 - PAD,
        y1: at.y + b.y1 - BELOW,
        z1: at.z + b.z1 - PAD,
        x2: at.x + b.x2 + PAD,
        y2: at.y + b.y2 + ABOVE,
        z2: at.z + b.z2 + PAD
    };
}

/** The gallery's floor, over the play area's top, in the middle. */
export function galleryFloor(layout: Layout, at: Placed): Box {
    const play = playArea(layout, at);
    const y = play.y2 + GALLERY_LIFT;
    return {
        x1: at.x - GALLERY_HALF,
        y1: y,
        z1: at.z - GALLERY_HALF,
        x2: at.x + GALLERY_HALF,
        y2: y,
        z2: at.z + GALLERY_HALF
    };
}

/** The box the arena takes: the play area, `MARGIN` past it on every side,
 *  and the gallery under the roof. */
export function arenaBox(layout: Layout, at: Placed): Box {
    const play = playArea(layout, at);
    const gallery = galleryFloor(layout, at);
    return {
        x1: play.x1 - MARGIN,
        y1: play.y1 - MARGIN,
        z1: play.z1 - MARGIN,
        x2: play.x2 + MARGIN,
        y2: Math.max(play.y2 + MARGIN, gallery.y1 + 4),
        z2: play.z2 + MARGIN
    };
}

/** How far from the ring's middle the ground under the arena is judged. */
export function reachOf(layout: Layout): number {
    const b = bounds(layout);
    return Math.max(-b.x1, b.x2, -b.z1, b.z2) + PAD + MARGIN;
}

/** The islands' base level over the ground found: `height` up, but never so
 *  low that the box under the islands reaches the ground. */
export function baseOver(layout: Layout, ground: number, height: number): number {
    const below = -bounds(layout).y1 + BELOW + MARGIN;
    return ground + Math.max(height, below + 2);
}

/** A cage round an island's start, in the world: invisible barrier three
 *  high and a lid, so nothing hides the island from its player. */
export function cageBox(island: Island, at: Placed): Box {
    const spawn = island.spawn!;
    return {
        x1: at.x + spawn.x - 1,
        y1: at.y + spawn.y,
        z1: at.z + spawn.z - 1,
        x2: at.x + spawn.x + 1,
        y2: at.y + spawn.y + 3,
        z2: at.z + spawn.z + 1
    };
}

/** Every island's cage taken down: its barrier, only inside its own box. */
export function cagesDown(layout: Layout, at: Placed): string[] {
    return layout.islands
        .filter((one) => one.spawn)
        .map((one) => {
            const cage = cageBox(one, at);
            return `execute in minecraft:overworld run fill ${cage.x1} ${cage.y1} ${cage.z1} ${cage.x2} ${cage.y2} ${cage.z2} minecraft:air replace ${BARRIER}`;
        });
}

/** Fills in rectangles of the same block, level by level: runs along x first,
 *  then runs that match the one before them along z joined to it - an island
 *  is a few dozen fills, not hundreds. */
function rows(blocks: readonly Block[], at: Placed): Fill[] {
    const sorted = [...blocks].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
    type Run = { x1: number; x2: number; y: number; z1: number; z2: number; block: string };
    const runs: Run[] = [];
    for (const one of sorted) {
        const last = runs.at(-1);
        if (
            last &&
            last.y === one.y &&
            last.z1 === one.z &&
            last.block === one.block &&
            last.x2 === one.x - 1
        )
            last.x2 = one.x;
        else runs.push({ x1: one.x, x2: one.x, y: one.y, z1: one.z, z2: one.z, block: one.block });
    }
    // A run joins the open rectangle of the row before it with the same ends.
    const open = new Map<string, Run>();
    const merged: Run[] = [];
    for (const run of runs) {
        const id = `${run.y}|${run.x1}|${run.x2}|${run.block}`;
        const above = open.get(id);
        if (above && above.z2 === run.z1 - 1) {
            above.z2 = run.z1;
            continue;
        }
        const fresh = { ...run };
        open.set(id, fresh);
        merged.push(fresh);
    }
    return merged.map((one) => ({
        box: {
            x1: at.x + one.x1,
            y1: at.y + one.y,
            z1: at.z + one.z1,
            x2: at.x + one.x2,
            y2: at.y + one.y,
            z2: at.z + one.z2
        },
        block: one.block
    }));
}

/** The way a chest faces: away from the island's middle, toward whoever
 *  walks up to it from there. */
function chestFacing(island: Island, chest: { x: number; z: number }): string {
    const dx = chest.x - island.x;
    const dz = chest.z - island.z;
    if (Math.abs(dx) >= Math.abs(dz)) return dx > 0 ? "west" : "east";
    return dz > 0 ? "north" : "south";
}

/**
 * What it is built of, each only into air: the barrier walls and roof, every
 * island from the bottom up with what stands on it, the chests, the cages and
 * the gallery - and the middle island's heart, last, as the proof the blocks
 * stayed.
 */
export function arenaFills(layout: Layout, at: Placed): Fill[] {
    const box = arenaBox(layout, at);
    const fills: Fill[] = [
        { box: { ...box, x2: box.x1 }, block: BARRIER },
        { box: { ...box, x1: box.x2 }, block: BARRIER },
        { box: { ...box, z2: box.z1 }, block: BARRIER },
        { box: { ...box, z1: box.z2 }, block: BARRIER },
        { box: { ...box, y1: box.y2 }, block: BARRIER }
    ];
    for (const island of layout.islands) {
        fills.push(...rows(island.blocks, at));
        for (const chest of island.chests) {
            const where = { x1: at.x + chest.x, y1: at.y + chest.y, z1: at.z + chest.z };
            fills.push({
                box: { ...where, x2: where.x1, y2: where.y1, z2: where.z1 },
                block: `${CHEST}[facing=${chestFacing(island, chest)}]`
            });
        }
        if (island.spawn) {
            const cage = cageBox(island, at);
            const ring = (x1: number, z1: number, x2: number, z2: number): Fill => ({
                box: { x1, y1: cage.y1, z1, x2, y2: cage.y2 - 1, z2 },
                block: BARRIER
            });
            fills.push(
                ring(cage.x1, cage.z1, cage.x2, cage.z1),
                ring(cage.x1, cage.z2, cage.x2, cage.z2),
                ring(cage.x1, cage.z1 + 1, cage.x1, cage.z2 - 1),
                ring(cage.x2, cage.z1 + 1, cage.x2, cage.z2 - 1),
                { box: { ...cage, y1: cage.y2 }, block: BARRIER }
            );
        }
    }
    const gallery = galleryFloor(layout, at);
    const walls = {
        ...gallery,
        x1: gallery.x1 - 1,
        z1: gallery.z1 - 1,
        x2: gallery.x2 + 1,
        z2: gallery.z2 + 1
    };
    // The gallery: an invisible floor, walls two high round it and a lid, all
    // barrier - who is out sees the whole fight, nothing in the way.
    const side = (x1: number, z1: number, x2: number, z2: number): Fill => ({
        box: { x1, y1: gallery.y1 + 1, z1, x2, y2: gallery.y1 + 2, z2 },
        block: BARRIER
    });
    fills.push(
        { box: { ...walls, y1: gallery.y1, y2: gallery.y1 }, block: BARRIER },
        side(walls.x1, walls.z1, walls.x2, walls.z1),
        side(walls.x1, walls.z2, walls.x2, walls.z2),
        side(walls.x1, walls.z1 + 1, walls.x1, walls.z2 - 1),
        side(walls.x2, walls.z1 + 1, walls.x2, walls.z2 - 1),
        { box: { ...walls, y1: gallery.y1 + 3, y2: gallery.y1 + 3 }, block: BARRIER }
    );
    // The middle island's grass at its heart, under its tree: the proof.
    const middle = layout.islands.at(-1)!;
    fills.push({
        box: {
            x1: at.x,
            y1: at.y + middle.top,
            z1: at.z,
            x2: at.x,
            y2: at.y + middle.top,
            z2: at.z
        },
        block: GRASS
    });
    return fills;
}

/** Where a player starts: in their island's cage, facing the middle. */
export function startSpot(layout: Layout, at: Placed, index: number): Spot {
    const island = layout.islands[index % (layout.islands.length - 1)]!;
    const spawn = island.spawn!;
    const yaw = Math.round((-Math.atan2(-island.x, -island.z) * 180) / Math.PI);
    return { x: at.x + spawn.x, y: at.y + spawn.y, z: at.z + spawn.z, yaw };
}

/** Where whoever is out watches from: on the gallery, looking down. */
export function gallerySpot(layout: Layout, at: Placed, index: number): Spot {
    const floor = galleryFloor(layout, at);
    const side = floor.x2 - floor.x1 + 1;
    return {
        x: floor.x1 + (index % side),
        y: floor.y1 + 1,
        z: floor.z1 + (Math.floor(index / side) % side),
        yaw: 0,
        pitch: 60
    };
}

// ------------------------------------------------------------------ the loot

export type Loot = EventOptions<"sky-wars">["loot"];

export interface Stack {
    readonly id: string;
    readonly count: number;
    /** A bridging block: placeable against an island or a bridge. */
    readonly bridge?: boolean;
}

/** Bridging blocks each island's chests hold, together: what `BRIDGE_SPARE`
 *  and the ring's search allow for. */
export const BRIDGE_BLOCKS = 48;

const ARMOR = ["helmet", "chestplate", "leggings", "boots"] as const;

/** Every item any chest can hold, for taking the kit back. */
export const LOOT_IDS: readonly string[] = [
    ...BRIDGES,
    ...["wooden", "stone", "iron", "diamond"].map((one) => `minecraft:${one}_sword`),
    ...["leather", "chainmail", "golden", "iron", "diamond"].flatMap((one) =>
        ARMOR.map((piece) => `minecraft:${one}_${piece}`)
    ),
    "minecraft:bow",
    "minecraft:arrow",
    "minecraft:snowball",
    "minecraft:ender_pearl",
    "minecraft:golden_apple",
    "minecraft:bread",
    "minecraft:cooked_beef",
    "minecraft:cooked_porkchop"
];

/**
 * What one chest holds, drawn from the run's id: an island's first chest its
 * weapon, food and most of its bridging blocks, its second armor, the rest of
 * the blocks and maybe a bow; the middle's better on both counts. `rich` puts
 * iron and diamond where `normal` has wood and leather.
 */
export function lootFor(
    seed: string,
    island: number,
    chest: number,
    middle: boolean,
    loot: Loot,
    bridge: string
): Stack[] {
    const random = seeded(`${seed}-loot-${island}-${chest}`);
    const rich = loot === "rich";
    const chance = (odds: number) => random() < odds;
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    const armor = (tiers: readonly string[], pieces: number): Stack[] =>
        shuffled(ARMOR, random)
            .slice(0, pieces)
            .map((piece) => ({ id: `minecraft:${pick(tiers)}_${piece}`, count: 1 }));
    const out: Stack[] = [];
    if (middle) {
        out.push(
            {
                id: rich
                    ? "minecraft:diamond_sword"
                    : pick(["minecraft:iron_sword", "minecraft:stone_sword"]),
                count: 1
            },
            ...armor(
                rich ? ["diamond", "iron"] : ["iron", "chainmail"],
                rich ? 2 : 1 + Math.floor(random() * 2)
            ),
            { id: bridge, count: 16, bridge: true }
        );
        if (chance(rich ? 0.8 : 0.5))
            out.push(
                { id: "minecraft:bow", count: 1 },
                { id: "minecraft:arrow", count: rich ? 16 : 10 }
            );
        if (chance(rich ? 0.9 : 0.5))
            out.push({ id: "minecraft:ender_pearl", count: rich ? 2 : 1 });
        out.push({ id: "minecraft:golden_apple", count: rich ? 3 : 1 + Math.floor(random() * 2) });
        out.push({ id: "minecraft:cooked_beef", count: 4 });
        return out;
    }
    if (chest === 0) {
        out.push(
            { id: bridge, count: rich ? 48 : 32, bridge: true },
            {
                id: rich
                    ? chance(0.3)
                        ? "minecraft:diamond_sword"
                        : "minecraft:iron_sword"
                    : pick([
                          "minecraft:wooden_sword",
                          "minecraft:stone_sword",
                          "minecraft:stone_sword"
                      ]),
                count: 1
            },
            chance(0.5)
                ? { id: "minecraft:bread", count: 3 + Math.floor(random() * 3) }
                : { id: rich ? "minecraft:cooked_beef" : "minecraft:cooked_porkchop", count: 3 }
        );
        if (rich && chance(0.4)) out.push({ id: "minecraft:ender_pearl", count: 1 });
        return out;
    }
    out.push(
        { id: bridge, count: rich ? 32 : 16, bridge: true },
        ...armor(rich ? ["iron", "iron", "diamond"] : ["leather", "chainmail", "golden"], 2)
    );
    if (chance(rich ? 0.6 : 0.35))
        out.push(
            { id: "minecraft:bow", count: 1 },
            { id: "minecraft:arrow", count: rich ? 12 : 8 }
        );
    if (chance(0.4)) out.push({ id: "minecraft:snowball", count: 8 });
    if (chance(rich ? 0.6 : 0.15)) out.push({ id: "minecraft:golden_apple", count: 1 });
    return out;
}

/** A chest's stacks, each in a slot drawn from the run's id, marked as the
 *  kit, the way this server writes items. */
export function fillChestLines(
    seed: string,
    at: { x: number; y: number; z: number },
    stacks: readonly Stack[],
    marker: Marker,
    itemCommand: boolean
): string[] {
    const slots = shuffled(
        Array.from({ length: 27 }, (_, index) => index),
        seeded(`${seed}-slots-${at.x}-${at.y}-${at.z}`)
    );
    return stacks.map((stack, index) => {
        const item = marked(stack.id, marker, stack.bridge ? { placeOn: PLACE_ON } : {});
        const where = `${at.x} ${at.y} ${at.z}`;
        const slot = `container.${slots[index]!}`;
        return itemCommand
            ? `execute in minecraft:overworld run item replace block ${where} ${slot} with ${item} ${stack.count}`
            : `execute in minecraft:overworld run replaceitem block ${where} ${slot} ${item} ${stack.count}`;
    });
}

/** Every chest of a layout filled. */
export function chestLines(
    seed: string,
    layout: Layout,
    at: Placed,
    loot: Loot,
    marker: Marker,
    itemCommand: boolean
): string[] {
    return layout.islands.flatMap((island, index) =>
        island.chests.flatMap((chest, number) =>
            fillChestLines(
                seed,
                { x: at.x + chest.x, y: at.y + chest.y, z: at.z + chest.z },
                lootFor(seed, index, number, island.spawn === null, loot, island.bridge),
                marker,
                itemCommand
            )
        )
    );
}

// ------------------------------------------------------------------ the game

const outSchema = z.object({
    name: z.string(),
    at: z.number(),
    why: z.enum(["low", "fell", "left", "died", "gone"])
});

export const stateSchema = z.object({
    design: z.number().int().default(DESIGN),
    out: z.array(outSchema).default([]),
    kills: z.record(z.number().int()).default({})
});
export type WarState = z.infer<typeof stateSchema>;

export function stateOf(game: unknown): WarState {
    const parsed = stateSchema.safeParse(game ?? {});
    return parsed.success ? parsed.data : stateSchema.parse({});
}

/** The scores: who went out first has one, each after one more, whoever is
 *  left one more than everybody out. Out at the same moment, the same. */
export function scoresOf(state: WarState, names: readonly string[]): Map<string, number> {
    return new Map(
        names.map((name) => {
            const went = state.out.find((one) => one.name.toLowerCase() === name.toLowerCase());
            return [
                name,
                went ? 1 + state.out.filter((one) => one.at < went.at).length : state.out.length + 1
            ];
        })
    );
}

/** A tie on place broken by kills. */
export function tiebreakOf(state: WarState, names: readonly string[]): Record<string, number> {
    return Object.fromEntries(names.map((name) => [name, -(state.kills[name] ?? 0)]));
}

/** Health at which a player is out, before the next blow can kill them: two hearts. */
export const OUT_HEALTH = 4;

/** Who is out carries this, so the quick look leaves them be. */
export const OUT_TAG = "pe_sw_out";
/** Who the quick look found past the play area, for the tick to put out. */
export const GONE_TAG = "pe_sw_gone";

/** How long after a blow its striker is still credited with somebody going out. */
export const CREDIT_MS = 10_000;

/** The counts the game keeps: damage taken, and bows drawn. */
export const TAKEN = "pe_swt";
export const BOWS = "pe_swb";
export const READ_TAKEN = `execute as @a run scoreboard players get @s ${TAKEN}`;
export const READ_BOWS = `execute as @a run scoreboard players get @s ${BOWS}`;

export function setupLines(): string[] {
    return [
        ...(
            [
                ["pe_hp", "health"],
                ["pe_dealt", "minecraft.custom:minecraft.damage_dealt"],
                ["pe_died", "deathCount"],
                ["pe_pk", "playerKillCount"],
                [TAKEN, "minecraft.custom:minecraft.damage_taken"],
                [BOWS, "minecraft.used:minecraft.bow"]
            ] as const
        ).flatMap(([objective, criterion]) => [
            `scoreboard objectives remove ${objective}`,
            `scoreboard objectives add ${objective} ${criterion}`
        ])
    ];
}

export const TEARDOWN = [
    ...["pe_hp", "pe_dealt", "pe_died", "pe_pk", TAKEN, BOWS].map(
        (one) => `scoreboard objectives remove ${one}`
    ),
    `tag @a remove ${OUT_TAG}`,
    `tag @a remove ${GONE_TAG}`
];

/**
 * Between ticks, nothing read: whoever is down to `OUT_HEALTH` shielded until
 * the tick puts them out; whoever crossed the play area's edge - under the
 * islands, past a side, over the top - taken up to the gallery at once and
 * marked for the tick, before they could place anything outside the box; and
 * an arrow stuck in a block gone before anybody picks it up as their own.
 */
export function quickLines(layout: Layout, at: Placed, box: Box): string[] {
    const play = playArea(layout, at);
    const who = `tag=pe_arena,tag=!${OUT_TAG}`;
    const far = 64;
    const volume = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) =>
        `x=${x1},y=${y1},z=${z1},dx=${x2 - x1},dy=${y2 - y1},dz=${z2 - z1}`;
    const outside = [
        volume(
            box.x1 - far,
            box.y1 - far * 2,
            box.z1 - far,
            box.x2 + far,
            play.y1 - 1,
            box.z2 + far
        ),
        volume(box.x1 - far, play.y1, box.z1 - far, play.x1 - 1, box.y2 + far, box.z2 + far),
        volume(play.x2 + 1, play.y1, box.z1 - far, box.x2 + far, box.y2 + far, box.z2 + far),
        volume(play.x1, play.y1, box.z1 - far, play.x2, box.y2 + far, play.z1 - 1),
        volume(play.x1, play.y1, play.z2 + 1, play.x2, box.y2 + far, box.z2 + far),
        volume(play.x1, play.y2 + 1, play.z1, play.x2, box.y2 + far, play.z2)
    ];
    const seat = gallerySpot(layout, at, 0);
    const box2 = volume(box.x1, box.y1, box.z1, box.x2, box.y2, box.z2);
    return [
        `effect give @a[${who},scores={pe_hp=..${OUT_HEALTH}}] minecraft:resistance 2 4 true`,
        ...outside.map(
            (one) => `execute in minecraft:overworld run tag @a[${who},${one}] add ${GONE_TAG}`
        ),
        `execute in minecraft:overworld run tp @a[${who},tag=${GONE_TAG}] ${seat.x + 0.5} ${seat.y} ${seat.z + 0.5}`,
        `execute in minecraft:overworld run kill @e[type=minecraft:arrow,${box2},nbt={inGround:1b}]`
    ];
}

/** Whether a point is inside the play area. */
export function inPlay(play: Box, at: { x: number; y: number; z: number }): boolean {
    return (
        at.x >= play.x1 &&
        at.x < play.x2 + 1 &&
        at.y >= play.y1 &&
        at.y < play.y2 + 1 &&
        at.z >= play.z1 &&
        at.z < play.z2 + 1
    );
}

/**
 * Who hit a player hurt since the last look: of those who struck, the nearest
 * within melee reach and a step; else, of those who drew a bow, the nearest.
 */
export function hitBy(
    victim: { x: number; y: number; z: number },
    struck: readonly { name: string; x: number; y: number; z: number }[],
    shot: readonly { name: string; x: number; y: number; z: number }[]
): string | null {
    const nearestOf = (list: typeof struck, within: number) => {
        let best: string | null = null;
        let least = within;
        for (const one of list) {
            const away = Math.hypot(one.x - victim.x, one.y - victim.y, one.z - victim.z);
            if (away <= least) {
                least = away;
                best = one.name;
            }
        }
        return best;
    };
    return nearestOf(struck, 6) ?? nearestOf(shot, Number.POSITIVE_INFINITY);
}
