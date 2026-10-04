/**
 * Hide and seek's map and rules.
 *
 * A closed house in the air: nine rooms, three by three, 39 by 39 inside under
 * a solid roof, joined by doorways in the walls between them. The seekers wait
 * in a cage in the middle room. Everything else is drawn from the run's id
 * (`layoutFor`): where each doorway is, which two corner rooms have a loft, and
 * every hiding place.
 *
 * The hiding places are the ones hide and seek players actually use, not only
 * things to stand behind:
 *
 * - **Closets**: a cupboard against a wall with a door; step in, shut it, and a
 *   seeker has to open it to see in.
 * - **Hatches**: a trapdoor in the floor over a pit two deep with a ladder in
 *   it; drop in and close it over your head.
 * - **Bushes**: a hollow hedge with a way in on one side, open only from there.
 * - **Lofts**: a platform under the roof along a corner room's outer wall,
 *   reached by a ladder - seekers look ahead, not up - with crates on it, and
 *   more under it.
 * - **Cover**: walls, hedges, crates and stacks of them to crouch behind, in
 *   rooms lit by four lamps in their floor and no more, so their corners are
 *   dim.
 *
 * Nametags are hidden from the other side (`setupLines`) and no effect shows
 * particles, so a hider is found by looking, never by a label through a wall.
 *
 * A map is checked before it is built (`layoutProblems`): every piece inside
 * one room and clear of the doorways, the ladders, the lamps and the cage, no
 * two pieces touching (a block of air between them, so nothing is sealed off by
 * accident), every place to stand reachable from the hiders' start the way a
 * player moves (a block up at a time, through doors, up the ladders), and none
 * of them dark enough for a monster to spawn in. A map that breaks a rule is
 * drawn again; after `DRAWS` tries the house is used with nothing in it but
 * its rooms and lofts, which keeps every rule.
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
export const DESIGN = 2;

/** The house, walls included: 41 by 41. */
const SIZE = 41;
const LAST = SIZE - 2;
/** The walls between the rooms, the same lines across x and z. */
const WALLS = [13, 27] as const;
/** The rooms' spans along either axis, between the walls. */
const SPANS = [
    [1, 12],
    [14, 26],
    [28, 39]
] as const;
/** Levels over the floor (0): a loft's floor at 4, the roof at 8. The pits go
 *  down to -1, over a foundation at -2 and the barrier under it all at -3. */
const LOFT = 4;
const ROOF = 8;
const DEEPEST = -2;
const BASE = 3;
/** How deep a loft is from its wall, and how high a doorway is. */
const LOFT_DEPTH = 3;
const DOOR_HIGH = 3;
/** The middle of the middle room, where the seekers' cage stands. */
const MIDDLE = 20;

/** How many can play. */
export const MOST = 12;
/** How far from its center the ground under it is judged. */
export const REACH = Math.ceil(SIZE / 2);

/** What a find is worth to its seeker: half a minute hidden. */
export const FIND_POINTS = 30;
/** How close a seeker who struck must be to a hider who was hurt. */
export const FIND_REACH = 5;

/** Times a map is drawn again before the house is used empty. */
const DRAWS = 30;

const BARRIER = "minecraft:barrier";
const OUTER = "minecraft:stone_bricks";
const INNER = "minecraft:spruce_planks";
const FOUNDATION = "minecraft:stone";
const FLOOR = "minecraft:smooth_stone";
const LIGHT = "minecraft:sea_lantern";
const ROOF_BLOCK = "minecraft:dark_oak_planks";
const BOARDS = "minecraft:birch_planks";
const POST = "minecraft:spruce_log";
const RAIL = "minecraft:spruce_fence";
const LADDER = "minecraft:ladder";
const CUPBOARD = "minecraft:oak_planks";
const DOOR = "minecraft:oak_door";
const HATCH = "minecraft:spruce_trapdoor";
const LEAVES = "minecraft:oak_leaves[persistent=true]";
const PIECE_BLOCKS = {
    wall: "minecraft:bricks",
    hedge: LEAVES,
    crate: "minecraft:barrel[facing=up]",
    stack: "minecraft:barrel[facing=up]"
} as const;

/** Every kind of block the house is built of, as bare ids: the ladders first,
 *  which come down before what they hang on (`arena.teardown`), and the doors
 *  and hatches before the floor and the cupboards round them. */
export const HALL_BLOCKS: readonly string[] = [
    LADDER,
    DOOR,
    HATCH,
    BARRIER,
    OUTER,
    INNER,
    FOUNDATION,
    FLOOR,
    LIGHT,
    ROOF_BLOCK,
    BOARDS,
    POST,
    RAIL,
    CUPBOARD,
    "minecraft:bricks",
    "minecraft:oak_leaves",
    "minecraft:barrel"
];

// ------------------------------------------------------------------ the map

export type PieceKind = keyof typeof PIECE_BLOCKS | "closet" | "bush" | "pit";
export type Side = "north" | "south" | "east" | "west";

/** A hiding place, in the house's own blocks: `x`, `z` its corner with the
 *  least of each, `level` the first level it fills, `w` by `d` across, `h`
 *  high. A closet's `side` is the wall it stands against; a bush's, the side
 *  its way in is on. */
export interface Piece {
    readonly kind: PieceKind;
    readonly x: number;
    readonly z: number;
    readonly level: number;
    readonly w: number;
    readonly d: number;
    readonly h: number;
    readonly side?: Side;
}

/** A doorway two wide and `DOOR_HIGH` high in a wall between two rooms: in the
 *  wall at x = `line` from z = `at` when `across` is "x", or the other way. */
export interface Doorway {
    readonly across: "x" | "z";
    readonly line: number;
    readonly at: number;
}

/** A loft over `x1..x2` by `z1..z2`, against an outer wall; its open edge is
 *  the row at `edge` (along x when `across` is "x"), the room lies `inward`
 *  of it, and its ladder comes up at `ladder` along the edge. */
