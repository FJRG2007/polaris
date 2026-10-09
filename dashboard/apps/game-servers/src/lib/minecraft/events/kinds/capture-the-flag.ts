/**
 * Capture the flag's arena and commands: two teams set up as a duel's
 * (`team-duel.ts`, its kit, its death and send-back and shield, its kill
 * credit), a long closed arena in the air with a base at each end - its floor
 * in the team's color, a banner standing on a light at its back - and cover
 * between them drawn from the run's id.
 *
 * The cover is laid out on the red half and turned half a circle onto the
 * blue one, so each team sees exactly the field the other does. It is checked
 * before it is used (`layoutProblems`): nothing on a base or within a block of
 * the wall, no two pieces touching, every floor block reachable from both
 * bases (no sealed corner), and the two halves the same.
 *
 * The flag is the banner. A player touching the other team's takes it off its
 * stand and wears it on their head (marked as the kit, so it is taken back),
 * glowing and slowed a little. Brought home while their own flag stands at
 * home, it is a capture; brought low on the way, they drop it and it goes back
 * on its stand. Where each flag is, is written into the run (`FlagState`), and
 * every tick puts the stands as that says, so a restart leaves them right.
 *
 * Pure; the loop is `capture-the-flag-service.ts`.
 */

import { z } from "zod";
import type { Box } from "../state";
import type { Spot } from "./arena";
import { seeded } from "../trivia-bank";
import type { Fill } from "./arena-game";

/** The layout's version, written into the run when it is built. */
export const DESIGN = 1;

/** Half the inside's width (x) and length (z); the walls are one further. */
export const HALF_X = 10;
export const HALF_Z = 23;
/** From the barrier floor to the barrier roof. */
const HEIGHT = 8;

/** How many can play: eight a side. */
export const MOST = 16;

/** How far from its center the ground under it is judged. */
export const REACH = HALF_Z + 1;

/** Each team's base: the rows from the end wall in, and its flag's stand. */
const BASE_DEPTH = 6;
/** The stand, this far from the end wall; the start row in front of it. */
const STAND_ROW = 2;
const START_ROW = 4;
/** Within this of a stand, a flag is touched; within `HOME` of their own, a
 *  carrier is home. */
export const TOUCH = 1.8;
export const HOME = 3;

/** The cover's field: between the bases, a row of air short of each. */
const FIELD = HALF_Z - BASE_DEPTH - 1;

const BARRIER = "minecraft:barrier";
const RIM = "minecraft:polished_andesite";
const LIGHT = "minecraft:sea_lantern";
const FIELD_FLOOR = "minecraft:smooth_stone";
const MID_LINE = "minecraft:white_concrete";
export const BASE_FLOORS = ["minecraft:red_concrete", "minecraft:blue_concrete"] as const;
/** The flags, as blocks on their stands and as what their carriers wear. */
export const BANNERS = ["minecraft:red_banner", "minecraft:blue_banner"] as const;
/** What each kind of cover is built of: neutral stone and wood, the same on both halves. */
const COVER = {
    wall: "minecraft:stone_bricks",
    crate: "minecraft:spruce_planks",
    pillar: "minecraft:chiseled_stone_bricks"
} as const;

/** Every kind of block the arena is built of: the banners first, which come
 *  down before the floor they stand on (`arena.teardown`). */
export const ARENA_BLOCKS: readonly string[] = [
    ...BANNERS,
    BARRIER,
    RIM,
    LIGHT,
    FIELD_FLOOR,
    MID_LINE,
    ...BASE_FLOORS,
    ...Object.values(COVER)
];

/** The side tags each team's players carry, for the quick look's selectors. */
export const SIDE_TAGS = ["pe_ctf_s0", "pe_ctf_s1"] as const;
/** Who touched a side's flag since the last tick, and who stood home. */
export const TOUCH_TAGS = ["pe_ctf_t0", "pe_ctf_t1"] as const;
export const HOME_TAGS = ["pe_ctf_h0", "pe_ctf_h1"] as const;

// ------------------------------------------------------------------ the run's own

const flagSchema = z.object({ carrier: z.string().nullable().default(null) });

