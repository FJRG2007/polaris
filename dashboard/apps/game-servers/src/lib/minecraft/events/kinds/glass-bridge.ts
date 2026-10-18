/**
 * The glass bridge: its map, its rules and its commands.
 *
 * A long bridge runs east through the sky from a start platform to a finish
 * platform, made of rows of two glass panels side by side - one in each lane,
 * a block of air between the lanes and between the rows. In every row one
 * panel holds and the other breaks under whoever stands on it; both are the
 * same glass, and which is which is drawn from the run's id and the row
 * (`safeLane`), so a restart draws the same bridge. Whoever falls - through a
 * panel or off a side - drops into a pool far below, is out, and watches the
 * rest from a roofed gallery along the north side. The first across wins;
 * everybody else is ranked by how far they got.
 *
 * Played two ways (`options.mode`): everybody on the bridge at once, or one at
 * a time in a drawn order, each with `turnSeconds` to step onto the next row
 * before they are out for standing still.
 *
 * A panel breaks the tick a walker stands on it: the events data pack runs a
 * check every game tick (`FUNCTIONS`) from an invisible marker stand on each
 * panel that breaks, which shatters it and goes. A look over RCON comes round
 * twice a second, too slow for a player hopping across, so it only backs the
 * pack up: where a walker is seen standing on a panel that should have gone,
 * it goes then (`breakingUnder`).
 *
 * Pure; the loop is `glass-bridge-service.ts`.
 */

import { z } from "zod";
import type { Box } from "../state";
import { within, type Spot } from "./arena";
import type { Fill } from "./arena-game";
import { seeded, shuffled } from "../trivia-bank";
import * as decor from "./arena-decor";

/** How many can play. */
export const MOST = 24;

/** A panel is this many blocks on a side. */
export const PANEL = 3;
/** The air between two rows, and between the two lanes. */
const GAP = 1;
/** From one row to the next. */
const PITCH = PANEL + GAP;
/** How far the pool is under the bridge. */
export const DROP = 12;
/** The start and finish platforms, along the bridge and across it. */
const PLATFORM_DEPTH = 6;
const PLATFORM_HALF = 4;
/** The gallery: its depth, and how far north of the bridge's middle it starts. */
const GALLERY_DEPTH = 3;
const GALLERY_FROM = 6;
/** The arches over each end, and the posts at the platforms' corners. */
const ARCH = 5;
const POST = 3;

/** The blocks it is built of. Both panels of a row are the same glass. */
export const GLASS = "minecraft:glass";
const START_FLOOR = "minecraft:light_gray_concrete";
const START_RIM = "minecraft:cyan_terracotta";
const FINISH_DARK = "minecraft:black_concrete";
const FINISH_LIGHT = "minecraft:white_concrete";
const PILLAR = "minecraft:quartz_pillar";
const BEAM = "minecraft:smooth_quartz";
const FINISH_BEAM = "minecraft:yellow_concrete";
const LANTERN = "minecraft:lantern";
const HANGING = "minecraft:lantern[hanging=true]";
const GALLERY_FLOOR = "minecraft:spruce_planks";
const GALLERY_WALL = "minecraft:white_stained_glass";
const BARRIER = "minecraft:barrier";
const POOL_FLOOR = "minecraft:prismarine";
const POOL_LIGHT = "minecraft:sea_lantern";
const POOL_WALL = "minecraft:dark_prismarine";
const WATER = "minecraft:water";

/** The parts that only frame the game (`arena-decor.SEASON_TRIM`): the
 *  arches and posts, their lanterns, the start's rim, the finish's squares,
 *  the gallery's walls and the pool's lights. Never the glass panels, which
 *  are the game. */
export const TRIM: decor.Trim = {
    [PILLAR]: "post",
    [BEAM]: "beam",
    [LANTERN]: "lantern",
    [HANGING]: "hangingLantern",
    [START_RIM]: "edge",
    [FINISH_DARK]: "checkDark",
    [FINISH_LIGHT]: "checkLight",
    [GALLERY_WALL]: "pane",
    [POOL_LIGHT]: "poolLight"
};