export interface Loft {
    readonly x1: number;
    readonly z1: number;
    readonly x2: number;
    readonly z2: number;
    readonly across: "x" | "z";
    readonly edge: number;
    readonly inward: 1 | -1;
    readonly ladder: number;
}

export interface Layout {
    /** Mirrored across x, across z. */
    readonly flipX: boolean;
    readonly flipZ: boolean;
    readonly doorways: readonly Doorway[];
    readonly lofts: readonly Loft[];
    readonly pieces: readonly Piece[];
    /** Whether it fell back to the empty house. */
    readonly bare: boolean;
}

/** The kinds of cover, by where they go: on the floor, under a loft (three
 *  high at most) and on it (two at most). */
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
        { kind: "hedge", w: 1, d: 2, h: 2 }
    ],
    over: [
        { kind: "crate", w: 1, d: 1, h: 1 },
        { kind: "stack", w: 2, d: 1, h: 2 },
        { kind: "hedge", w: 1, d: 2, h: 2 },
        { kind: "hedge", w: 2, d: 1, h: 2 }
    ]
};

/** How many of each are wanted: a house worth hiding in. */
const WANTED = { closet: 7, pit: 6, bush: 4, floor: 18, under: 4, over: 4 } as const;
const SIDES: readonly Side[] = ["north", "south", "east", "west"];

/** The seekers' cage: three by three inside, in the middle of the middle room. */
export const CAGE = { x1: MIDDLE - 2, z1: MIDDLE - 2, x2: MIDDLE + 2, z2: MIDDLE + 2 } as const;

/** Which room span a coordinate is in, or -1 on a wall. */
function spanOf(at: number): number {
    return SPANS.findIndex(([from, to]) => at >= from && at <= to);
}

/** The lamps in each room's floor: four, a little in from its corners, so no
 *  corner is dark enough for a monster; round the cage in the middle room. */
function lamps(): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    for (let rx = 0; rx < 3; rx += 1)
        for (let rz = 0; rz < 3; rz += 1) {
            if (rx === 1 && rz === 1) continue;
            const [x1, x2] = SPANS[rx]!;
            const [z1, z2] = SPANS[rz]!;
            for (const x of [x1 + 2, x2 - 2]) for (const z of [z1 + 2, z2 - 2]) out.push({ x, z });
        }
    for (const x of [15, 25]) for (const z of [15, 25]) out.push({ x, z });
    return out;
}
const LAMPS = lamps();

function insideLoft(loft: Loft, x: number, z: number): boolean {
    return x >= loft.x1 && x <= loft.x2 && z >= loft.z1 && z <= loft.z2;
}

/** The row of a loft against its wall: the only row cover goes in, on it or
 *  under it, so the rows in front of it are always a way through. */
function loftWall(loft: Loft): number {
    return loft.inward === 1 ? loft.edge - (LOFT_DEPTH - 1) : loft.edge + (LOFT_DEPTH - 1);
}

/** The lamp set in a loft's floor: halfway along it, by the wall, lighting
 *  the loft and the room under it, which the room's floor lamps do not reach. */
function loftLamp(loft: Loft): { x: number; z: number } {
    const wall = loftWall(loft);
    return loft.across === "x"
        ? { x: wall, z: Math.floor((loft.z1 + loft.z2) / 2) }
        : { x: Math.floor((loft.x1 + loft.x2) / 2), z: wall };
}

/** Every lamp in the house: in the rooms' floors and the lofts'. */
function lampsOf(layout: Pick<Layout, "lofts">): { x: number; level: number; z: number }[] {
    return [
        ...LAMPS.map((lamp) => ({ ...lamp, level: 0 })),
        ...layout.lofts.map((loft) => ({ ...loftLamp(loft), level: LOFT }))
    ];
}

/** A loft's edge cell at `along`, and the cell the ladder stands in there. */
function edgeCell(loft: Loft, along: number): { x: number; z: number } {
    return loft.across === "x" ? { x: loft.edge, z: along } : { x: along, z: loft.edge };
}
function ladderCell(loft: Loft): { x: number; z: number } {
    const at = edgeCell(loft, loft.ladder);
    return loft.across === "x"
        ? { ...at, x: at.x + loft.inward }
        : { ...at, z: at.z + loft.inward };
}
/** Where the posts under a loft's edge stand along it: its ends and middle. */
function postsOf(loft: Loft): number[] {
    const [from, to] = loft.across === "x" ? [loft.z1, loft.z2] : [loft.x1, loft.x2];
    return [from, Math.floor((from + to) / 2), to];
}
/** The way a ladder faces: away from the edge, into the room. */
function ladderFacing(loft: Loft): Side {
    if (loft.across === "x") return loft.inward === 1 ? "east" : "west";
    return loft.inward === 1 ? "south" : "north";
}

/** What else stands in the house besides its hiding places, each as a piece
 *  the hiding places must keep a block away from: the way through every
 *  doorway, the lamps, each loft's posts, ladder and the floor it comes out
 *  on, and the cage with the ring round it the hiders start on. */