export const stateSchema = z.object({
    design: z.number().int().default(DESIGN),
    /** Each team's flag: home on its stand, or carried by somebody. */
    flags: z.tuple([flagSchema, flagSchema]).default([{ carrier: null }, { carrier: null }]),
    /** Players each one brought low: what breaks a tie on captures. */
    kills: z.record(z.number().int()).default({})
});
export type FlagState = z.infer<typeof stateSchema>;

/** The run's flags as written, or as they stand at the start. */
export function stateOf(game: unknown): FlagState {
    const parsed = stateSchema.safeParse(game ?? {});
    return parsed.success ? parsed.data : stateSchema.parse({});
}

// ------------------------------------------------------------------ the cover

export type PieceKind = keyof typeof COVER;

/** One piece of cover, in blocks from the arena's middle: `x`, `z` its corner
 *  with the least of each, `w` by `d` blocks across, `h` high. */
export interface Piece {
    readonly kind: PieceKind;
    readonly x: number;
    readonly z: number;
    readonly w: number;
    readonly d: number;
    readonly h: number;
}

const SHAPES: readonly Omit<Piece, "x" | "z">[] = [
    { kind: "wall", w: 3, d: 1, h: 2 },
    { kind: "wall", w: 1, d: 3, h: 2 },
    { kind: "wall", w: 4, d: 1, h: 2 },
    { kind: "crate", w: 1, d: 1, h: 1 },
    { kind: "crate", w: 2, d: 2, h: 2 },
    { kind: "crate", w: 2, d: 1, h: 1 },
    { kind: "pillar", w: 1, d: 1, h: 3 }
];

/** The same piece turned half a circle round the middle, onto the other half. */
export function mirrored(piece: Piece): Piece {
    return { ...piece, x: -(piece.x + piece.w - 1), z: -(piece.z + piece.d - 1) };
}

function apart(a1: number, a2: number, b1: number, b2: number): number {
    return Math.max(a1 - b2, b1 - a2) - 1;
}

/** The air between two pieces across the floor, a diagonal counted as touching. */
function gapOf(a: Piece, b: Piece): number {
    return Math.max(
        apart(a.x, a.x + a.w - 1, b.x, b.x + b.w - 1),
        apart(a.z, a.z + a.d - 1, b.z, b.z + b.d - 1)
    );
}

/** How many pieces a half has, at the least and the most. */
const PIECES = { least: 5, most: 8 } as const;

/**
 * The cover for a run, both halves: pieces drawn from the run's id onto the
 * red half (`z < 0`), each kept only where it breaks no rule, then every one
 * turned onto the blue half. Drawn again with the next seed when a half came
 * out short; a field left bare after all of that is still a fair one.
 */
export function coverFor(seed: string): Piece[] {
    for (let draw = 0; draw < 20; draw += 1) {
        const random = seeded(`${seed}-ctf-${draw}`);
        const half: Piece[] = [];
        const wanted = PIECES.least + Math.floor(random() * (PIECES.most - PIECES.least + 1));
        for (let attempt = 0; attempt < 200 && half.length < wanted; attempt += 1) {
            const shape = SHAPES[Math.floor(random() * SHAPES.length)]!;
            const x = -(HALF_X - 2) + Math.floor(random() * (2 * (HALF_X - 2) - shape.w + 2));
            const z = -FIELD + Math.floor(random() * (FIELD - shape.d));
            const piece: Piece = { ...shape, x, z };
            // Only the rules one piece can break, here; the whole field is
            // checked once it is drawn.
            const kept = [...half, ...half.map(mirrored)];
            if (pieceProblems(piece).length === 0 && kept.every((one) => gapOf(one, piece) >= 1))
                half.push(piece);
        }
        const cover = half.flatMap((one) => [one, mirrored(one)]);
        if (half.length >= PIECES.least && layoutProblems(cover).length === 0) return cover;
    }
    return [];
}

