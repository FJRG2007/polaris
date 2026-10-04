/**
 * Hide and seek's map and rules.
 *
 * A closed hall in the air, 25 by 25 inside, stone-walled under a glass roof,
 * with a gallery - the second floor - round two of its sides, reached by a
 * staircase and a ladder, railed so nobody falls off it. Which corner the
 * gallery stands in, where its stairs and ladder are, and every hiding place -
 * walls, hedges, crates and stacks of them, on the floor, under the gallery
 * and on it - are drawn from the run's id (`layoutFor`).
 *
 * A map is checked before it is built (`layoutProblems`): every piece inside
 * the hall and under what is over it, no two pieces touching (a block of air
 * between them, so nothing is sealed off by accident), nothing on the stairs,
 * the ladder, the seekers' cage or the hiders' start, and - walked from the
 * hiders' start the way a player moves, a block up at a time, the stairs and
 * the ladder included - every floor block of both floors reachable. A map that
 * breaks a rule is drawn again; after `DRAWS` tries the hall is used with
 * nothing in it but the gallery, which keeps every rule.
 *
 * The seekers wait in a cage of barrier in the middle, blinded and unable to
 * move, for `hideSeconds`; the cage then comes down (only its barrier, only in
 * its own box). Everybody is unhurt the whole game. A seeker's hit finds a
 * hider (`foundBy`): only seekers can strike, so a hider hurt beside a seeker
 * who struck was found by them. Whoever is found seeks too.
 *
 * Pure; the loop is `hide-and-seek-service.ts`.
 */

import { z } from "zod";
import type { Box } from "../state";
import type { Spot } from "./arena";
import type { Fill } from "./arena-game";
import { seeded, shuffled } from "../trivia-bank";

/** The layout's version, written into the run when it is built. */
export const DESIGN = 1;

/** The hall, walls included: 27 by 27. */
const SIZE = 27;
const LAST = SIZE - 2;
/** Levels over the floor: the gallery's floor at 4, the roof at 8. */
const GALLERY = 4;
const ROOF = 8;
/** The gallery's depth from the wall, and the row its railing stands on. */
const DEPTH = 4;
const EDGE = DEPTH + 1;
/** The middle, where the seekers' cage stands. */
const MIDDLE = 15;

/** How many can play. */
export const MOST = 12;
/** How far from its center the ground under it is judged. */
export const REACH = Math.ceil(SIZE / 2);

/** What a find is worth to its seeker: half a minute hidden. */
export const FIND_POINTS = 30;
/** How close a seeker who struck must be to a hider who was hurt. */
export const FIND_REACH = 5;

/** Times a map is drawn again before the bare hall is used. */
const DRAWS = 30;

const BARRIER = "minecraft:barrier";
const OUTER = "minecraft:stone_bricks";
const FLOOR = "minecraft:smooth_stone";
const LIGHT = "minecraft:sea_lantern";
const ROOF_BLOCK = "minecraft:glass";
const BOARDS = "minecraft:spruce_planks";
const POST = "minecraft:spruce_log";
const RAIL = "minecraft:spruce_fence";
const STAIR = "minecraft:spruce_stairs";
const LADDER = "minecraft:ladder";
const PIECE_BLOCKS = {
    wall: "minecraft:bricks",
    hedge: "minecraft:oak_leaves[persistent=true]",
    crate: "minecraft:barrel[facing=up]",
    stack: "minecraft:barrel[facing=up]"
} as const;

/** Every kind of block the hall is built of, as bare ids. */
export const HALL_BLOCKS: readonly string[] = [
    BARRIER,
    OUTER,
    FLOOR,
    LIGHT,
    ROOF_BLOCK,
    BOARDS,
    POST,
    RAIL,
    STAIR,
    LADDER,
    "minecraft:bricks",
    "minecraft:oak_leaves",
    "minecraft:barrel"
];

// ------------------------------------------------------------------ the map

export type PieceKind = keyof typeof PIECE_BLOCKS;

/** A hiding place, in the hall's own blocks: `x`, `z` its corner with the least
 *  of each, `level` the first level it fills, `w` by `d` across, `h` high. */
export interface Piece {
    readonly kind: PieceKind;
    readonly x: number;
    readonly z: number;
    readonly level: number;
    readonly w: number;
    readonly d: number;
    readonly h: number;
}