/** Every kind of block the bridge is built of, as bare ids: what hangs or
 *  stands on something first, so a teardown takes it before what holds it. */
export const BRIDGE_BLOCKS: readonly string[] = [
    LANTERN,
    WATER,
    GLASS,
    START_FLOOR,
    START_RIM,
    FINISH_DARK,
    FINISH_LIGHT,
    PILLAR,
    BEAM,
    FINISH_BEAM,
    GALLERY_FLOOR,
    GALLERY_WALL,
    BARRIER,
    POOL_FLOOR,
    POOL_LIGHT,
    POOL_WALL
];

// ------------------------------------------------------------------ the map

/** Where everything is, all of it read off the box and the number of rows. */
export interface Layout {
    readonly steps: number;
    /** The bridge's middle, across it. */
    readonly middleZ: number;
    /** The glass, and the platforms' floors, are at this height; players
     *  stand a block over it. */
    readonly y: number;
    /** The first row's west edge. */
    readonly firstX: number;
    readonly start: Box;
    readonly finish: Box;
    readonly gallery: Box;
    readonly pool: Box;
}

/** How long the whole thing is along x, for `steps` rows. */
function lengthOf(steps: number): number {
    // The pool's walls, a platform, a gap, the rows, a gap and a platform.
    return 2 + PLATFORM_DEPTH + GAP + steps * PITCH + PLATFORM_DEPTH;
}

/** How far from its center the ground under it is judged. */
export function reachOf(steps: number): number {
    return Math.ceil(lengthOf(steps) / 2) + 1;
}

/** The box it takes: the pool's floor at `floorY`, the bridge `DROP` over it,
 *  `center` in the middle of its length and of the bridge. */
export function bridgeBox(center: { x: number; z: number }, floorY: number, steps: number): Box {
    const length = lengthOf(steps);
    const x1 = center.x - Math.floor(length / 2);
    return {
        x1,
        y1: floorY,
        z1: center.z - GALLERY_FROM - GALLERY_DEPTH - 1,
        x2: x1 + length - 1,
        y2: floorY + DROP + ARCH + 1,
        z2: center.z + PLATFORM_HALF + 2
    };
}

/** Its layout, from its box and its rows. */
export function layoutOf(box: Box, steps: number): Layout {
    const middleZ = box.z1 + GALLERY_DEPTH + GALLERY_FROM + 1;
    const y = box.y1 + DROP;
    const startX1 = box.x1 + 1;
    const firstX = startX1 + PLATFORM_DEPTH + GAP;
    const finishX1 = firstX + steps * PITCH;
    return {
        steps,
        middleZ,
        y,
        firstX,
        start: {
            x1: startX1,
            y1: y,
            z1: middleZ - PLATFORM_HALF,
            x2: startX1 + PLATFORM_DEPTH - 1,
            y2: y,
            z2: middleZ + PLATFORM_HALF
        },
        finish: {
            x1: finishX1,
            y1: y,
            z1: middleZ - PLATFORM_HALF,
            x2: finishX1 + PLATFORM_DEPTH - 1,
            y2: y,
            z2: middleZ + PLATFORM_HALF
        },
        gallery: {
            x1: startX1,
            y1: y + 1,
            z1: middleZ - GALLERY_FROM - GALLERY_DEPTH + 1,
            x2: finishX1 + PLATFORM_DEPTH - 1,
            y2: y + 1,
            z2: middleZ - GALLERY_FROM
        },
        pool: {
            x1: box.x1,
            y1: box.y1,
            z1: middleZ - PLATFORM_HALF - 2,
            x2: box.x2,
            y2: box.y1 + 3,
            z2: box.z2
        }
    };
}

/** One panel: its row, its lane (0 north, 1 south) and where its glass is. */
export interface Panel {
    readonly row: number;
    readonly lane: 0 | 1;
    readonly box: Box;
}