/** Every floor block of the inside, as `x,z`, and whether cover stands on it. */
function floorCells(cover: readonly Piece[]): Map<string, boolean> {
    const cells = new Map<string, boolean>();
    for (let x = -HALF_X; x <= HALF_X; x += 1)
        for (let z = -HALF_Z; z <= HALF_Z; z += 1) cells.set(`${x},${z}`, false);
    for (const piece of cover)
        for (let x = piece.x; x < piece.x + piece.w; x += 1)
            for (let z = piece.z; z < piece.z + piece.d; z += 1) cells.set(`${x},${z}`, true);
    return cells;
}

/** Each team's stand, from the middle: on the line down the middle, at its own end. */
export function standCell(side: number): { x: number; z: number } {
    const z = HALF_Z - STAND_ROW;
    return { x: 0, z: side === 0 ? -z : z };
}

/**
 * Every rule a field breaks, one line each; empty when it keeps them all. What
 * the tests run over thousands of seeds, and what a field is checked against
 * before it is kept.
 */
function pieceProblems(piece: Piece, index = 0): string[] {
    const problems: string[] = [];
    if (piece.x < -(HALF_X - 2) || piece.x + piece.w - 1 > HALF_X - 2)
        problems.push(`piece ${index} is within a block of a side wall`);
    if (piece.z < -FIELD || piece.z + piece.d - 1 > FIELD)
        problems.push(`piece ${index} is on or next to a base`);
    if (piece.h < 1 || piece.h > HEIGHT - 4)
        problems.push(`piece ${index} has no head room over it`);
    return problems;
}

export function layoutProblems(cover: readonly Piece[]): string[] {
    const problems: string[] = [];
    cover.forEach((piece, index) => {
        problems.push(...pieceProblems(piece, index));
        for (let other = index + 1; other < cover.length; other += 1)
            if (gapOf(piece, cover[other]!) < 1)
                problems.push(`pieces ${index} and ${other} touch`);
    });
    // The two halves are the same field, turned.
    const keys = new Set(cover.map((one) => JSON.stringify(one)));
    for (const piece of cover)
        if (!keys.has(JSON.stringify(mirrored(piece))))
            problems.push(`a piece at ${piece.x},${piece.z} has no twin on the other half`);
    // Every floor block reachable from both stands, walking.
    const cells = floorCells(cover);
    const reached = new Set<string>();
    const start = standCell(0);
    const queue = [`${start.x},${start.z}`];
    reached.add(queue[0]!);
    while (queue.length > 0) {
        const [x, z] = queue.pop()!.split(",").map(Number) as [number, number];
        for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1]
        ] as const) {
            const key = `${x + dx},${z + dz}`;
            if (cells.get(key) === false && !reached.has(key)) {
                reached.add(key);
                queue.push(key);
            }
        }
    }
    const sealed = [...cells].filter(([key, covered]) => !covered && !reached.has(key)).length;
    if (sealed > 0) problems.push(`${sealed} floor blocks cannot be walked to`);
    const other = standCell(1);
    if (!reached.has(`${other.x},${other.z}`)) problems.push("one base cannot reach the other");
    return problems;
}

// ------------------------------------------------------------------ the arena

/** The arena over the place found: its floor `lift` blocks over the highest
 *  thing under it. */
export function arenaBox(center: { x: number; z: number }, floorY: number): Box {
    return {
        x1: center.x - HALF_X - 1,
        y1: floorY,
        z1: center.z - HALF_Z - 1,
        x2: center.x + HALF_X + 1,
        y2: floorY + HEIGHT,
        z2: center.z + HALF_Z + 1
    };
}

function centerOf(box: Box): { x: number; z: number } {
    return { x: (box.x1 + box.x2) / 2, z: (box.z1 + box.z2) / 2 };
}

/** A stand, in the world: where its banner stands, over the light in the floor. */
export function standAt(box: Box, side: number): { x: number; y: number; z: number } {
    const center = centerOf(box);
    const cell = standCell(side);
    return { x: center.x + cell.x, y: box.y1 + 2, z: center.z + cell.z };
}

/** A banner standing, turned to face down the field, toward the other base. */
export function bannerBlock(side: number): string {
    return `${BANNERS[side]}[rotation=${side === 0 ? 0 : 8}]`;
}