export interface Layout {
    /** Which corner the gallery is in: mirrored across x, across z. */
    readonly flipX: boolean;
    readonly flipZ: boolean;
    /** Where the stairs come up onto the gallery's west arm, and the ladder
     *  onto its north arm, as the unmirrored hall has them. */
    readonly stairsZ: number;
    readonly ladderX: number;
    readonly pieces: readonly Piece[];
    /** Whether it fell back to the bare hall. */
    readonly bare: boolean;
}

/** Where the stairs and the ladder may come up: never by a post. */
const ACCESS = [8, 12, 13, 17, 18, 22, 23] as const;
/** The posts under the gallery's edge, along each arm. */
const POSTS = [EDGE, 10, 15, 20, LAST] as const;

/** The kinds of hiding place, by where they go: on the floor, under the
 *  gallery (three high at most) and on it (two at most). */
const SHAPES: Readonly<
    Record<"floor" | "under" | "over", readonly Omit<Piece, "x" | "z" | "level">[]>
> = {
    floor: [
        { kind: "wall", w: 4, d: 1, h: 3 },
        { kind: "wall", w: 1, d: 4, h: 3 },
        { kind: "wall", w: 3, d: 1, h: 3 },
        { kind: "wall", w: 1, d: 3, h: 3 },
        { kind: "hedge", w: 3, d: 1, h: 2 },
        { kind: "hedge", w: 1, d: 3, h: 2 },
        { kind: "hedge", w: 2, d: 2, h: 2 },
        { kind: "crate", w: 1, d: 1, h: 1 },
        { kind: "crate", w: 2, d: 1, h: 1 },
        { kind: "stack", w: 2, d: 2, h: 2 }
    ],
    under: [
        { kind: "crate", w: 1, d: 1, h: 1 },
        { kind: "crate", w: 1, d: 2, h: 1 },
        { kind: "stack", w: 2, d: 2, h: 2 },
        { kind: "hedge", w: 1, d: 2, h: 2 },
        { kind: "wall", w: 1, d: 3, h: 3 }
    ],
    over: [
        { kind: "crate", w: 1, d: 1, h: 1 },
        { kind: "stack", w: 2, d: 1, h: 2 },
        { kind: "hedge", w: 2, d: 1, h: 2 },
        { kind: "hedge", w: 1, d: 2, h: 2 }
    ]
};

/** How many of each are wanted: a hall worth hiding in. */
const WANTED = { floor: 11, under: 5, over: 4 } as const;

/** The seekers' cage: three by three inside, in the middle of the floor. */
export const CAGE = { x1: MIDDLE - 2, z1: MIDDLE - 2, x2: MIDDLE + 2, z2: MIDDLE + 2 } as const;

/** Whether a cell is under the gallery (and the gallery over it). */
function underGallery(x: number, z: number): boolean {
    return x <= DEPTH || z <= DEPTH;
}

/** What else stands in the hall besides its hiding places: the posts, the
 *  stairs, the ladder's post and the cage, each as a piece the hiding places
 *  must keep a block away from. */
function fixtures(stairsZ: number, ladderX: number): Piece[] {
    const post = (x: number, z: number): Piece => ({
        kind: "wall",
        x,
        z,
        level: 1,
        w: 1,
        d: 1,
        h: 3
    });
    return [
        ...POSTS.map((z) => post(EDGE, z)),
        ...POSTS.filter((x) => x !== EDGE).map((x) => post(x, EDGE)),
        // The stairs and what holds them up, and the way onto them.
        { kind: "wall", x: EDGE + 1, z: stairsZ, level: 1, w: 4, d: 1, h: 3 },
        // The ladder, its post and the floor in front of it.
        { kind: "wall", x: ladderX, z: EDGE, level: 1, w: 1, d: 2, h: 4 },
        // The cage, and the ring round it the hiders start on.
        { kind: "wall", x: CAGE.x1 - 1, z: CAGE.z1 - 1, level: 1, w: 7, d: 7, h: 3 },
        // Where the stairs and the ladder come out onto the gallery.
        { kind: "wall", x: EDGE - 1, z: stairsZ, level: GALLERY + 1, w: 2, d: 1, h: 2 },
        { kind: "wall", x: ladderX, z: EDGE - 1, level: GALLERY + 1, w: 1, d: 2, h: 2 }
    ];
}