function fixtures(layout: Pick<Layout, "doorways" | "lofts">): Piece[] {
    const block = (
        x: number,
        z: number,
        level: number,
        w: number,
        d: number,
        h: number
    ): Piece => ({
        kind: "wall",
        x,
        z,
        level,
        w,
        d,
        h
    });
    const out: Piece[] = [];
    for (const door of layout.doorways)
        out.push(
            door.across === "x"
                ? block(door.line - 1, door.at, 1, 3, 2, DOOR_HIGH)
                : block(door.at, door.line - 1, 1, 2, 3, DOOR_HIGH)
        );
    for (const lamp of LAMPS) out.push(block(lamp.x, lamp.z, 1, 1, 1, 1));
    for (const loft of layout.lofts) {
        const lamp = loftLamp(loft);
        out.push(block(lamp.x, lamp.z, LOFT + 1, 1, 1, 1));
        for (const along of [...postsOf(loft), loft.ladder]) {
            const at = edgeCell(loft, along);
            out.push(block(at.x, at.z, 1, 1, 1, LOFT - 1));
        }
        // The ladder and the floor in front of it.
        const foot = ladderCell(loft);
        out.push(
            loft.across === "x"
                ? block(Math.min(foot.x, foot.x + loft.inward), foot.z, 1, 2, 1, LOFT)
                : block(foot.x, Math.min(foot.z, foot.z + loft.inward), 1, 1, 2, LOFT)
        );
        // Where it comes out on the loft.
        const top = edgeCell(loft, loft.ladder);
        out.push(
            loft.across === "x"
                ? block(Math.min(top.x, top.x - loft.inward), top.z, LOFT + 1, 2, 1, 2)
                : block(top.x, Math.min(top.z, top.z - loft.inward), LOFT + 1, 1, 2, 2)
        );
    }
    out.push(block(CAGE.x1 - 1, CAGE.z1 - 1, 1, 7, 7, 4));
    return out;
}

function apart(a1: number, a2: number, b1: number, b2: number): number {
    return Math.max(a1 - b2, b1 - a2) - 1;
}

/** The air between two pieces across the floor; pieces on different levels
 *  never meet. */
function gapOf(a: Piece, b: Piece): number {
    if (a.level + a.h - 1 < b.level || b.level + b.h - 1 < a.level) return Number.POSITIVE_INFINITY;
    return Math.max(
        apart(a.x, a.x + a.w - 1, b.x, b.x + b.w - 1),
        apart(a.z, a.z + a.d - 1, b.z, b.z + b.d - 1)
    );
}

/** A closet's cupboard, pocket and door cells, from the wall it stands against. */
function closetCells(piece: Piece): {
    back: { x: number; z: number };
    front: { x: number; z: number };
    behind: { x: number; z: number };
} {
    switch (piece.side) {
        case "west":
            return {
                back: { x: piece.x, z: piece.z + 1 },
                front: { x: piece.x + 1, z: piece.z + 1 },
                behind: { x: piece.x - 1, z: piece.z + 1 }
            };
        case "east":
            return {
                back: { x: piece.x + 1, z: piece.z + 1 },
                front: { x: piece.x, z: piece.z + 1 },
                behind: { x: piece.x + 2, z: piece.z + 1 }
            };
        case "north":
            return {
                back: { x: piece.x + 1, z: piece.z },
                front: { x: piece.x + 1, z: piece.z + 1 },
                behind: { x: piece.x + 1, z: piece.z - 1 }
            };
        default:
            return {
                back: { x: piece.x + 1, z: piece.z + 1 },
                front: { x: piece.x + 1, z: piece.z },
                behind: { x: piece.x + 1, z: piece.z + 2 }
            };
    }
}

/** A bush's pocket, and the cell its way in is through. */
function bushCells(piece: Piece): {
    pocket: { x: number; z: number };
    way: { x: number; z: number };
} {
    const pocket = { x: piece.x + 1, z: piece.z + 1 };
    const step = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[
        piece.side ?? "north"
    ];
    return { pocket, way: { x: pocket.x + step[0]!, z: pocket.z + step[1]! } };
}

function isWallLine(at: number): boolean {
    return at === 0 || at === SIZE - 1 || (WALLS as readonly number[]).includes(at);
}

/** Every rule a piece breaks by itself. */
function pieceProblems(piece: Piece, lofts: readonly Loft[], index = 0): string[] {
    const problems: string[] = [];
    const x2 = piece.x + piece.w - 1;
    const z2 = piece.z + piece.d - 1;
    if (piece.x < 1 || piece.z < 1 || x2 > LAST || z2 > LAST) {
        problems.push(`piece ${index} is outside the house`);
        return problems;
    }
    if (
        spanOf(piece.x) < 0 ||
        spanOf(piece.x) !== spanOf(x2) ||
        spanOf(piece.z) < 0 ||
        spanOf(piece.z) !== spanOf(z2)
    )
        problems.push(`piece ${index} is not inside one room`);
    const cells: { x: number; z: number }[] = [];
    for (let x = piece.x; x <= x2; x += 1)
        for (let z = piece.z; z <= z2; z += 1) cells.push({ x, z });
    const loftOver = (cell: { x: number; z: number }) =>
        lofts.find((loft) => insideLoft(loft, cell.x, cell.z));
    if (piece.level === 1) {
        const under = cells.filter((cell) => loftOver(cell)).length;
        const loft = loftOver(cells[0]!);
        if (
            piece.kind !== "pit" &&
            loft &&
            under === cells.length &&
            cells.some((cell) => (loft.across === "x" ? cell.x : cell.z) !== loftWall(loft))
        )
            problems.push(`piece ${index} is not against the wall under the loft`);
        if (piece.kind === "pit") {
            if (piece.w !== 1 || piece.d !== 1 || piece.h !== 1)
                problems.push(`pit ${index} is not one block`);
            if (piece.x === 1 && piece.z === 1)
                problems.push(`pit ${index} is in the floor's corner`);
        } else if (under > 0) {
            if (under < cells.length) problems.push(`piece ${index} stands half under a loft`);
            else if (piece.kind === "closet" || piece.kind === "bush")
                problems.push(`piece ${index} is under a loft`);
            else if (piece.h > LOFT - 1) problems.push(`piece ${index} has no room under the loft`);
        } else if (piece.h > ROOF - 2) problems.push(`piece ${index} reaches the roof`);
        if (piece.kind === "closet") {
            const across = piece.side === "west" || piece.side === "east";
            if (piece.h !== 3 || piece.w !== (across ? 2 : 3) || piece.d !== (across ? 3 : 2))
                problems.push(`closet ${index} is the wrong size`);
            else {
                const { behind } = closetCells(piece);
                if (!isWallLine(across ? behind.x : behind.z))
                    problems.push(`closet ${index} is not against a wall`);
            }
        }
        if (piece.kind === "bush" && (piece.w !== 3 || piece.d !== 3 || piece.h !== 3))
            problems.push(`bush ${index} is the wrong size`);
    } else if (piece.level === LOFT + 1) {
        const loft = loftOver(cells[0]!);
        if (
            !loft ||
            cells.some((cell) => !insideLoft(loft, cell.x, cell.z)) ||
            cells.some((cell) => (loft.across === "x" ? cell.x : cell.z) !== loftWall(loft))
        )
            problems.push(`piece ${index} is off the loft`);
        if (piece.h > ROOF - LOFT - 2) problems.push(`piece ${index} has no head room over it`);
        if (piece.kind === "closet" || piece.kind === "bush" || piece.kind === "pit")
            problems.push(`piece ${index} cannot go on a loft`);
    } else problems.push(`piece ${index} floats`);
    return problems;
}