export function panelOf(layout: Layout, row: number, lane: 0 | 1): Panel {
    const x1 = layout.firstX + row * PITCH;
    const z1 = lane === 0 ? layout.middleZ - GAP - PANEL + 1 : layout.middleZ + GAP;
    return {
        row,
        lane,
        box: { x1, y1: layout.y, z1, x2: x1 + PANEL - 1, y2: layout.y, z2: z1 + PANEL - 1 }
    };
}

/** The lane whose panel holds in a row, drawn from the run's id and the row. */
export function safeLane(seed: string, row: number): 0 | 1 {
    return seeded(`${seed}-glass-${row}`)() < 0.5 ? 0 : 1;
}

/** Every panel that breaks, one a row. */
export function breakingPanels(layout: Layout, seed: string): Panel[] {
    return Array.from({ length: layout.steps }, (_, row) =>
        panelOf(layout, row, safeLane(seed, row) === 0 ? 1 : 0)
    );
}

/** Half a player's width: how far their feet reach past where they are. */
const HALF_WIDTH = 0.3;
/** How high over a platform a jump in place goes. */
const JUMP = 3;

/** The ground (or glass) under somebody's feet: in that box's footprint, `edge`
 *  blocks past it on every side, and standing on it or up to `height` over it. */
function standingOn(
    box: Box,
    at: { x: number; y: number; z: number },
    edge = 0,
    height = 2
): boolean {
    return (
        at.x >= box.x1 - edge &&
        at.x < box.x2 + 1 + edge &&
        at.z >= box.z1 - edge &&
        at.z < box.z2 + 1 + edge &&
        at.y >= box.y1 + 0.9 &&
        at.y < box.y1 + height
    );
}

/** Whether somebody stands on the start platform, or on the finish one, or
 *  jumps in place over it. */
export function onStart(layout: Layout, at: { x: number; y: number; z: number }): boolean {
    return standingOn(layout.start, at, 0, JUMP);
}
export function onFinish(layout: Layout, at: { x: number; y: number; z: number }): boolean {
    return standingOn(layout.finish, at, 0, JUMP);
}

/** Fallen: under the glass, whether through it or off a side. */
export function fallen(layout: Layout, at: { y: number }): boolean {
    return at.y < layout.y - 0.5;
}

/** Whether somebody is in the gallery. */
export function inGallery(layout: Layout, at: { x: number; y: number; z: number }): boolean {
    const g = layout.gallery;
    return (
        at.x >= g.x1 &&
        at.x < g.x2 + 1 &&
        at.z >= g.z1 &&
        at.z < g.z2 + 1 &&
        at.y >= g.y1 &&
        at.y < g.y1 + 3
    );
}

/** How many rows somebody standing here has reached: 0 on the start, the
 *  row's number plus one on a row, every row on the finish. Null anywhere
 *  else (in the air between rows, below, away). */
export function rowsReached(
    layout: Layout,
    at: { x: number; y: number; z: number }
): number | null {
    if (onStart(layout, at)) return 0;
    if (onFinish(layout, at)) return layout.steps;
    if (at.y < layout.y + 0.9 || at.y >= layout.y + 2) return null;
    for (let row = 0; row < layout.steps; row += 1)
        for (const lane of [0, 1] as const)
            if (standingOn(panelOf(layout, row, lane).box, at)) return row + 1;
    return null;
}

/** The panel that breaks under somebody standing here, or null: any of their
 *  feet over it, as the pack sees it. */
export function breakingUnder(
    layout: Layout,
    seed: string,
    at: { x: number; y: number; z: number }
): Panel | null {
    return (
        breakingPanels(layout, seed).find((panel) => standingOn(panel.box, at, HALF_WIDTH)) ?? null
    );
}

/**
 * What it is built of, each only into air: the pool's lights, floor, walls
 * and water; the arches and posts, each lantern after what holds it up; the
 * gallery's floor, walls and barrier roof;
 * every panel; the finish in black and white squares; and the start's rim
 * then its floor last, its first corner the proof that the blocks stayed.
 */