function apart(a1: number, a2: number, b1: number, b2: number): number {
    return Math.max(a1 - b2, b1 - a2) - 1;
}

/** The air between two pieces across the floor; pieces on different floors
 *  never meet. */
function gapOf(a: Piece, b: Piece): number {
    if (a.level + a.h - 1 < b.level || b.level + b.h - 1 < a.level) return Number.POSITIVE_INFINITY;
    return Math.max(
        apart(a.x, a.x + a.w - 1, b.x, b.x + b.w - 1),
        apart(a.z, a.z + a.d - 1, b.z, b.z + b.d - 1)
    );
}

/** Where a piece of a zone may stand, and every rule it can break by itself. */
function pieceProblems(piece: Piece, index = 0): string[] {
    const problems: string[] = [];
    const cells = (test: (x: number, z: number) => boolean) => {
        for (let x = piece.x; x < piece.x + piece.w; x += 1)
            for (let z = piece.z; z < piece.z + piece.d; z += 1) if (!test(x, z)) return false;
        return true;
    };
    if (piece.x < 1 || piece.z < 1 || piece.x + piece.w - 1 > LAST || piece.z + piece.d - 1 > LAST)
        problems.push(`piece ${index} is outside the hall`);
    if (piece.level === 1) {
        const under = cells(underGallery);
        const open = cells((x, z) => x > EDGE && z > EDGE);
        if (!under && !open) problems.push(`piece ${index} stands half under the gallery`);
        if (under && piece.h > GALLERY - 1)
            problems.push(`piece ${index} has no room under the gallery`);
        if (open && piece.h > ROOF - 2) problems.push(`piece ${index} reaches the roof`);
    } else if (piece.level === GALLERY + 1) {
        if (!cells((x, z) => x < EDGE || z < EDGE))
            problems.push(`piece ${index} is off the gallery`);
        if (piece.h > ROOF - GALLERY - 2) problems.push(`piece ${index} has no head room over it`);
    } else problems.push(`piece ${index} floats`);
    return problems;
}

/**
 * A run's hall: the gallery's corner, its stairs and ladder, and the hiding
 * places, drawn from the run's id - each piece kept only where it breaks no
 * rule of its own and touches nothing - and the whole checked once drawn.
 */
export function layoutFor(seed: string): Layout {
    for (let draw = 0; draw < DRAWS; draw += 1) {
        const random = seeded(`${seed}-hide-${draw}`);
        const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
        const stairsZ = pick(ACCESS);
        const ladderX = pick(ACCESS);
        const fixed = fixtures(stairsZ, ladderX);
        const pieces: Piece[] = [];
        for (const zone of ["floor", "under", "over"] as const) {
            let placed = 0;
            for (let attempt = 0; attempt < 300 && placed < WANTED[zone]; attempt += 1) {
                const shape = pick(SHAPES[zone]);
                const level = zone === "over" ? GALLERY + 1 : 1;
                const x = 1 + Math.floor(random() * (LAST - shape.w + 1));
                const z = 1 + Math.floor(random() * (LAST - shape.d + 1));
                const piece: Piece = { ...shape, x, z, level };
                const zoned =
                    zone === "floor"
                        ? x > EDGE && z > EDGE
                        : zone === "under"
                          ? x + shape.w - 1 <= DEPTH || z + shape.d - 1 <= DEPTH
                          : true;
                if (!zoned || pieceProblems(piece).length > 0) continue;
                if ([...fixed, ...pieces].some((one) => gapOf(one, piece) < 1)) continue;
                pieces.push(piece);
                placed += 1;
            }
        }
        const layout: Layout = {
            flipX: random() < 0.5,
            flipZ: random() < 0.5,
            stairsZ,
            ladderX,
            pieces,
            bare: false
        };
        if (layoutProblems(layout).length === 0) return layout;
    }
    return {
        flipX: false,
        flipZ: false,
        stairsZ: ACCESS[0],
        ladderX: ACCESS[0],
        pieces: [],
        bare: true
    };
}

// ------------------------------------------------------------------ the blocks, as a player meets them

/** What is in one block of the hall, in its own unmirrored terms. */
type Cell = "air" | "solid" | "tall" | "ladder";