/** The doorways of a house: one in every wall between two rooms, two wide, a
 *  few blocks in from either end so it never meets a loft or a corner. */
function drawDoorways(pick: (from: number, to: number) => number): Doorway[] {
    const out: Doorway[] = [];
    for (const across of ["x", "z"] as const)
        for (const line of WALLS)
            for (const [from, to] of SPANS) out.push({ across, line, at: pick(from + 3, to - 4) });
    return out;
}

/** Two corner rooms with a loft, each along one of its outer walls. */
function drawLofts(random: () => number, pick: (from: number, to: number) => number): Loft[] {
    const corners = shuffled(
        [
            [0, 0],
            [0, 2],
            [2, 0],
            [2, 2]
        ] as const,
        random
    ).slice(0, 2);
    return corners.map(([rx, rz]) => {
        const [x1, x2] = SPANS[rx]!;
        const [z1, z2] = SPANS[rz]!;
        const across: "x" | "z" = random() < 0.5 ? "x" : "z";
        const low = across === "x" ? rx === 0 : rz === 0;
        const [from, to] = across === "x" ? [z1, z2] : [x1, x2];
        const mid = Math.floor((from + to) / 2);
        let ladder = pick(from + 2, to - 2);
        if (Math.abs(ladder - mid) <= 1) ladder = ladder < mid ? mid - 2 : mid + 2;
        if (across === "x") {
            const edge = low ? x1 + LOFT_DEPTH - 1 : x2 - LOFT_DEPTH + 1;
            return {
                x1: low ? x1 : edge,
                x2: low ? edge : x2,
                z1,
                z2,
                across,
                edge,
                inward: low ? 1 : -1,
                ladder
            };
        }
        const edge = low ? z1 + LOFT_DEPTH - 1 : z2 - LOFT_DEPTH + 1;
        return {
            x1,
            x2,
            z1: low ? z1 : edge,
            z2: low ? edge : z2,
            across,
            edge,
            inward: low ? 1 : -1,
            ladder
        };
    });
}

/**
 * A run's house: its doorways, its lofts and the hiding places, drawn from the
 * run's id - each piece kept only where it breaks no rule of its own and
 * touches nothing - and the whole checked once drawn.
 */
export function layoutFor(seed: string): Layout {
    let first: Layout | null = null;
    for (let draw = 0; draw < DRAWS; draw += 1) {
        const layout = drawLayout(seed, draw);
        first ??= layout;
        if (layoutProblems(layout).length === 0) return layout;
    }
    return { ...first!, flipX: false, flipZ: false, pieces: [], bare: true };
}

/** One draw of a run's house, unchecked: what `layoutFor` tries in turn. */
export function drawLayout(seed: string, draw: number): Layout {
    const random = seeded(`${seed}-hide-${draw}`);
    const pick = (from: number, to: number) => from + Math.floor(random() * (to - from + 1));
    const choose = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
    const doorways = drawDoorways(pick);
    const lofts = drawLofts(random, pick);
    const fixed = fixtures({ doorways, lofts });
    const pieces: Piece[] = [];
    const tryPlace = (piece: Piece) => {
        if (pieceProblems(piece, lofts).length > 0) return false;
        if (piece.kind === "pit" && LAMPS.some((lamp) => lamp.x === piece.x && lamp.z === piece.z))
            return false;
        if ([...fixed, ...pieces].some((one) => gapOf(one, piece) < 1)) return false;
        pieces.push(piece);
        return true;
    };
    const tries = (wanted: number, make: () => Piece) => {
        let placed = 0;
        for (let attempt = 0; attempt < 400 && placed < wanted; attempt += 1)
            if (tryPlace(make())) placed += 1;
    };
    // Closets first: they need a wall, and a stretch of it free.
    tries(WANTED.closet, () => {
        const side = choose(SIDES);
        const across = side === "west" || side === "east";
        const room = { x: choose(SPANS), z: choose(SPANS) };
        const w = across ? 2 : 3;
        const d = across ? 3 : 2;
        const x =
            side === "west"
                ? room.x[0]
                : side === "east"
                  ? room.x[1] - 1
                  : pick(room.x[0], room.x[1] - 2);
        const z =
            side === "north"
                ? room.z[0]
                : side === "south"
                  ? room.z[1] - 1
                  : pick(room.z[0], room.z[1] - 2);
        return { kind: "closet", x, z, level: 1, w, d, h: 3, side };
    });
    tries(WANTED.bush, () => ({
        kind: "bush",
        x: pick(1, LAST - 2),
        z: pick(1, LAST - 2),
        level: 1,
        w: 3,
        d: 3,
        h: 3,
        side: choose(SIDES)
    }));
    tries(WANTED.pit, () => ({
        kind: "pit",
        x: pick(1, LAST),
        z: pick(1, LAST),
        level: 1,
        w: 1,
        d: 1,
        h: 1
    }));
    for (const zone of ["floor", "under", "over"] as const)
        tries(WANTED[zone], () => {
            const shape = choose(SHAPES[zone]);
            if (zone === "floor")
                return {
                    ...shape,
                    x: pick(1, LAST - shape.w + 1),
                    z: pick(1, LAST - shape.d + 1),
                    level: 1
                };
            const loft = choose(lofts);
            return {
                ...shape,
                x: pick(loft.x1, loft.x2 - shape.w + 1),
                z: pick(loft.z1, loft.z2 - shape.d + 1),
                level: zone === "under" ? 1 : LOFT + 1
            };
        });
    return {
        flipX: random() < 0.5,
        flipZ: random() < 0.5,
        doorways,
        lofts,
        pieces,
        bare: false
    };
}