export function bridgeFills(box: Box, steps: number): Fill[] {
    const layout = layoutOf(box, steps);
    const fills: Fill[] = [];
    const fill = (block: string, x1: number, y1: number, z1: number, x2 = x1, y2 = y1, z2 = z1) =>
        fills.push({ box: { x1, y1, z1, x2, y2, z2 }, block });
    const pool = layout.pool;
    // The pool: lights set in its floor, the floor round them, the walls,
    // then two blocks of water inside them.
    for (let x = pool.x1 + 3; x < pool.x2 - 1; x += 5)
        for (let z = pool.z1 + 3; z < pool.z2 - 1; z += 5) fill(POOL_LIGHT, x, pool.y1, z);
    fill(POOL_FLOOR, pool.x1, pool.y1, pool.z1, pool.x2, pool.y1, pool.z2);
    fill(POOL_WALL, pool.x1, pool.y1 + 1, pool.z1, pool.x2, pool.y2, pool.z1);
    fill(POOL_WALL, pool.x1, pool.y1 + 1, pool.z2, pool.x2, pool.y2, pool.z2);
    fill(POOL_WALL, pool.x1, pool.y1 + 1, pool.z1, pool.x1, pool.y2, pool.z2);
    fill(POOL_WALL, pool.x2, pool.y1 + 1, pool.z1, pool.x2, pool.y2, pool.z2);
    fill(WATER, pool.x1 + 1, pool.y1 + 1, pool.z1 + 1, pool.x2 - 1, pool.y1 + 2, pool.z2 - 1);

    const y = layout.y;
    // An arch over the bridge end of each platform, a lantern hanging from
    // its beam over each lane; a lantern on a post at each outer corner. What
    // holds a lantern goes in before it.
    const north = layout.middleZ - PLATFORM_HALF;
    const south = layout.middleZ + PLATFORM_HALF;
    for (const [x, beam] of [
        [layout.start.x2, BEAM],
        [layout.finish.x1, FINISH_BEAM]
    ] as const) {
        fill(PILLAR, x, y + 1, north, x, y + ARCH, north);
        fill(PILLAR, x, y + 1, south, x, y + ARCH, south);
        fill(beam, x, y + ARCH, north + 1, x, y + ARCH, south - 1);
        fill(HANGING, x, y + ARCH - 1, layout.middleZ - 2);
        fill(HANGING, x, y + ARCH - 1, layout.middleZ + 2);
    }
    for (const x of [layout.start.x1, layout.finish.x2])
        for (const z of [north, south]) {
            fill(PILLAR, x, y + 1, z, x, y + POST, z);
            fill(LANTERN, x, y + POST + 1, z);
        }

    // The gallery: a floor a step up, glass on both long sides and the ends,
    // and a barrier roof nobody climbs over.
    const g = layout.gallery;
    fill(GALLERY_FLOOR, g.x1, g.y1, g.z1, g.x2, g.y1, g.z2);
    fill(GALLERY_WALL, g.x1 - 1, g.y1, g.z1 - 1, g.x2 + 1, g.y1 + 2, g.z1 - 1);
    fill(GALLERY_WALL, g.x1 - 1, g.y1, g.z2 + 1, g.x2 + 1, g.y1 + 2, g.z2 + 1);
    fill(GALLERY_WALL, g.x1 - 1, g.y1, g.z1, g.x1 - 1, g.y1 + 2, g.z2);
    fill(GALLERY_WALL, g.x2 + 1, g.y1, g.z1, g.x2 + 1, g.y1 + 2, g.z2);
    fill(BARRIER, g.x1 - 1, g.y1 + 3, g.z1 - 1, g.x2 + 1, g.y1 + 3, g.z2 + 1);

    // The rows, both panels of each the same glass.
    for (let row = 0; row < steps; row += 1)
        for (const lane of [0, 1] as const)
            fills.push({ box: panelOf(layout, row, lane).box, block: GLASS });

    // The finish, in squares.
    const f = layout.finish;
    for (let x = f.x1; x <= f.x2; x += 1)
        for (let z = f.z1; z <= f.z2; z += 1)
            fill((x + z) % 2 === 0 ? FINISH_DARK : FINISH_LIGHT, x, y, z);

    // The start: its floor between the rims, then a rim along each side - the
    // last one's corner the proof, so nothing before it may have filled it
    // (every fill keeps what is there).
    const s = layout.start;
    fill(START_FLOOR, s.x1, y, s.z1 + 1, s.x2, y, s.z2 - 1);
    fill(START_RIM, s.x1, y, s.z1, s.x2, y, s.z1);
    fill(START_RIM, s.x1, y, s.z2, s.x2, y, s.z2);
    return fills;
}