/** The hall's blocks, level by level: what a player walks on, bumps into and climbs. */
function voxels(layout: Layout): (x: number, level: number, z: number) => Cell {
    const cells = new Uint8Array(SIZE * SIZE * (ROOF + 1));
    const kinds: readonly Cell[] = ["air", "solid", "tall", "ladder"];
    const index = (x: number, level: number, z: number) => (level * SIZE + x) * SIZE + z;
    const fill = (
        cell: Cell,
        x1: number,
        l1: number,
        z1: number,
        x2: number,
        l2: number,
        z2: number
    ) => {
        for (let x = x1; x <= x2; x += 1)
            for (let level = l1; level <= l2; level += 1)
                for (let z = z1; z <= z2; z += 1) {
                    const at = index(x, level, z);
                    // Something whole wins over a railing or a ladder in the same block.
                    if (cells[at] !== 1) cells[at] = kinds.indexOf(cell);
                }
    };
    for (const one of structure(layout))
        fill(one.cell, one.x1, one.l1, one.z1, one.x2, one.l2, one.z2);
    for (const piece of layout.pieces)
        fill(
            "solid",
            piece.x,
            piece.level,
            piece.z,
            piece.x + piece.w - 1,
            piece.level + piece.h - 1,
            piece.z + piece.d - 1
        );
    return (x, level, z) => {
        if (x < 1 || z < 1 || x > LAST || z > LAST || level <= 0 || level >= ROOF) return "solid";
        return kinds[cells[index(x, level, z)]!]!;
    };
}

/** One block kind over a box of the unmirrored hall, by levels; `cell` how a
 *  player meets it. */
interface Part {
    readonly x1: number;
    readonly l1: number;
    readonly z1: number;
    readonly x2: number;
    readonly l2: number;
    readonly z2: number;
    readonly block: string;
    readonly cell: Exclude<Cell, "air">;
}

/** The hall's own fixtures, unmirrored: the gallery's two arms, the posts
 *  under its edge, its railing with a gap where the stairs and the ladder come
 *  out, the stairs and what holds them, the ladder and its post, and the
 *  seekers' cage. Stairs and the ladder name the way they face here; mirrored
 *  they are turned with the rest (`facing`). */
function structure(layout: Layout): Part[] {
    const { stairsZ, ladderX } = layout;
    const part = (
        x1: number,
        l1: number,
        z1: number,
        x2: number,
        l2: number,
        z2: number,
        block: string,
        cell: Part["cell"] = "solid"
    ): Part => ({ x1, l1, z1, x2, l2, z2, block, cell });
    const parts: Part[] = [
        part(1, GALLERY, 1, DEPTH, GALLERY, LAST, BOARDS),
        part(DEPTH + 1, GALLERY, 1, LAST, GALLERY, DEPTH, BOARDS),
        part(EDGE, GALLERY, EDGE, EDGE, GALLERY, LAST, BOARDS),
        part(EDGE + 1, GALLERY, EDGE, LAST, GALLERY, EDGE, BOARDS)
    ];
    for (const z of POSTS) parts.push(part(EDGE, 1, z, EDGE, GALLERY - 1, z, POST));
    for (const x of POSTS) if (x !== EDGE) parts.push(part(x, 1, EDGE, x, GALLERY - 1, EDGE, POST));
    // The railing along the gallery's edge, open where the stairs and the ladder arrive.
    for (let z = EDGE; z <= LAST; z += 1)
        if (z !== stairsZ)
            parts.push(part(EDGE, GALLERY + 1, z, EDGE, GALLERY + 1, z, RAIL, "tall"));
    for (let x = EDGE + 1; x <= LAST; x += 1)
        if (x !== ladderX)
            parts.push(part(x, GALLERY + 1, EDGE, x, GALLERY + 1, EDGE, RAIL, "tall"));
    // Three steps up to the gallery's west arm, each on boards down to the floor.
    for (let step = 1; step <= GALLERY - 1; step += 1) {
        const x = EDGE + GALLERY - step;
        if (step > 1) parts.push(part(x, 1, stairsZ, x, step - 1, stairsZ, BOARDS));
        parts.push(part(x, step, stairsZ, x, step, stairsZ, `${STAIR}[facing=west]`));
    }
    // The ladder up the face of the north arm, on a post under its edge.
    parts.push(part(ladderX, 1, EDGE, ladderX, GALLERY - 1, EDGE, POST));
    parts.push(
        part(ladderX, 1, EDGE + 1, ladderX, GALLERY, EDGE + 1, `${LADDER}[facing=south]`, "ladder")
    );
    return parts;
}