// ------------------------------------------------------------------ the blocks

/** How a player meets a block: stands on and bumps into it (`solid`), bumps
 *  into it but cannot stand on it (`tall`), climbs it, walks through it once
 *  opened, or stands on it shut. */
type Cell = "air" | "solid" | "tall" | "ladder" | "door" | "hatch";

const CELL_OF: Readonly<Record<string, Cell>> = {
    [RAIL]: "tall",
    [BARRIER]: "solid",
    [LADDER]: "ladder",
    [DOOR]: "door",
    [HATCH]: "hatch"
};
/** Blocks light goes through: everything here but whole blocks. */
const LIT_THROUGH = new Set([RAIL, BARRIER, LADDER, DOOR, HATCH, "minecraft:oak_leaves"]);

const bare = (block: string) => block.replace(/\[.*$/, "");

/** The inside of the house, block by block, in its own unmirrored terms: x and
 *  z 1 to `LAST`, levels `DEEPEST` to the one under the roof. */
class Blocks {
    private readonly cells: (string | null)[];
    static readonly LEVELS = ROOF - DEEPEST;

    constructor() {
        this.cells = new Array(SIZE * SIZE * Blocks.LEVELS).fill(null);
    }

    private index(x: number, level: number, z: number): number {
        return ((level - DEEPEST) * SIZE + x) * SIZE + z;
    }

    static inside(x: number, level: number, z: number): boolean {
        return x >= 1 && z >= 1 && x <= LAST && z <= LAST && level >= DEEPEST && level < ROOF;
    }

    get(x: number, level: number, z: number): string | null {
        return Blocks.inside(x, level, z) ? this.cells[this.index(x, level, z)]! : OUTER;
    }

    /** Sets a box, never over a block already set: what is set first wins. */
    set(
        block: string,
        x1: number,
        l1: number,
        z1: number,
        x2: number,
        l2: number,
        z2: number
    ): void {
        for (let x = x1; x <= x2; x += 1)
            for (let level = l1; level <= l2; level += 1)
                for (let z = z1; z <= z2; z += 1)
                    if (Blocks.inside(x, level, z) && this.cells[this.index(x, level, z)] === null)
                        this.cells[this.index(x, level, z)] = block;
    }

    /** Reserves a box as air: nothing set later fills it. */
    clear(x1: number, l1: number, z1: number, x2: number, l2: number, z2: number): void {
        this.set("", x1, l1, z1, x2, l2, z2);
    }

    cell(x: number, level: number, z: number): Cell {
        const block = this.get(x, level, z);
        if (!block) return "air";
        return CELL_OF[bare(block)] ?? "solid";
    }

    litThrough(x: number, level: number, z: number): boolean {
        const block = this.get(x, level, z);
        return !block || LIT_THROUGH.has(bare(block));
    }

    /** Every block set, merged into as few boxes as it takes, by kind. */
    boxes(): {
        block: string;
        x1: number;
        l1: number;
        z1: number;
        x2: number;
        l2: number;
        z2: number;
    }[] {
        const out: {
            block: string;
            x1: number;
            l1: number;
            z1: number;
            x2: number;
            l2: number;
            z2: number;
        }[] = [];
        const done = new Uint8Array(this.cells.length);
        const same = (block: string, x: number, level: number, z: number) =>
            Blocks.inside(x, level, z) &&
            !done[this.index(x, level, z)] &&
            this.cells[this.index(x, level, z)] === block;
        for (let level = DEEPEST; level < ROOF; level += 1)
            for (let z = 1; z <= LAST; z += 1)
                for (let x = 1; x <= LAST; x += 1) {
                    const block = this.cells[this.index(x, level, z)];
                    if (!block || done[this.index(x, level, z)]) continue;
                    let x2 = x;
                    while (same(block, x2 + 1, level, z)) x2 += 1;
                    let z2 = z;
                    const row = (zz: number, ll: number) => {
                        for (let xx = x; xx <= x2; xx += 1)
                            if (!same(block, xx, ll, zz)) return false;
                        return true;
                    };
                    while (row(z2 + 1, level)) z2 += 1;
                    let l2 = level;
                    const slab = (ll: number) => {
                        for (let zz = z; zz <= z2; zz += 1) if (!row(zz, ll)) return false;
                        return true;
                    };
                    while (l2 + 1 < ROOF && slab(l2 + 1)) l2 += 1;
                    for (let ll = level; ll <= l2; ll += 1)
                        for (let zz = z; zz <= z2; zz += 1)
                            for (let xx = x; xx <= x2; xx += 1) done[this.index(xx, ll, zz)] = 1;
                    out.push({ block, x1: x, l1: level, z1: z, x2, l2, z2 });
                }
        return out;
    }
}

/** Everything inside the house, in its own terms: fixtures first, so no piece
 *  can ever take their blocks, then the pieces, then the floor under it all. */
function blocksOf(layout: Layout): Blocks {
    const blocks = new Blocks();
    // The pits and the closets' and bushes' insides are air whatever comes after.
    for (const piece of layout.pieces) {
        if (piece.kind === "pit") {
            blocks.set(
                `${HATCH}[facing=north,half=bottom,open=false]`,
                piece.x,
                1,
                piece.z,
                piece.x,
                1,
                piece.z
            );
            blocks.set(`${LADDER}[facing=south]`, piece.x, -1, piece.z, piece.x, 0, piece.z);
        } else if (piece.kind === "closet") {
            const { back, front } = closetCells(piece);
            blocks.clear(back.x, 1, back.z, back.x, 2, back.z);
            blocks.set(
                `${DOOR}[facing=${piece.side},half=lower,hinge=left,open=false]`,
                front.x,
                1,
                front.z,
                front.x,
                1,
                front.z
            );
            blocks.set(
                `${DOOR}[facing=${piece.side},half=upper,hinge=left,open=false]`,
                front.x,
                2,
                front.z,
                front.x,
                2,
                front.z
            );
        } else if (piece.kind === "bush") {
            const { pocket, way } = bushCells(piece);
            blocks.clear(pocket.x, 1, pocket.z, pocket.x, 2, pocket.z);
            blocks.clear(way.x, 1, way.z, way.x, 2, way.z);
        }
    }
    // The walls between the rooms, open at each doorway.
    for (const door of layout.doorways)
        if (door.across === "x")
            blocks.clear(door.line, 1, door.at, door.line, DOOR_HIGH, door.at + 1);
        else blocks.clear(door.at, 1, door.line, door.at + 1, DOOR_HIGH, door.line);
    for (const line of WALLS) {
        blocks.set(INNER, line, 1, 1, line, ROOF - 1, LAST);
        blocks.set(INNER, 1, 1, line, LAST, ROOF - 1, line);
    }
    // The lofts: the posts and the ladder first, then the railing with its gap,
    // and the floor over them.
    for (const loft of layout.lofts) {
        const foot = ladderCell(loft);
        blocks.set(
            `${LADDER}[facing=${ladderFacing(loft)}]`,
            foot.x,
            1,
            foot.z,
            foot.x,
            LOFT,
            foot.z
        );
        for (const along of [...postsOf(loft), loft.ladder]) {
            const at = edgeCell(loft, along);
            blocks.set(POST, at.x, 1, at.z, at.x, LOFT - 1, at.z);
        }
        const gap = edgeCell(loft, loft.ladder);
        blocks.clear(gap.x, LOFT + 1, gap.z, gap.x, LOFT + 1, gap.z);
        if (loft.across === "x")
            blocks.set(RAIL, loft.edge, LOFT + 1, loft.z1, loft.edge, LOFT + 1, loft.z2);
        else blocks.set(RAIL, loft.x1, LOFT + 1, loft.edge, loft.x2, LOFT + 1, loft.edge);
        const lamp = loftLamp(loft);
        blocks.set(LIGHT, lamp.x, LOFT, lamp.z, lamp.x, LOFT, lamp.z);
        blocks.set(BOARDS, loft.x1, LOFT, loft.z1, loft.x2, LOFT, loft.z2);
    }
    // The cage: barrier walls three high round its room, and a lid.
    blocks.clear(CAGE.x1 + 1, 1, CAGE.z1 + 1, CAGE.x2 - 1, 3, CAGE.z2 - 1);
    blocks.set(BARRIER, CAGE.x1, 1, CAGE.z1, CAGE.x2, 4, CAGE.z2);
    for (const piece of layout.pieces) {
        const x2 = piece.x + piece.w - 1;
        const z2 = piece.z + piece.d - 1;
        const top = piece.level + piece.h - 1;
        if (piece.kind === "closet") blocks.set(CUPBOARD, piece.x, 1, piece.z, x2, top, z2);
        else if (piece.kind === "bush") blocks.set(LEAVES, piece.x, 1, piece.z, x2, top, z2);
        else if (piece.kind !== "pit")
            blocks.set(PIECE_BLOCKS[piece.kind], piece.x, piece.level, piece.z, x2, top, z2);
    }
    // The pits' own air, down through the floor, kept from the floor below.
    for (const piece of layout.pieces)
        if (piece.kind === "pit") blocks.clear(piece.x, -1, piece.z, piece.x, 0, piece.z);
    for (const lamp of LAMPS) blocks.set(LIGHT, lamp.x, 0, lamp.z, lamp.x, 0, lamp.z);
    blocks.set(FOUNDATION, 1, DEEPEST, 1, LAST, -1, LAST);
    blocks.set(FLOOR, 1, 0, 1, LAST, 0, LAST);
    return blocks;
}

// ------------------------------------------------------------------ the rules

/** Where the hiders start: round the cage, a block out from its wall, spread
 *  evenly - as many as the house takes. */
function hiderCells(middle = MIDDLE): { x: number; z: number }[] {
    const ring: { x: number; z: number }[] = [];
    const r = MIDDLE - CAGE.x1 + 1;
    for (let x = MIDDLE - r; x <= MIDDLE + r; x += 1)
        for (let z = MIDDLE - r; z <= MIDDLE + r; z += 1)
            if (Math.max(Math.abs(x - MIDDLE), Math.abs(z - MIDDLE)) === r)
                ring.push({ x: x - MIDDLE + middle, z: z - MIDDLE + middle });
    ring.sort(
        (a, b) => Math.atan2(a.z - middle, a.x - middle) - Math.atan2(b.z - middle, b.x - middle)
    );
    const step = ring.length / MOST;
    return Array.from({ length: MOST }, (_, index) => ring[Math.floor(index * step)]!);
}

/** The seekers' cells inside the cage. */
function seekerCells(middle = MIDDLE): { x: number; z: number }[] {
    return [
        { x: middle, z: middle },
        { x: middle - 1, z: middle },
        { x: middle + 1, z: middle }
    ];
}

/** The light each block of the house gets from its lamps, as the game spreads
 *  it: 15 at a lamp, a level less every block it goes through. */
function lightOf(blocks: Blocks, layout: Layout): (x: number, level: number, z: number) => number {
    const light = new Uint8Array(SIZE * SIZE * Blocks.LEVELS);
    const index = (x: number, level: number, z: number) =>
        ((level - DEEPEST) * SIZE + x) * SIZE + z;
    const queue: [number, number, number][] = [];
    for (const lamp of lampsOf(layout)) {
        light[index(lamp.x, lamp.level, lamp.z)] = 15;
        queue.push([lamp.x, lamp.level, lamp.z]);
    }
    for (let head = 0; head < queue.length; head += 1) {
        const [x, level, z] = queue[head]!;
        const next = light[index(x, level, z)]! - 1;
        if (next <= 0) continue;
        for (const [dx, dl, dz] of [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1]
        ] as const) {
            const nx = x + dx;
            const nl = level + dl;
            const nz = z + dz;
            if (!Blocks.inside(nx, nl, nz) || !blocks.litThrough(nx, nl, nz)) continue;
            if (light[index(nx, nl, nz)]! >= next) continue;
            light[index(nx, nl, nz)] = next;
            queue.push([nx, nl, nz]);
        }
    }
    return (x, level, z) => (Blocks.inside(x, level, z) ? light[index(x, level, z)]! : 0);
}