/** Facing east, along the bridge. */
const EAST = -90;

/** Where each player waits: in rows across the start platform, facing the bridge. */
export function startSpot(layout: Layout, index: number): Spot {
    const s = layout.start;
    const across = s.z2 - s.z1 - 1;
    return {
        x: s.x2 - 1 - (Math.floor(index / across) % (s.x2 - s.x1 - 1)),
        y: layout.y + 1,
        z: s.z1 + 1 + (index % across),
        yaw: EAST
    };
}

/** Where whoever made it across waits: on the finish, clear of the bridge. */
export function finishSpot(layout: Layout, index: number): Spot {
    const f = layout.finish;
    const across = f.z2 - f.z1 - 1;
    return {
        x: f.x1 + 2 + (Math.floor(index / across) % (f.x2 - f.x1 - 2)),
        y: layout.y + 1,
        z: f.z1 + 1 + (index % across),
        yaw: 90
    };
}

/** Where whoever is out watches from: along the gallery, facing the bridge. */
export function gallerySpot(layout: Layout, index: number): Spot {
    const g = layout.gallery;
    const along = g.x2 - g.x1 + 1;
    return {
        x: g.x1 + ((index * 3) % along),
        y: g.y1 + 1,
        z: g.z2 - (Math.floor((index * 3) / along) % (g.z2 - g.z1 + 1)),
        yaw: 0,
        pitch: 30
    };
}

// ------------------------------------------------------------------ the run's own

const doneSchema = z.object({
    name: z.string(),
    /** When: who finished first, or went out first. */
    at: z.number(),
    /** How many rows they had reached. */
    rows: z.number().int().default(0),
    /** For a finish, how long it took them, in seconds. */
    seconds: z.number().default(0)
});

export const stateSchema = z.object({
    /** Who walks in which order, for a game played in turns. */
    order: z.array(z.string()).default([]),
    /** Whose turn it is, by their place in `order`; null before the first and
     *  after the last. */
    turn: z.number().int().nullable().default(null),
    /** When the walker on the bridge last reached a new row (or their turn
     *  began): standing still past `turnSeconds` puts them out. */
    movedAt: z.number().nullable().default(null),
    /** When the current walker's turn began. */
    turnAt: z.number().nullable().default(null),
    /** The furthest each player has got, in rows, and when they got there. */
    reached: z.record(z.string(), z.object({ rows: z.number().int(), at: z.number() })).default({}),
    finished: z.array(doneSchema).default([]),
    out: z.array(doneSchema).default([])
});
export type BridgeState = z.infer<typeof stateSchema>;

/** The run's game as written; null before anything is. */
export function stateOf(game: unknown): BridgeState | null {
    if (game === null || game === undefined) return null;
    const parsed = stateSchema.safeParse(game);
    return parsed.success ? parsed.data : null;
}