/** The cage round the seekers' room, in the unmirrored hall: barrier walls three
 *  high and a lid. */
function cageParts(): Part[] {
    const { x1, z1, x2, z2 } = CAGE;
    const wall = (ax: number, az: number, bx: number, bz: number): Part => ({
        x1: ax,
        l1: 1,
        z1: az,
        x2: bx,
        l2: 3,
        z2: bz,
        block: BARRIER,
        cell: "solid"
    });
    return [
        wall(x1, z1, x2, z1),
        wall(x1, z2, x2, z2),
        wall(x1, z1 + 1, x1, z2 - 1),
        wall(x2, z1 + 1, x2, z2 - 1),
        { x1, l1: 4, z1, x2, l2: 4, z2, block: BARRIER, cell: "solid" }
    ];
}

/** Where the hiders start: round the cage, a block out from its wall, spread
 *  evenly - as many as the hall takes. */
function hiderCells(): { x: number; z: number }[] {
    const ring: { x: number; z: number }[] = [];
    const r = MIDDLE - CAGE.x1 + 1;
    for (let x = MIDDLE - r; x <= MIDDLE + r; x += 1)
        for (let z = MIDDLE - r; z <= MIDDLE + r; z += 1)
            if (Math.max(Math.abs(x - MIDDLE), Math.abs(z - MIDDLE)) === r) ring.push({ x, z });
    ring.sort(
        (a, b) => Math.atan2(a.z - MIDDLE, a.x - MIDDLE) - Math.atan2(b.z - MIDDLE, b.x - MIDDLE)
    );
    const step = ring.length / MOST;
    return Array.from({ length: MOST }, (_, index) => ring[Math.floor(index * step)]!);
}

/** The seekers' cells inside the cage. */
function seekerCells(): { x: number; z: number }[] {
    return [
        { x: MIDDLE, z: MIDDLE },
        { x: MIDDLE - 1, z: MIDDLE },
        { x: MIDDLE + 1, z: MIDDLE }
    ];
}

/**
 * Every rule a hall breaks, one line each; empty when it keeps them all. What
 * the tests run over thousands of seeds, and what a hall is checked against
 * before it is used.
 */
export function layoutProblems(layout: Layout): string[] {
    const problems: string[] = [];
    const fixed = fixtures(layout.stairsZ, layout.ladderX);
    layout.pieces.forEach((piece, index) => {
        problems.push(...pieceProblems(piece, index));
        for (const one of fixed)
            if (gapOf(one, piece) < 1) {
                problems.push(`piece ${index} is in the way of the stairs, the ladder or the cage`);
                break;
            }
        for (let other = index + 1; other < layout.pieces.length; other += 1)
            if (gapOf(piece, layout.pieces[other]!) < 1)
                problems.push(`pieces ${index} and ${other} touch`);
    });
    const at = voxels(layout);
    // Where a player can stand: on something whole, with two blocks of room.
    const stands = (x: number, feet: number, z: number) =>
        at(x, feet - 1, z) === "solid" &&
        at(x, feet, z) !== "solid" &&
        at(x, feet, z) !== "tall" &&
        at(x, feet + 1, z) !== "solid" &&
        at(x, feet + 1, z) !== "tall";
    const open = (x: number, level: number, z: number) =>
        at(x, level, z) === "air" || at(x, level, z) === "ladder";
    const start = hiderCells()[0]!;
    const seen = new Uint8Array(SIZE * SIZE * (ROOF + 1));
    const mark = (x: number, feet: number, z: number) => (feet * SIZE + x) * SIZE + z;
    const queue: [number, number, number][] = [[start.x, 1, start.z]];
    seen[mark(start.x, 1, start.z)] = 1;
    const visit = (x: number, feet: number, z: number) => {
        if (seen[mark(x, feet, z)]) return;
        seen[mark(x, feet, z)] = 1;
        queue.push([x, feet, z]);
    };
    while (queue.length > 0) {
        const [x, feet, z] = queue.pop()!;
        for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1]
        ] as const) {
            const nx = x + dx;
            const nz = z + dz;
            if (stands(nx, feet, nz)) visit(nx, feet, nz);
            // A block up, with room overhead to jump it.
            if (stands(nx, feet + 1, nz) && open(x, feet + 2, z)) visit(nx, feet + 1, nz);
            // Down off an edge, three blocks at the most: no fall that hurts.
            for (let drop = 1; drop <= 3; drop += 1) {
                if (!open(nx, feet - drop + 1, nz)) break;
                if (stands(nx, feet - drop, nz)) {
                    visit(nx, feet - drop, nz);
                    break;
                }
            }
        }
        // Up and down the ladder, between its foot and the gallery's gap.
        const ladder = { x: layout.ladderX, z: EDGE + 1 };
        const top = { x: layout.ladderX, z: EDGE };
        if (x === ladder.x && z === ladder.z && feet === 1) visit(top.x, GALLERY + 1, top.z);
        if (x === top.x && z === top.z && feet === GALLERY + 1) visit(ladder.x, 1, ladder.z);
    }
    let missed = 0;
    for (let x = 1; x <= LAST; x += 1)
        for (let z = 1; z <= LAST; z += 1)
            for (const feet of [1, GALLERY + 1])
                if (stands(x, feet, z) && !seen[mark(x, feet, z)]) missed += 1;
    if (missed > 0) problems.push(`${missed} places to stand cannot be reached`);
    for (const cell of hiderCells())
        if (!stands(cell.x, 1, cell.z))
            problems.push(`a hider's start at ${cell.x},${cell.z} is taken`);
    return problems;
}