/**
 * Every rule a house breaks, one line each; empty when it keeps them all. What
 * the tests run over thousands of seeds, and what a house is checked against
 * before it is used.
 */
export function layoutProblems(layout: Layout): string[] {
    const problems: string[] = [];
    const fixed = fixtures(layout);
    layout.pieces.forEach((piece, index) => {
        problems.push(...pieceProblems(piece, layout.lofts, index));
        if (piece.kind === "pit" && LAMPS.some((lamp) => lamp.x === piece.x && lamp.z === piece.z))
            problems.push(`pit ${index} is in a lamp`);
        for (const one of fixed)
            if (gapOf(one, piece) < 1) {
                problems.push(
                    `piece ${index} is in the way of a doorway, a ladder, a lamp or the cage`
                );
                break;
            }
        for (let other = index + 1; other < layout.pieces.length; other += 1)
            if (gapOf(piece, layout.pieces[other]!) < 1)
                problems.push(`pieces ${index} and ${other} touch`);
    });
    const blocks = blocksOf(layout);
    const at = (x: number, level: number, z: number) => blocks.cell(x, level, z);
    // Room for a body: air, a ladder, or a door, which opens.
    const open = (x: number, level: number, z: number) => {
        const cell = at(x, level, z);
        return cell === "air" || cell === "ladder" || cell === "door";
    };
    // Where a player can stand: on something whole, with two blocks of room -
    // or on a shut hatch, a sliver over the floor, with one.
    const stands = (x: number, feet: number, z: number) =>
        at(x, feet, z) === "hatch"
            ? open(x, feet + 1, z)
            : at(x, feet - 1, z) === "solid" && open(x, feet, z) && open(x, feet + 1, z);
    const seen = new Uint8Array(SIZE * SIZE * Blocks.LEVELS);
    const mark = (x: number, feet: number, z: number) => ((feet - DEEPEST) * SIZE + x) * SIZE + z;
    const start = hiderCells()[0]!;
    const queue: [number, number, number][] = [[start.x, 1, start.z]];
    seen[mark(start.x, 1, start.z)] = 1;
    const visit = (x: number, feet: number, z: number) => {
        if (!Blocks.inside(x, feet, z) || seen[mark(x, feet, z)]) return;
        seen[mark(x, feet, z)] = 1;
        queue.push([x, feet, z]);
    };
    const links = new Map<number, [number, number, number]>();
    for (const loft of layout.lofts) {
        const foot = ladderCell(loft);
        const top = edgeCell(loft, loft.ladder);
        links.set(mark(foot.x, 1, foot.z), [top.x, LOFT + 1, top.z]);
        links.set(mark(top.x, LOFT + 1, top.z), [foot.x, 1, foot.z]);
    }
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
        const link = links.get(mark(x, feet, z));
        if (link) visit(...link);
    }
    // The cage, its lid and the seekers' room in it, is walked from the start
    // of the game only by the seekers, and gone once they are let go.
    const onCage = (x: number, feet: number, z: number) =>
        (feet === 1 || feet === LOFT + 1) &&
        x >= CAGE.x1 &&
        x <= CAGE.x2 &&
        z >= CAGE.z1 &&
        z <= CAGE.z2;
    const missed: string[] = [];
    for (let x = 1; x <= LAST; x += 1)
        for (let z = 1; z <= LAST; z += 1)
            for (const feet of [1, LOFT + 1])
                if (stands(x, feet, z) && !seen[mark(x, feet, z)] && !onCage(x, feet, z))
                    missed.push(`${x},${feet},${z}`);
    if (missed.length > 0)
        problems.push(`${missed.length} places to stand cannot be reached, first ${missed[0]}`);
    for (const cell of hiderCells())
        if (!stands(cell.x, 1, cell.z))
            problems.push(`a hider's start at ${cell.x},${cell.z} is taken`);
    // No monster spawns where block light is 0: none anywhere a player stands,
    // a pit's floor included.
    const light = lightOf(blocks, layout);
    const dark: string[] = [];
    for (let x = 1; x <= LAST; x += 1)
        for (let z = 1; z <= LAST; z += 1)
            for (let feet = -1; feet < ROOF - 1; feet += 1)
                if (
                    (stands(x, feet, z) || (feet === -1 && at(x, -1, z) === "ladder")) &&
                    !onCage(x, feet, z) &&
                    light(x, feet, z) === 0
                )
                    dark.push(`${x},${feet},${z}`);
    if (dark.length > 0)
        problems.push(
            `${dark.length} places to stand are dark enough for monsters, first ${dark[0]}`
        );
    return problems;
}