/**
 * What it is built of, each only into air, in this order: the corner posts,
 * the rim and the stands' lights (which the barrier and the floors then fill
 * round), the barrier shell, each base's floor and the field's, the middle
 * line, the cover, and the banners last - a blue banner where it should be is
 * the proof that the blocks stayed.
 */
export function arenaFills(box: Box, cover: readonly Piece[]): Fill[] {
    const center = centerOf(box);
    const floorY = box.y1 + 1;
    const layer = (x1: number, z1: number, x2: number, z2: number, y = floorY): Box => ({
        x1,
        y1: y,
        z1,
        x2,
        y2: y,
        z2
    });
    const fills: Fill[] = [];
    for (const [x, z] of [
        [box.x1, box.z1],
        [box.x2, box.z1],
        [box.x1, box.z2],
        [box.x2, box.z2]
    ] as const)
        fills.push({
            box: { x1: x, z1: z, x2: x, z2: z, y1: floorY, y2: floorY + 2 },
            block: LIGHT
        });
    fills.push(
        { box: layer(box.x1 + 1, box.z1, box.x2 - 1, box.z1), block: RIM },
        { box: layer(box.x1 + 1, box.z2, box.x2 - 1, box.z2), block: RIM },
        { box: layer(box.x1, box.z1 + 1, box.x1, box.z2 - 1), block: RIM },
        { box: layer(box.x2, box.z1 + 1, box.x2, box.z2 - 1), block: RIM }
    );
    for (const side of [0, 1]) {
        const stand = standAt(box, side);
        fills.push({ box: layer(stand.x, stand.z, stand.x, stand.z), block: LIGHT });
    }
    fills.push(
        { box: { ...box, y2: box.y1 }, block: BARRIER },
        { box: { ...box, y1: box.y2 }, block: BARRIER },
        { box: { ...box, x2: box.x1 }, block: BARRIER },
        { box: { ...box, x1: box.x2 }, block: BARRIER },
        { box: { ...box, z2: box.z1 }, block: BARRIER },
        { box: { ...box, z1: box.z2 }, block: BARRIER }
    );
    const inX1 = center.x - HALF_X;
    const inX2 = center.x + HALF_X;
    const baseEdge = HALF_Z - BASE_DEPTH + 1;
    fills.push(
        { box: layer(inX1, center.z - HALF_Z, inX2, center.z - baseEdge), block: BASE_FLOORS[0] },
        { box: layer(inX1, center.z + baseEdge, inX2, center.z + HALF_Z), block: BASE_FLOORS[1] },
        { box: layer(inX1, center.z, inX2, center.z), block: MID_LINE },
        {
            box: layer(inX1, center.z - baseEdge + 1, inX2, center.z + baseEdge - 1),
            block: FIELD_FLOOR
        }
    );
    for (const piece of cover)
        fills.push({
            box: {
                x1: center.x + piece.x,
                y1: floorY + 1,
                z1: center.z + piece.z,
                x2: center.x + piece.x + piece.w - 1,
                y2: floorY + piece.h,
                z2: center.z + piece.z + piece.d - 1
            },
            block: COVER[piece.kind]
        });
    for (const side of [0, 1]) {
        const stand = standAt(box, side);
        fills.push({
            box: layer(stand.x, stand.z, stand.x, stand.z, stand.y),
            block: bannerBlock(side)
        });
    }
    return fills;
}

/**
 * Where the `index`th player of a side starts: along the row in front of their
 * flag, facing the other end - the duel's own spread, a block further out each.
 */
export function startSpot(box: Box, side: number, index: number): Spot {
    const center = centerOf(box);
    const step = Math.ceil(index / 2) * 2 * (index % 2 === 0 ? 1 : -1);
    const x = Math.max(center.x - HALF_X + 1, Math.min(center.x + HALF_X - 1, center.x + step));
    const z = HALF_Z - START_ROW;
    return side === 0
        ? { x, y: box.y1 + 2, z: center.z - z, yaw: 0 }
        : { x, y: box.y1 + 2, z: center.z + z, yaw: 180 };
}