/** How many hiding places a hall has, by kind: what the measurement counts. */
export function hidingPlaces(layout: Layout): Record<PieceKind, number> {
    const counts: Record<PieceKind, number> = { wall: 0, hedge: 0, crate: 0, stack: 0 };
    for (const piece of layout.pieces) counts[piece.kind] += 1;
    return counts;
}

// ------------------------------------------------------------------ into the world

export function hallBox(center: { x: number; z: number }, floorY: number): Box {
    const half = Math.floor(SIZE / 2);
    return {
        x1: center.x - half,
        y1: floorY,
        z1: center.z - half,
        x2: center.x - half + SIZE - 1,
        y2: floorY + ROOF + 1,
        z2: center.z - half + SIZE - 1
    };
}

/** A facing turned with the hall. */
function facing(block: string, layout: Layout): string {
    return block.replace(/facing=(north|south|east|west)/, (_, way: string) => {
        const turned =
            layout.flipX && (way === "east" || way === "west")
                ? way === "east"
                    ? "west"
                    : "east"
                : layout.flipZ && (way === "north" || way === "south")
                  ? way === "north"
                      ? "south"
                      : "north"
                  : way;
        return `facing=${turned}`;
    });
}

/** A place in the hall's own terms, in the world. */
function worldOf(box: Box, layout: Layout, x: number, level: number, z: number) {
    return {
        x: box.x1 + (layout.flipX ? SIZE - 1 - x : x),
        y: box.y1 + 1 + level,
        z: box.z1 + (layout.flipZ ? SIZE - 1 - z : z)
    };
}

function placed(box: Box, layout: Layout, part: Omit<Part, "cell">): Fill {
    const a = worldOf(box, layout, part.x1, part.l1, part.z1);
    const b = worldOf(box, layout, part.x2, part.l2, part.z2);
    return {
        box: {
            x1: Math.min(a.x, b.x),
            y1: a.y,
            z1: Math.min(a.z, b.z),
            x2: Math.max(a.x, b.x),
            y2: b.y,
            z2: Math.max(a.z, b.z)
        },
        block: facing(part.block, layout)
    };
}

/** The cage's own box in the world: what comes down when the seekers are let go. */
export function cageBox(box: Box, layout: Layout): Box {
    return placed(box, layout, { ...CAGE, l1: 1, l2: 4, block: BARRIER }).box;
}

/**
 * What it is built of, each only into air: lights set in the floor and posts
 * of light at the corners, then the barrier under it, the outer walls and the
 * glass roof, the gallery and its fixtures, the cage, the hiding places, and
 * the floor last - a block of it in a corner the proof that the blocks stayed.
 */