/** How many hiding places a house has, by kind: what the measurement counts. */
export function hidingPlaces(layout: Layout): Record<PieceKind, number> {
    const counts: Record<PieceKind, number> = {
        wall: 0,
        hedge: 0,
        crate: 0,
        stack: 0,
        closet: 0,
        bush: 0,
        pit: 0
    };
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
        y2: floorY + BASE + ROOF,
        z2: center.z - half + SIZE - 1
    };
}

/** A facing turned with the house. */
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

/** Which way a hall is mirrored. */
export type Mirror = Pick<Layout, "flipX" | "flipZ">;

/** Where a hall's cage stands, by the design that built it: the first was 27
 *  across, its cage round 15 and its floor a block over the barrier. Only that
 *  much of it is kept, so a run built before an update still starts in its own
 *  cage. */
interface Starts {
    readonly size: number;
    readonly middle: number;
    readonly base: number;
}
const STARTS: Starts = { size: SIZE, middle: MIDDLE, base: BASE };
const FIRST_STARTS: Starts = { size: 27, middle: 15, base: 1 };

function startsOf(design: number): Starts {
    return design < DESIGN ? FIRST_STARTS : STARTS;
}

function startAt(box: Box, mirror: Mirror, starts: Starts, x: number, level: number, z: number) {
    return {
        x: box.x1 + (mirror.flipX ? starts.size - 1 - x : x),
        y: box.y1 + starts.base + level,
        z: box.z1 + (mirror.flipZ ? starts.size - 1 - z : z)
    };
}