/** The order players walk in for a game in turns, drawn from the run's id. */
export function orderFor(seed: string, names: readonly string[]): string[] {
    const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return shuffled(sorted, seeded(`${seed}-glass-order`));
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether somebody is done: across, or out. */
export function isDone(state: BridgeState, name: string): boolean {
    return (
        state.finished.some((one) => same(one.name, name)) ||
        state.out.some((one) => same(one.name, name))
    );
}

/** Who walks the bridge now: in turns, the one whose turn it is; otherwise
 *  everybody not yet done. */
export function walkers(
    state: BridgeState,
    mode: "turns" | "free",
    names: readonly string[]
): string[] {
    if (mode === "turns") {
        const name = state.turn === null ? undefined : state.order[state.turn];
        return name && !isDone(state, name) ? [name] : [];
    }
    return names.filter((name) => !isDone(state, name));
}

/** A finish, scored above any progress: a fixed base less the seconds it took
 *  (`catalog.FINISH_BASE`, as a race is scored). */
export function finishScore(base: number, seconds: number): number {
    return base - Math.max(1, Math.round(seconds));
}

/** The scores: a finish as its time, short of it the rows reached. */
export function scoresOf(
    state: BridgeState | null,
    names: readonly string[],
    base: number
): Map<string, number> {
    const scores = new Map<string, number>();
    for (const name of names) {
        const finish = state?.finished.find((one) => same(one.name, name));
        if (finish) {
            scores.set(name, finishScore(base, finish.seconds));
            continue;
        }
        const key = Object.keys(state?.reached ?? {}).find((one) => same(one, name));
        scores.set(name, key ? state!.reached[key]!.rows : 0);
    }
    return scores;
}

/** What breaks a tie, the lower the better: who got there first. */
export function tiebreakOf(state: BridgeState | null): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, one] of Object.entries(state?.reached ?? {})) out[name] = one.at;
    for (const one of state?.finished ?? []) out[one.name] = one.at;
    return out;
}

/** Who wins: the first across, else the furthest, first there; null when
 *  nobody left the start. Never anybody in `excluded` (lowercased). */
export function winnerOf(
    state: BridgeState | null,
    names: readonly string[],
    base: number,
    excluded: ReadonlySet<string> = new Set()
): string | null {
    const scores = scoresOf(state, names, base);
    const ties = tiebreakOf(state);
    const tieOf = (name: string) =>
        Object.entries(ties).find(([one]) => same(one, name))?.[1] ?? Number.POSITIVE_INFINITY;
    const ranked = names
        .filter((name) => !excluded.has(name.toLowerCase()) && (scores.get(name) ?? 0) > 0)
        .sort((a, b) => scores.get(b)! - scores.get(a)! || tieOf(a) - tieOf(b));
    return ranked[0] ?? null;
}

// ------------------------------------------------------------------ the data pack

/** Where the pack keeps its switch. At most 16 characters, for the oldest releases. */
export const OBJECTIVE = "polaris_glass";
/** The marker stand on each panel that breaks. */
export const FAKE_TAG = "pe_gb_fake";
/** Whoever may break a panel by standing on it: the one whose turn it is, or
 *  everybody still going. */
export const WALKER_TAG = "pe_gb_walk";

/**
 * The walkers' own team, so nobody is shoved off the glass by somebody
 * walking into them (`collisionRule never`) - what the parkour and hide and
 * seek do for theirs. Gone with the run; taking the team away takes everybody
 * off it.
 */
export const NO_PUSH_TEAM = "pe_glass";

/** The team made, and each of `names` on it - only if they are on none of the
 *  server's own, whose colour and prefix are theirs to keep. */
export function noPushLines(names: readonly string[]): string[] {
    return [
        `team remove ${NO_PUSH_TEAM}`,
        `team add ${NO_PUSH_TEAM}`,
        `team modify ${NO_PUSH_TEAM} collisionRule never`,
        `team modify ${NO_PUSH_TEAM} friendlyFire false`,
        ...names.map(
            (name) =>
                `execute if entity @a[name=${name},team=] run team join ${NO_PUSH_TEAM} ${name}`
        )
    ];
}