export function hallFills(box: Box, layout: Layout): Fill[] {
    const fills: Fill[] = [];
    const floorY = box.y1 + 1;
    for (let x = 4; x <= LAST; x += 6)
        for (let z = 4; z <= LAST; z += 6)
            if (!(x >= CAGE.x1 && x <= CAGE.x2 && z >= CAGE.z1 && z <= CAGE.z2))
                fills.push(
                    placed(box, layout, { x1: x, l1: 0, z1: z, x2: x, l2: 0, z2: z, block: LIGHT })
                );
    for (const [x, z] of [
        [0, 0],
        [0, SIZE - 1],
        [SIZE - 1, 0],
        [SIZE - 1, SIZE - 1]
    ] as const)
        fills.push(
            placed(box, layout, { x1: x, l1: 0, z1: z, x2: x, l2: ROOF - 1, z2: z, block: LIGHT })
        );
    fills.push(
        { box: { ...box, y2: box.y1 }, block: BARRIER },
        { box: { ...box, x2: box.x1, y1: floorY, y2: box.y2 - 1 }, block: OUTER },
        { box: { ...box, x1: box.x2, y1: floorY, y2: box.y2 - 1 }, block: OUTER },
        { box: { ...box, z2: box.z1, y1: floorY, y2: box.y2 - 1 }, block: OUTER },
        { box: { ...box, z1: box.z2, y1: floorY, y2: box.y2 - 1 }, block: OUTER },
        { box: { ...box, y1: box.y2 }, block: ROOF_BLOCK }
    );
    for (const part of [...structure(layout), ...cageParts()])
        fills.push(placed(box, layout, part));
    for (const piece of layout.pieces)
        fills.push(
            placed(box, layout, {
                x1: piece.x,
                l1: piece.level,
                z1: piece.z,
                x2: piece.x + piece.w - 1,
                l2: piece.level + piece.h - 1,
                z2: piece.z + piece.d - 1,
                block: PIECE_BLOCKS[piece.kind]
            })
        );
    // The floor last: its corner, where no light is set, is the proof.
    fills.push(
        placed(box, layout, { x1: 1, l1: 0, z1: 1, x2: LAST, l2: 0, z2: LAST, block: FLOOR })
    );
    return fills;
}

/** Where the `index`th hider starts, and where the `index`th seeker waits. */
export function hiderSpot(box: Box, layout: Layout, index: number): Spot {
    const cell = hiderCells()[index % MOST]!;
    const at = worldOf(box, layout, cell.x, 1, cell.z);
    const middle = worldOf(box, layout, MIDDLE, 1, MIDDLE);
    return {
        ...at,
        yaw: Math.round((-Math.atan2(at.x - middle.x, at.z - middle.z) * 180) / Math.PI)
    };
}

export function seekerSpot(box: Box, layout: Layout, index: number): Spot {
    const cell = seekerCells()[index % seekerCells().length]!;
    return { ...worldOf(box, layout, cell.x, 1, cell.z), yaw: 0 };
}

// ------------------------------------------------------------------ the game

/** Who seeks first: drawn from the run's id among the players, in the order of
 *  their names; never everybody. */
export function seekersFor(seed: string, names: readonly string[], wanted: number): string[] {
    const count = Math.max(1, Math.min(wanted, names.length - 1));
    const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return shuffled(sorted, seeded(`${seed}-seekers`)).slice(0, count);
}

/**
 * Who found a hider who was hurt: of the seekers who struck since the last
 * look, the nearest within `FIND_REACH`. Nobody else can strike, and no fall in
 * the hall hurts, so a hit near a seeker who struck is theirs.
 */
export function foundBy(
    hider: { x: number; y: number; z: number },
    struck: readonly { name: string; x: number; y: number; z: number }[]
): string | null {
    let best: string | null = null;
    let nearest = FIND_REACH;
    for (const one of struck) {
        const away = Math.hypot(one.x - hider.x, one.y - hider.y, one.z - hider.z);
        if (away <= nearest) {
            nearest = away;
            best = one.name;
        }
    }
    return best;
}

const findSchema = z.object({ hider: z.string(), by: z.string(), at: z.number() });

export const stateSchema = z.object({
    design: z.number().int().default(DESIGN),
    /** Seeking from the start, and everybody found since, in order. */
    seekers: z.array(z.string()).default([]),
    finds: z.array(findSchema).default([]),
    /** Whether the cage has come down. */
    released: z.boolean().default(false),
    /** Milliseconds each hider has been hidden and on the server, by name. */
    hidden: z.record(z.number()).default({}),
    /** When the hidden time was last added to. */
    countedAt: z.number().nullable().default(null)
});
export type SeekState = z.infer<typeof stateSchema>;