/** Whether somebody is within `reach` of a stand, across the floor. */
export function near(
    at: { x: number; z: number },
    stand: { x: number; z: number },
    reach: number
): boolean {
    return Math.hypot(at.x - (stand.x + 0.5), at.z - (stand.z + 0.5)) <= reach;
}

// ------------------------------------------------------------------ the flags

/** The stand as the flag's state says: its banner back where it is home - only
 *  into air - and taken off it, only if it is ours, where it is carried. */
export function standLines(box: Box, side: number, home: boolean): string[] {
    const at = standAt(box, side);
    const where = `${at.x} ${at.y} ${at.z}`;
    return home
        ? [`execute in minecraft:overworld run setblock ${where} ${bannerBlock(side)} keep`]
        : [
              `execute in minecraft:overworld if block ${where} ${BANNERS[side]} run setblock ${where} minecraft:air`
          ];
}

/**
 * What the quick look marks between ticks, so a flag touched or a base reached
 * in passing is not missed: whoever of a team came within `TOUCH` of the other
 * team's flag while it stands at home, and whoever came within `HOME` of their
 * own stand.
 */
export function touchLines(box: Box): string[] {
    const lines: string[] = [];
    for (const side of [0, 1]) {
        const stand = standAt(box, side);
        const middle = `${stand.x + 0.5} ${stand.y} ${stand.z + 0.5}`;
        lines.push(
            `execute in minecraft:overworld positioned ${middle} if block ${stand.x} ${stand.y} ${stand.z} ${BANNERS[side]} run tag @a[tag=${SIDE_TAGS[1 - side]},distance=..${TOUCH}] add ${TOUCH_TAGS[side]}`,
            `execute in minecraft:overworld positioned ${middle} run tag @a[tag=${SIDE_TAGS[side]},distance=..${HOME}] add ${HOME_TAGS[side]}`
        );
    }
    return lines;
}

/** A mark as the tick took it: what it reads, while the quick look marks anew. */
export function takenTag(tag: string): string {
    return `${tag}_r`;
}

/**
 * The quick look's marks taken, in one batch - so no quick look comes in
 * between: each copied to what the tick reads (`takenTag`), and cleared.
 * Read and cleared in separate trips, a mark made in between was lost.
 */
export const TAKE_MARKS: readonly string[] = [...TOUCH_TAGS, ...HOME_TAGS].flatMap((tag) => [
    `tag @a remove ${takenTag(tag)}`,
    `tag @a[tag=${tag}] add ${takenTag(tag)}`,
    `tag @a remove ${tag}`
]);

/**
 * Whatever the quick look marked on somebody just sent back: made where they
 * were before the tick moved them - by the other team's flag, say - and read
 * on the next tick, they took a flag from their own base, and with it there,
 * captured it. Sent straight after the move.
 */
export function unmarkLines(name: string): string[] {
    return [...TOUCH_TAGS, ...HOME_TAGS].map((tag) => `tag ${name} remove ${tag}`);
}

/** Every tag the game gave, taken off at the end - and off anybody coming in,
 *  who may carry one from a game a crash never ended. */
export const TAGS = [
    ...SIDE_TAGS,
    ...TOUCH_TAGS,
    ...HOME_TAGS,
    ...[...TOUCH_TAGS, ...HOME_TAGS].map(takenTag)
] as const;
export const TAGS_OFF = TAGS.map((tag) => `tag @a remove ${tag}`);

/** The carrier, seen by all: glowing, and a little slower than the rest. */
export function carrierLines(name: string): string[] {
    return [
        `effect give ${name} minecraft:glowing 3 0 true`,
        `effect give ${name} minecraft:slowness 3 0 true`
    ];
}

/** No longer carrying: the glow and the slowness taken off. */
export function droppedLines(name: string): string[] {
    return [`effect clear ${name} minecraft:glowing`, `effect clear ${name} minecraft:slowness`];
}

/** Who wins a tie on captures: the one who brought more players low. */
export function tiebreakOf(state: FlagState, names: readonly string[]): Record<string, number> {
    return Object.fromEntries(names.map((name) => [name, -(state.kills[name] ?? 0)]));
}