/**
 * The pack's functions under `polaris:glass/`: each tick, while the switch is
 * on, every marker whose panel a walker stands on - the panel's whole
 * footprint, a block high over it - shatters its panel and goes.
 */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [`execute if score #on ${OBJECTIVE} matches 1 run function polaris:glass/run`],
    run: [
        `execute as @e[type=minecraft:armor_stand,tag=${FAKE_TAG}] at @s positioned ~-0.5 ~ ~-0.5 if entity @a[tag=${WALKER_TAG},dx=${PANEL - 1},dy=0,dz=${PANEL - 1}] run function polaris:glass/shatter`
    ],
    shatter: [
        `fill ~ ~-1 ~ ~${PANEL - 1} ~-1 ~${PANEL - 1} minecraft:air replace ${GLASS}`,
        "playsound minecraft:block.glass.break block @a ~1.5 ~ ~1.5 2 0.8",
        "particle minecraft:cloud ~1.5 ~ ~1.5 1 0.1 1 0.02 30",
        "kill @s"
    ]
};

/** The markers in the box, gone. */
function markersOut(box: Box): string {
    return `execute in minecraft:overworld run kill @e[type=minecraft:armor_stand,tag=${FAKE_TAG},${within(box)}]`;
}

/** Switched on at "Go!": a marker on every panel that breaks, at its north
 *  west corner a block over the glass, then the switch. */
export function armLines(box: Box, layout: Layout, seed: string): string[] {
    return [
        `scoreboard objectives add ${OBJECTIVE} dummy`,
        markersOut(box),
        ...breakingPanels(layout, seed).map(
            (panel) =>
                `execute in minecraft:overworld run summon minecraft:armor_stand ${panel.box.x1} ${layout.y + 1} ${panel.box.z1} {Tags:["${FAKE_TAG}"],Marker:1b,Invisible:1b,NoGravity:1b,Invulnerable:1b}`
        ),
        `scoreboard players set #on ${OBJECTIVE} 1`
    ];
}

/** Switched off, its markers and the walkers' tag gone. Safe when never on. */
export function stopLines(box: Box): string[] {
    return [
        `scoreboard players set #on ${OBJECTIVE} 0`,
        markersOut(box),
        `tag @a remove ${WALKER_TAG}`,
        `team remove ${NO_PUSH_TEAM}`
    ];
}

/** A panel shattered from here, as the pack would: where it was missed. */
export function shatterLines(panel: Panel): string[] {
    const { x1, y1, z1, x2, z2 } = panel.box;
    const middle = `${x1 + 1.5} ${y1 + 1} ${z1 + 1.5}`;
    return [
        `execute in minecraft:overworld run fill ${x1} ${y1} ${z1} ${x2} ${y1} ${z2} minecraft:air replace ${GLASS}`,
        `execute in minecraft:overworld run playsound minecraft:block.glass.break block @a ${middle} 2 0.8`,
        `execute in minecraft:overworld run particle minecraft:cloud ${middle} 1 0.1 1 0.02 30`
    ];
}

/** Whether somebody may break glass: given or taken off. */
export function walkerLine(name: string, walking: boolean): string {
    return `tag ${name} ${walking ? "add" : "remove"} ${WALKER_TAG}`;
}

/** Nobody hurt, and nobody able to hurt: no pushing anybody off. */
export function unhurtLines(name: string): string[] {
    return [
        `effect give ${name} minecraft:resistance 3 4 true`,
        `effect give ${name} minecraft:weakness 3 100 true`,
        `effect give ${name} minecraft:saturation 3 0 true`
    ];
}

/** Where the season's pieces go (`arena-decor`): on the arches' pillars and
 *  along their beams, over everybody's heads - never on a panel or a platform. */
export function decorSpots(box: Box, steps: number): decor.Spot[] {
    const layout = layoutOf(box, steps);
    const top = layout.y + ARCH + 1;
    const north = layout.middleZ - PLATFORM_HALF;
    const south = layout.middleZ + PLATFORM_HALF;
    return [layout.start.x2, layout.finish.x1].flatMap((x): decor.Spot[] => [
        { x, y: top, z: north, kind: "stand" },
        { x, y: top, z: south, kind: "stand" },
        ...Array.from(
            { length: south - north - 1 },
            (_, step): decor.Spot => ({
                x,
                y: top,
                z: north + 1 + step,
                kind: "garland"
            })
        )
    ]);
}