/** A place in the house's own terms, in the world. */
function worldOf(box: Box, layout: Layout, x: number, level: number, z: number) {
    return startAt(box, layout, STARTS, x, level, z);
}

function placed(
    box: Box,
    layout: Layout,
    part: { x1: number; l1: number; z1: number; x2: number; l2: number; z2: number; block: string }
): Fill {
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
 * What it is built of, each only into air: the barrier under it all, the
 * outer walls and the roof, then everything inside - the ladders and doors
 * before what holds them, which is how a server keeps them - and the floor
 * last, its corner's piece the proof that the blocks stayed.
 */
export function hallFills(box: Box, layout: Layout): Fill[] {
    const fills: Fill[] = [
        { box: { ...box, y2: box.y1 }, block: BARRIER },
        { box: { ...box, x2: box.x1, y1: box.y1 + 1, y2: box.y2 - 1 }, block: OUTER },
        { box: { ...box, x1: box.x2, y1: box.y1 + 1, y2: box.y2 - 1 }, block: OUTER },
        { box: { ...box, z2: box.z1, y1: box.y1 + 1, y2: box.y2 - 1 }, block: OUTER },
        { box: { ...box, z1: box.z2, y1: box.y1 + 1, y2: box.y2 - 1 }, block: OUTER },
        { box: { ...box, y1: box.y2 }, block: ROOF_BLOCK }
    ];
    const order = (block: string) => {
        const id = bare(block);
        return id === FLOOR ? 2 : id === LADDER || id === DOOR || id === HATCH ? 0 : 1;
    };
    const parts = blocksOf(layout)
        .boxes()
        .sort((a, b) => order(a.block) - order(b.block));
    // The floor's corner piece last of all.
    const corner = parts.findIndex(
        (part) => bare(part.block) === FLOOR && part.x1 === 1 && part.z1 === 1
    );
    if (corner >= 0) parts.push(...parts.splice(corner, 1));
    for (const part of parts) fills.push(placed(box, layout, part));
    return fills;
}

/**
 * How a hall an older design built is mirrored, which its run never wrote
 * down: the barrier over the middle of its cage is under exactly one of the
 * four. Each is a test to send, `Test passed` for the mirror it stands for.
 */
export function mirrorTests(box: Box, design: number): { mirror: Mirror; line: string }[] {
    const starts = startsOf(design);
    return [false, true].flatMap((flipX) =>
        [false, true].map((flipZ) => {
            const mirror = { flipX, flipZ };
            const lid = startAt(box, mirror, starts, starts.middle, 4, starts.middle);
            return {
                mirror,
                line: `execute in minecraft:overworld if block ${lid.x} ${lid.y} ${lid.z} ${BARRIER}`
            };
        })
    );
}

/** Where the `index`th hider starts, and where the `index`th seeker waits, in
 *  a hall built by `design`. */
export function hiderSpot(box: Box, mirror: Mirror, index: number, design = DESIGN): Spot {
    const starts = startsOf(design);
    const cell = hiderCells(starts.middle)[index % MOST]!;
    const at = startAt(box, mirror, starts, cell.x, 1, cell.z);
    const middle = startAt(box, mirror, starts, starts.middle, 1, starts.middle);
    return {
        ...at,
        yaw: Math.round((-Math.atan2(at.x - middle.x, at.z - middle.z) * 180) / Math.PI)
    };
}

export function seekerSpot(box: Box, mirror: Mirror, index: number, design = DESIGN): Spot {
    const starts = startsOf(design);
    const cells = seekerCells(starts.middle);
    const cell = cells[index % cells.length]!;
    return { ...startAt(box, mirror, starts, cell.x, 1, cell.z), yaw: 0 };
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

/** The cage taken down: its barrier, only inside its own box. A run whose
 *  hall was built by an older design (`built`) has its cage somewhere else:
 *  every barrier over its floor comes down instead, so its seekers are never
 *  left shut in by an update. */
export function cageDown(box: Box, layout: Layout, design = DESIGN): string {
    const cage = design < DESIGN ? { ...box, y1: box.y1 + 1 } : cageBox(box, layout);
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