export function stateOf(game: unknown): SeekState | null {
    if (game === null || game === undefined) return null;
    const parsed = stateSchema.safeParse(game);
    return parsed.success && parsed.data.seekers.length > 0 ? parsed.data : null;
}

/** Whether somebody seeks: from the start, or since they were found. */
export function seeks(state: SeekState, name: string): boolean {
    const lower = name.toLowerCase();
    return (
        state.seekers.some((one) => one.toLowerCase() === lower) ||
        state.finds.some((one) => one.hider.toLowerCase() === lower)
    );
}

/** The scores: a point a second hidden, `FIND_POINTS` a find. */
export function scoresOf(state: SeekState | null, names: readonly string[]): Map<string, number> {
    return new Map(
        names.map((name) => {
            const hidden = Math.floor((state?.hidden[name] ?? 0) / 1000);
            const finds =
                state?.finds.filter((one) => one.by.toLowerCase() === name.toLowerCase()).length ??
                0;
            return [name, hidden + finds * FIND_POINTS];
        })
    );
}

/** The two sides, each blind to the other's names, nobody hurting their own. */
export const TEAMS = ["pe_hs_seek", "pe_hs_hide"] as const;
export const DEALT = "pe_hsd";
export const TAKEN = "pe_hst";
export const READ_DEALT = `execute as @a run scoreboard players get @s ${DEALT}`;
export const READ_TAKEN = `execute as @a run scoreboard players get @s ${TAKEN}`;

export function setupLines(names: readonly [string, string]): string[] {
    const lines: string[] = [];
    TEAMS.forEach((team, index) => {
        lines.push(
            `team remove ${team}`,
            `team add ${team} ${JSON.stringify({ text: names[index] })}`,
            `team modify ${team} color ${index === 0 ? "red" : "green"}`,
            `team modify ${team} friendlyFire false`,
            `team modify ${team} nametagVisibility hideForOtherTeams`
        );
    });
    for (const [objective, criterion] of [
        [DEALT, "minecraft.custom:minecraft.damage_dealt"],
        [TAKEN, "minecraft.custom:minecraft.damage_taken"]
    ] as const)
        lines.push(
            `scoreboard objectives remove ${objective}`,
            `scoreboard objectives add ${objective} ${criterion}`
        );
    return lines;
}

export const TEARDOWN = [
    ...TEAMS.map((team) => `team remove ${team}`),
    ...[DEALT, TAKEN].map((objective) => `scoreboard objectives remove ${objective}`)
];

/** Onto a side's team, only if they are on none of the server's own - or, found,
 *  from the hiders' onto the seekers'. */
export function joinSide(name: string, seeker: boolean): string[] {
    return seeker
        ? [
              `execute if entity @a[name=${name},team=] run team join ${TEAMS[0]} ${name}`,
              `execute if entity @a[name=${name},team=${TEAMS[1]}] run team join ${TEAMS[0]} ${name}`
          ]
        : [`execute if entity @a[name=${name},team=] run team join ${TEAMS[1]} ${name}`];
}

/** A seeker before the cage comes down: blind, and unable to walk. */
export function waitingLines(name: string): string[] {
    return [
        `effect give ${name} minecraft:blindness 3 0 true`,
        `effect give ${name} minecraft:slowness 3 10 true`
    ];
}

/** Let go: their sight and their legs back. */
export function releasedLines(name: string): string[] {
    return [`effect clear ${name} minecraft:blindness`, `effect clear ${name} minecraft:slowness`];
}

/** The cage taken down: its barrier, only inside its own box. */
export function cageDown(box: Box, layout: Layout): string {
    const cage = cageBox(box, layout);
    return `execute in minecraft:overworld run fill ${cage.x1} ${cage.y1} ${cage.z1} ${cage.x2} ${cage.y2} ${cage.z2} minecraft:air replace ${BARRIER}`;
}

/** Nobody hurt: a punch a fifth of one, mended at once. */
export function unhurtLines(name: string): string[] {
    return [
        `effect give ${name} minecraft:resistance 3 3 true`,
        `effect give ${name} minecraft:regeneration 3 2 true`,
        `effect give ${name} minecraft:saturation 3 0 true`
    ];
}

/** A hider cannot strike: only a seeker's blow ever finds anybody. */
export function hiderLine(name: string): string {
    return `effect give ${name} minecraft:weakness 3 100 true`;
}
