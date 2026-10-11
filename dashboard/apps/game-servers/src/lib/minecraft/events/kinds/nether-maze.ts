/**
 * A deadly nether maze: a roofed maze of netherrack floating over a site, a new
 * one every run, with fire, magma and lava along its corridors. The racers wait
 * in a small room outside its wall; at "Go!" the glass door goes and the first
 * to reach the bright room at its centre wins. Touching fire, standing on magma
 * or stepping into lava never hurts anybody - everybody inside has Resistance V
 * like on every stage - but it sends them back to the starting room.
 *
 * The maze is carved from the run's id (`plan`) with hide and seek's carver
 * (`seek-maze.ts`), so a restart works out the same one, and checked against
 * rules before it is built (`mazeProblems`):
 *
 * - **Never solved through a wall or over it.** Every wall is at least two
 *   blocks thick, the roof is solid over every block of it, and corridors are
 *   four blocks high: nobody climbs out, and nobody sees round a corner by
 *   pushing their camera into a one-block wall.
 * - **Deadly, but always fair.** No hazard in the starting room, at the goal,
 *   or in a room next to the start. A patch of fire or magma covers part of a
 *   room, never all of it; a lava pit is one block across a doorway, jumped
 *   with four blocks of head room. Walking on safe blocks - and jumping a pit -
 *   reaches every room from the start (the tests walk thousands of mazes).
 * - **Every hazard is in sight**: a light in the roof of every other room, and
 *   fire, magma and lava glow on their own.
 *
 * The hazards and the goal are watched inside the game, by the events data pack
 * (`FUNCTIONS`): a look over RCON comes round every 400 ms, and a player who ran
 * through a fire would be past it before the look.
 *
 * Minimaps: Xaero's fair-play code (`radar.ts`) is sent to every racer, which
 * switches off its cave view - the only view that could draw the corridors
 * under a roof - and its radar; the reset goes with them home.
 *
 * An X-ray texture pack still shows the corridors: the anti-xray Polaris ships
 * hides ores only, never air, and hiding air would hide the maze from its
 * players too. Nothing in a maze built of ordinary blocks can stop that.
 *
 * A run keeps the design it was built with (`stage.design`), so an update in
 * the middle of a race never moves the maze from under it.
 *
 * Pure: the plan, the boxes and the lines are functions of what they are given.
 */

import { seeded } from "../trivia-bank";
import * as seekMaze from "./seek-maze";
import { rectangles } from "./boat-race";
import type { EventOptions } from "../catalog";
import type { Box, Spot, Volume } from "./stage";

/** How mazes are laid out now, written onto the stage when one is built:
 *  2 dresses the goal as a finish (`FINISH_SINCE`), 3 stacks floors joined by
 *  stairs and sets traps (`LEVELS_SINCE`). */
export const DESIGN = 3;
/** The first design whose goal is a finish booth: a chequered threshold, a
 *  chequered gold floor, chequered walls round it and light over the way in. */
export const FINISH_SINCE = 2;
/**
 * The first design built as floors stacked one over the other (`LEVELS`), each
 * its own maze, the goal in the middle of the top one, and a winding stair from
 * a dead end of each floor up to the next. It also sets traps: fire jets across
 * doorways that light and go out on a beat, and soul sand that slows a racer.
 */
export const LEVELS_SINCE = 3;

export type MazeSize = EventOptions<"nether-maze">["size"];
export type Hazards = EventOptions<"nether-maze">["hazards"];

/** Rooms a side: always odd, so there is a room in the very middle. */
export const CELLS: Readonly<Record<MazeSize, number>> = { small: 7, medium: 11, large: 15 };
/** Blocks across a corridor, and the thickness of every wall. */
export const CORRIDOR = 3;
export const WALL = 2;
const PITCH = CORRIDOR + WALL;
/** Air from the floor to the roof. */
export const HEADROOM = 4;
/** Floors a maze is built of, from `LEVELS_SINCE`. */
export const LEVELS: Readonly<Record<MazeSize, number>> = { small: 2, medium: 2, large: 3 };
/** The most floors any maze has: the data pack keeps a landing for each. */
export const MOST_LEVELS = 3;
/** From one floor to the next: the roof, a block of rock and the next floor
 *  over the headroom, so no floor is ever seen through. */
export const LEVEL_PITCH = HEADROOM + 3;
/** Steps in a stair, one a block higher than the last, round a room's edge. */
const STEPS = LEVEL_PITCH;
/** Air kept over every step: a stand, a head and a jump to the next. */
const STEP_CLEAR = 4;
/** About how many of the rooms (and doorways) carry a hazard. */
const DENSITY: Readonly<Record<Hazards, number>> = { few: 0.1, some: 0.2, many: 0.32 };
/** How many braids the carver knocks through: a few loops, more than one way round. */
const LOOPS = 0.08;

const NETHERRACK: Box["block"] = "minecraft:netherrack";
const MAGMA: Box["block"] = "minecraft:magma_block";
const LAVA: Box["block"] = "minecraft:lava";
const FIRE: Box["block"] = "minecraft:fire";
const LIGHT: Box["block"] = "minecraft:glowstone";
/** The goal has to read as the goal from the doorway into it: a quartz floor
 *  under the same glowstone as every other room was walked past by racers who
 *  were standing in it. Gold underfoot and a whole ceiling of sea lanterns - a
 *  colour and a brightness nothing else in the maze has. */
const GOAL: Box["block"] = "minecraft:gold_block";
const GOAL_LIGHT: Box["block"] = "minecraft:sea_lantern";
const START: Box["block"] = "minecraft:nether_bricks";
const DOOR: Box["block"] = "minecraft:glass";
/** A finish's chequer, the way every race's flag is. */
const DARK: Box["block"] = "minecraft:black_concrete";
const LIGHT_SQUARE: Box["block"] = "minecraft:white_concrete";
/** A slow patch: walkable, never sends anybody back. */
const SOUL: Box["block"] = "minecraft:soul_sand";
/** The stairs between floors, and the post they wind round. */
const STAIR: Box["block"] = "minecraft:nether_bricks";

/**
 * What stands on one column of one floor. A `jet` is a doorway's fire that
 * lights and goes out on a beat (`JET_PERIOD`); `soul` is soul sand; a `shaft`
 * is where the stair from the floor below comes up through, with no floor.
 */
export type Tile =
    | "wall"
    | "floor"
    | "magma"
    | "fire"
    | "lava"
    | "goal"
    | "start"
    | "door"
    | "jet"
    | "soul"
    | "shaft";

const key = (x: number, z: number) => `${x},${z}`;

const SIDES = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
] as const;

export interface Plan {
    readonly design: number;
    readonly cells: number;
    readonly maze: seekMaze.Maze;
    /** The room on the edge the door opens into, and the way out of it to the door. */
    readonly entry: {
        readonly x: number;
        readonly z: number;
        readonly dx: number;
        readonly dz: number;
    };
    /** Every column, by `x,z` in the maze's own blocks (room (0, 0) starts at 2, 2). */
    readonly tiles: ReadonlyMap<string, Tile>;
    /** How many hazards it was given, on every floor. */
    readonly hazards: number;
    /** Every floor from the ground up: the first is `maze` and `tiles`. */
    readonly levels: readonly Level[];
    /** The stair from each floor to the one over it. */
    readonly stairs: readonly Stair[];
}

/** A room, by its place on the grid of rooms. */
export interface Room {
    readonly cx: number;
    readonly cz: number;
}

export interface Level {
    readonly maze: seekMaze.Maze;
    readonly tiles: ReadonlyMap<string, Tile>;
    /** The room the floor is come into: the door's on the ground floor, the
     *  stair's from below on every other. */
    readonly arrival: Room;
    /** The room it is left by: the stair up, or the goal on the top floor. */
    readonly exit: Room;
    /** The block every safe block of the floor is walked to from. */
    readonly from: string;
}

/**
 * A stair up from a dead end: its steps wind round the room's edge, one a
 * block higher than the last, from the block beside the doorway (`dx`, `dz`
 * is the way out) the way `turn` goes, and come out beside the same doorway
 * on the floor over it - a dead end there too.
 */
export interface Stair extends Room {
    readonly level: number;
    readonly dx: number;
    readonly dz: number;
    readonly turn: 1 | -1;
}

/** The first block of a room along one axis. */
export const roomStart = (cell: number) => WALL + cell * PITCH;

/** Rooms on the way from every room to the middle one - or to `to` - through
 *  open walls. */
export function distances(maze: seekMaze.Maze, to?: Room): number[] {
    const cells = maze.cells;
    const middle = (cells - 1) / 2;
    const far = new Array<number>(cells * cells).fill(-1);
    const [tx, tz] = to ? [to.cx, to.cz] : [middle, middle];
    far[tz * cells + tx] = 0;
    const queue: [number, number][] = [[tx, tz]];
    for (let head = 0; head < queue.length; head += 1) {
        const [x, z] = queue[head]!;
        for (const [dx, dz] of SIDES)
            if (seekMaze.open(maze, x, z, dx, dz) && far[(z + dz) * cells + x + dx] === -1) {
                far[(z + dz) * cells + x + dx] = far[z * cells + x]! + 1;
                queue.push([x + dx, z + dz]);
            }
    }
    return far;
}

/** The room on the edge furthest from the middle (ties drawn), and its way out. */
function entryOf(maze: seekMaze.Maze, random: () => number): Plan["entry"] {
    const cells = maze.cells;
    const far = distances(maze);
    const edge: Plan["entry"][] = [];
    for (let i = 0; i < cells; i += 1) {
        edge.push({ x: i, z: 0, dx: 0, dz: -1 });
        edge.push({ x: i, z: cells - 1, dx: 0, dz: 1 });
        edge.push({ x: 0, z: i, dx: -1, dz: 0 });
        edge.push({ x: cells - 1, z: i, dx: 1, dz: 0 });
    }
    const most = Math.max(...edge.map((one) => far[one.z * cells + one.x]!));
    const furthest = edge.filter((one) => far[one.z * cells + one.x] === most);
    return furthest[Math.floor(random() * furthest.length)]!;
}

/** The tiles of a floor with no hazards yet: rooms, doorways and walls, the
 *  goal on the top floor, and on the ground floor the door and the starting
 *  room outside it. */
function plainTiles(
    maze: seekMaze.Maze,
    entry: Plan["entry"] | null,
    goal = true
): Map<string, Tile> {
    const cells = maze.cells;
    const side = cells * PITCH + WALL;
    const tiles = new Map<string, Tile>();
    for (let x = 0; x < side; x += 1)
        for (let z = 0; z < side; z += 1) tiles.set(key(x, z), "wall");
    const middle = (cells - 1) / 2;
    for (let cz = 0; cz < cells; cz += 1)
        for (let cx = 0; cx < cells; cx += 1) {
            const x0 = roomStart(cx);
            const z0 = roomStart(cz);
            const room = goal && cx === middle && cz === middle ? "goal" : "floor";
            for (let a = 0; a < CORRIDOR; a += 1)
                for (let b = 0; b < CORRIDOR; b += 1) tiles.set(key(x0 + a, z0 + b), room);
            if (seekMaze.open(maze, cx, cz, 1, 0))
                for (let a = 0; a < WALL; a += 1)
                    for (let b = 0; b < CORRIDOR; b += 1)
                        tiles.set(key(x0 + CORRIDOR + a, z0 + b), "floor");
            if (seekMaze.open(maze, cx, cz, 0, 1))
                for (let a = 0; a < CORRIDOR; a += 1)
                    for (let b = 0; b < WALL; b += 1)
                        tiles.set(key(x0 + a, z0 + CORRIDOR + b), "floor");
        }
    if (!entry) return tiles;
    // The door through the outer wall, and the starting room beyond it with
    // its own walls round it.
    const x0 = roomStart(entry.x);
    const z0 = roomStart(entry.z);
    const along = entry.dx !== 0;
    for (let step = 1; step <= WALL + CORRIDOR + WALL; step += 1)
        for (let across = -WALL; across < CORRIDOR + WALL; across += 1) {
            const room = step > WALL && step <= WALL + CORRIDOR && across >= 0 && across < CORRIDOR;
            const door = step <= WALL && across >= 0 && across < CORRIDOR;
            const inner = along
                ? entry.dx > 0
                    ? x0 + CORRIDOR - 1 + step
                    : x0 - step
                : x0 + across;
            const other = along ? z0 + across : entry.dz > 0 ? z0 + CORRIDOR - 1 + step : z0 - step;
            tiles.set(key(inner, other), room ? "start" : door ? "door" : "wall");
        }
    return tiles;
}

/** Which room (or doorway) a block of the maze belongs to: hazards are placed
 *  by room, at most one in each. */
function roomOf(x: number, z: number, cells: number): { cx: number; cz: number } | null {
    const cx = Math.floor((x - WALL) / PITCH);
    const cz = Math.floor((z - WALL) / PITCH);
    if (cx < 0 || cz < 0 || cx >= cells || cz >= cells) return null;
    return { cx, cz };
}

/** The ways a room can be made deadly, each leaving a way through. */
const ROOM_PATTERNS: readonly (readonly [number, number][])[] = [
    // One side of the room.
    [
        [0, 0],
        [0, 1],
        [0, 2]
    ],
    [
        [2, 0],
        [2, 1],
        [2, 2]
    ],
    [
        [0, 0],
        [1, 0],
        [2, 0]
    ],
    [
        [0, 2],
        [1, 2],
        [2, 2]
    ],
    // The four corners: a cross to walk.
    [
        [0, 0],
        [2, 0],
        [0, 2],
        [2, 2]
    ],
    // The middle: a ring round it.
    [[1, 1]],
    // Two corners on a diagonal.
    [
        [0, 0],
        [2, 2]
    ],
    [
        [2, 0],
        [0, 2]
    ]
];

/** A maze whose walls can still be moved: a floor being fitted to its stairs. */
interface Carved {
    readonly cells: number;
    readonly east: boolean[];
    readonly south: boolean[];
}

function copyOf(maze: seekMaze.Maze): Carved {
    return { cells: maze.cells, east: [...maze.east], south: [...maze.south] };
}

function setWall(maze: Carved, x: number, z: number, dx: number, dz: number, open: boolean): void {
    const nx = x + dx;
    const nz = z + dz;
    if (nx < 0 || nz < 0 || nx >= maze.cells || nz >= maze.cells) return;
    if (dx !== 0) maze.east[z * maze.cells + Math.min(x, nx)] = open;
    else maze.south[Math.min(z, nz) * maze.cells + x] = open;
}

const same = (one: Room, other: Room) => one.cx === other.cx && one.cz === other.cz;

/**
 * Makes `room` a dead end whose one way out is (`dx`, `dz`), then joins back
 * whatever that cut off - through a wall between it and the rest, never one of
 * `room` or of the rooms in `keep`.
 */
function deadEndAt(
    maze: Carved,
    room: Room,
    dx: number,
    dz: number,
    keep: readonly Room[],
    random: () => number
): void {
    for (const [sx, sz] of SIDES) setWall(maze, room.cx, room.cz, sx, sz, sx === dx && sz === dz);
    const cells = maze.cells;
    for (;;) {
        const far = distances(maze, room);
        const joins: [number, number, number, number][] = [];
        for (let cz = 0; cz < cells; cz += 1)
            for (let cx = 0; cx < cells; cx += 1) {
                if (far[cz * cells + cx] !== -1) continue;
                for (const [sx, sz] of SIDES) {
                    const nx = cx + sx;
                    const nz = cz + sz;
                    if (nx < 0 || nz < 0 || nx >= cells || nz >= cells) continue;
                    if (far[nz * cells + nx] === -1) continue;
                    const near = { cx: nx, cz: nz };
                    if (same(near, room) || keep.some((one) => same(one, near))) continue;
                    joins.push([cx, cz, sx, sz]);
                }
            }
        if (joins.length === 0) return;
        const [jx, jz, sx, sz] = joins[Math.floor(random() * joins.length)]!;
        setWall(maze, jx, jz, sx, sz, true);
    }
}

/** A dead end of a floor as far from where it is come into as any, for the
 *  stair up; never one of `avoid`. Made one when the floor has none left. */
function stairFrom(
    maze: Carved,
    arrival: Room,
    avoid: readonly Room[],
    random: () => number
): { cx: number; cz: number; dx: number; dz: number } {
    const cells = maze.cells;
    const far = distances(maze, arrival);
    const ends = seekMaze
        .deadEnds(maze)
        .map(([cx, cz]) => ({ cx, cz }))
        .filter((room) => !avoid.some((one) => same(one, room)));
    if (ends.length > 0) {
        const most = Math.max(...ends.map((room) => far[room.cz * cells + room.cx]!));
        const furthest = ends.filter((room) => far[room.cz * cells + room.cx] === most);
        const room = furthest[Math.floor(random() * furthest.length)]!;
        const [dx, dz] = SIDES.find(([sx, sz]) => seekMaze.open(maze, room.cx, room.cz, sx, sz))!;
        return { ...room, dx, dz };
    }
    // No dead end to spare: the furthest room is made one, by the side it was
    // reached from.
    let room: Room = { cx: 0, cz: 0 };
    let best = -1;
    for (let cz = 0; cz < cells; cz += 1)
        for (let cx = 0; cx < cells; cx += 1)
            if (!avoid.some((one) => same(one, { cx, cz })) && far[cz * cells + cx]! > best) {
                room = { cx, cz };
                best = far[cz * cells + cx]!;
            }
    const [dx, dz] = SIDES.find(
        ([sx, sz]) =>
            seekMaze.open(maze, room.cx, room.cz, sx, sz) &&
            far[(room.cz + sz) * cells + room.cx + sx] === best - 1
    )!;
    deadEndAt(maze, room, dx, dz, [arrival], random);
    return { ...room, dx, dz };
}

/** A room's edge, round from its north-west corner: where a stair's steps go. */
const RING: readonly (readonly [number, number])[] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
    [2, 2],
    [1, 2],
    [0, 2],
    [0, 1]
];

/**
 * The block of a stair's room each step is on, from the foot (0: on the floor,
 * beside the doorway) to the top (`STEPS`: level with the floor over it), in
 * the maze's own blocks. Step `s` is `s` blocks over the floor.
 */
export function stepsOf(stair: Stair): [number, number][] {
    const a = stair.dx === 0 ? 1 : stair.dx > 0 ? 2 : 0;
    const b = stair.dz === 0 ? 1 : stair.dz > 0 ? 2 : 0;
    const first = RING.findIndex(([x, z]) => x === a && z === b);
    const x0 = roomStart(stair.cx);
    const z0 = roomStart(stair.cz);
    return Array.from({ length: STEPS + 1 }, (_, step) => {
        const turned = (((first + stair.turn * step) % RING.length) + RING.length) % RING.length;
        const [x, z] = RING[turned]!;
        return [x0 + x, z0 + z];
    });
}

/** Whether a step needs the floor over it open: its air reaches that floor. */
const throughFloor = (step: number) => step > 0 && step < STEPS && step + STEP_CLEAR >= LEVEL_PITCH;

/** The rooms of a floor that never get a hazard: where it is come into and the
 *  rooms beside it, where it is left by, and the middle. */
function sparedOn(cells: number, arrival: Room, exit: Room): Set<string> {
    const middle = (cells - 1) / 2;
    const spared = new Set<string>([
        key(middle, middle),
        key(arrival.cx, arrival.cz),
        key(exit.cx, exit.cz)
    ]);
    for (const [dx, dz] of SIDES) spared.add(key(arrival.cx + dx, arrival.cz + dz));
    return spared;
}

/** Hazards put on one floor one at a time - any that would cut a block off is
 *  left out - until about `DENSITY` of its rooms have one. How many went on. */
function placeHazards(
    maze: seekMaze.Maze,
    tiles: Map<string, Tile>,
    from: string,
    spared: ReadonlySet<string>,
    options: Pick<EventOptions<"nether-maze">, "hazards">,
    design: number,
    random: () => number
): number {
    const cells = maze.cells;
    const grid = gridOf(tiles, from);
    const traps = design >= LEVELS_SINCE;
    const rooms: { cx: number; cz: number }[] = [];
    for (let cz = 0; cz < cells; cz += 1)
        for (let cx = 0; cx < cells; cx += 1) if (!spared.has(key(cx, cz))) rooms.push({ cx, cz });
    // Shuffled, then each tried in turn until enough are placed.
    for (let index = rooms.length - 1; index > 0; index -= 1) {
        const other = Math.floor(random() * (index + 1));
        [rooms[index], rooms[other]] = [rooms[other]!, rooms[index]!];
    }
    const wanted = Math.max(1, Math.round(cells * cells * DENSITY[options.hazards]));
    let placed = 0;
    for (const { cx, cz } of rooms) {
        if (placed >= wanted) break;
        const x0 = roomStart(cx);
        const z0 = roomStart(cz);
        // A doorway east or south with a pit (or a jet) across it, or a patch
        // in the room.
        const doorways = (
            [
                [1, 0],
                [0, 1]
            ] as const
        ).filter(
            ([dx, dz]) => seekMaze.open(maze, cx, cz, dx, dz) && !spared.has(key(cx + dx, cz + dz))
        );
        const change = new Map<string, Tile>();
        if (doorways.length > 0 && random() < 0.35) {
            const [dx] = doorways[Math.floor(random() * doorways.length)]!;
            const across: Tile = traps && random() < 0.5 ? "jet" : "lava";
            // The first block of the doorway, across all of it: one to jump,
            // or to time.
            for (let step = 0; step < CORRIDOR; step += 1)
                change.set(
                    dx === 1 ? key(x0 + CORRIDOR, z0 + step) : key(x0 + step, z0 + CORRIDOR),
                    across
                );
        } else {
            const pattern = ROOM_PATTERNS[Math.floor(random() * ROOM_PATTERNS.length)]!;
            const roll = random();
            const kind: Tile = traps
                ? roll < 0.4
                    ? "fire"
                    : roll < 0.8
                      ? "magma"
                      : "soul"
                : roll < 0.5
                  ? "fire"
                  : "magma";
            for (const [a, b] of pattern) change.set(key(x0 + a, z0 + b), kind);
        }
        const before = new Map<string, Tile>();
        for (const [at, tile] of change) {
            before.set(at, tiles.get(at)!);
            tiles.set(at, tile);
            setTile(grid, at, tile);
        }
        if (lostOn(grid).count === 0) placed += 1;
        else
            for (const [at, tile] of before) {
                tiles.set(at, tile);
                setTile(grid, at, tile);
            }
    }
    return placed;
}

/**
 * The maze for a run: carved from its id, the door on the edge furthest from
 * the middle; from `LEVELS_SINCE` a floor carved over it for each of
 * `LEVELS`, a stair up from the dead end of each furthest from where it is
 * come into, and the goal in the middle of the top one. Then hazards on every
 * floor one at a time - any that would cut a block off is left out - until
 * about `DENSITY` of its rooms have one.
 */
export function plan(
    options: Pick<EventOptions<"nether-maze">, "size" | "hazards">,
    seed: string,
    design = DESIGN
): Plan {
    const cells = CELLS[options.size];
    const random = seeded(`nether-maze-${design}-${seed}`);
    const ground = copyOf(seekMaze.carve(cells, random, LOOPS));
    const entry = entryOf(ground, random);
    const count = design >= LEVELS_SINCE ? LEVELS[options.size] : 1;
    const middle = (cells - 1) / 2;
    const centre: Room = { cx: middle, cz: middle };
    const mazes: Carved[] = [ground];
    const arrivals: Room[] = [{ cx: entry.x, cz: entry.z }];
    const stairs: Stair[] = [];
    for (let level = 0; level + 1 < count; level += 1) {
        const arrival = arrivals[level]!;
        const up = stairFrom(mazes[level]!, arrival, [arrival, centre], random);
        const stair: Stair = { ...up, level, turn: random() < 0.5 ? 1 : -1 };
        const above = copyOf(seekMaze.carve(cells, random, LOOPS));
        deadEndAt(above, stair, stair.dx, stair.dz, [], random);
        stairs.push(stair);
        mazes.push(above);
        arrivals.push({ cx: stair.cx, cz: stair.cz });
    }
    let hazards = 0;
    const levels: Level[] = mazes.map((maze, level) => {
        const tiles = plainTiles(maze, level === 0 ? entry : null, level === count - 1);
        const below = stairs[level - 1];
        if (below)
            stepsOf(below).forEach(([x, z], step) => {
                if (throughFloor(step)) tiles.set(key(x, z), "shaft");
            });
        const from = below
            ? key(...stepsOf(below)[0]!)
            : [...tiles].find(([, tile]) => tile === "start")![0];
        const arrival = arrivals[level]!;
        const exit: Room = stairs[level] ?? centre;
        hazards += placeHazards(
            maze,
            tiles,
            from,
            sparedOn(cells, arrival, exit),
            options,
            design,
            random
        );
        return { maze, tiles, arrival, exit: { cx: exit.cx, cz: exit.cz }, from };
    });
    return {
        design,
        cells,
        maze: ground,
        entry,
        tiles: levels[0]!.tiles,
        hazards,
        levels,
        stairs
    };
}

/** Whether a player can stand on a tile without being sent back - a jet
 *  between its flames, soul sand however slowly. */
function safe(tile: Tile | undefined): boolean {
    return (
        tile === "floor" ||
        tile === "goal" ||
        tile === "start" ||
        tile === "door" ||
        tile === "jet" ||
        tile === "soul"
    );
}

/** The tiles as numbers on a flat grid, for walks over thousands of blocks:
 *  0 nothing, 1 wall, 2 safe, 3 fire or magma, 4 lava. */
interface Grid {
    readonly x0: number;
    readonly z0: number;
    readonly width: number;
    readonly depth: number;
    readonly codes: Uint8Array;
    readonly start: number;
}

const CODES: Readonly<Record<Tile, number>> = {
    wall: 1,
    floor: 2,
    goal: 2,
    start: 2,
    door: 2,
    jet: 2,
    soul: 2,
    fire: 3,
    magma: 3,
    lava: 4,
    shaft: 0
};

/** The grid of a floor, walked from `from` - the starting room's first block
 *  when not given. */
function gridOf(tiles: ReadonlyMap<string, Tile>, from?: string): Grid {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    const parsed: [number, number, Tile][] = [];
    for (const [at, tile] of tiles) {
        const [x, z] = at.split(",").map(Number) as [number, number];
        parsed.push([x, z, tile]);
        x0 = Math.min(x0, x);
        z0 = Math.min(z0, z);
        x1 = Math.max(x1, x);
        z1 = Math.max(z1, z);
    }
    // A border of nothing all round, so a step never leaves the grid.
    x0 -= 2;
    z0 -= 2;
    const width = x1 - x0 + 3;
    const depth = z1 - z0 + 3;
    const codes = new Uint8Array(width * depth);
    let start = -1;
    for (const [x, z, tile] of parsed) {
        codes[(z - z0) * width + (x - x0)] = CODES[tile];
        if (from === undefined && tile === "start" && start === -1)
            start = (z - z0) * width + (x - x0);
    }
    if (from !== undefined && safe(tiles.get(from))) {
        const [x, z] = from.split(",").map(Number) as [number, number];
        start = (z - z0) * width + (x - x0);
    }
    return { x0, z0, width, depth, codes, start };
}

function setTile(grid: Grid, at: string, tile: Tile): void {
    const [x, z] = at.split(",").map(Number) as [number, number];
    grid.codes[(z - grid.z0) * grid.width + (x - grid.x0)] = CODES[tile];
}

/** How many safe blocks no walk from the starting room reaches, and the first. */
function lostOn(grid: Grid): { count: number; first: number } {
    const { codes, width } = grid;
    if (grid.start < 0) return { count: 1, first: -1 };
    const seen = new Uint8Array(codes.length);
    const queue = new Int32Array(codes.length);
    let tail = 0;
    queue[tail++] = grid.start;
    seen[grid.start] = 1;
    const steps = [1, -1, width, -width];
    for (let head = 0; head < tail; head += 1) {
        const at = queue[head]!;
        for (const step of steps) {
            const near = at + step;
            const code = codes[near];
            const target =
                code === 2 ? near : code === 4 && codes[near + step] === 2 ? near + step : -1;
            if (target < 0 || seen[target]) continue;
            seen[target] = 1;
            queue[tail++] = target;
        }
    }
    let count = 0;
    let first = -1;
    for (let index = 0; index < codes.length; index += 1)
        if (codes[index] === 2 && !seen[index]) {
            count += 1;
            if (first < 0) first = index;
        }
    return { count, first };
}

/**
 * The safe blocks no walk from the starting room - or from `from` - reaches:
 * nothing in a fair maze. A walk steps onto a side's safe block, or jumps one
 * block of lava in a straight line onto a safe block beyond it.
 */
export function unreached(tiles: ReadonlyMap<string, Tile>, from?: string): string[] {
    const grid = gridOf(tiles, from);
    if (grid.start < 0) return [from === undefined ? "no starting room" : `no footing at ${from}`];
    const { count, first } = lostOn(grid);
    if (count === 0) return [];
    const at = key((first % grid.width) + grid.x0, Math.floor(first / grid.width) + grid.z0);
    return Array.from({ length: count }, (_, index) => (index === 0 ? at : "more"));
}

/** The one way out of a room on a floor, or null when it has more or none. */
function onlyWayOut(maze: seekMaze.Maze, room: Room): readonly [number, number] | null {
    const ways = SIDES.filter(([dx, dz]) => seekMaze.open(maze, room.cx, room.cz, dx, dz));
    return ways.length === 1 ? ways[0]! : null;
}

/**
 * What is wrong with a plan, as sentences: nothing when it keeps every rule.
 * Worked out from the tiles, not from how they were placed - on every floor.
 */
export function mazeProblems(maze: Plan): string[] {
    const problems: string[] = [];
    const { cells } = maze;
    const middle = (cells - 1) / 2;
    const top = maze.levels.length - 1;
    maze.levels.forEach((level, index) => {
        // The ground floor's tiles are the plan's own.
        const tiles = index === 0 ? maze.tiles : level.tiles;
        const on = maze.levels.length > 1 ? ` on floor ${index}` : "";
        const lost = unreached(tiles, index === 0 ? undefined : level.from);
        if (lost.length > 0)
            problems.push(`${lost.length} safe blocks cut off${on}, first ${lost[0]}`);
        const goal = [...tiles].filter(([, tile]) => tile === "goal");
        const wanted = index === top ? CORRIDOR * CORRIDOR : 0;
        if (goal.length !== wanted) problems.push(`a goal of ${goal.length} blocks${on}`);
        // Every wall at least two thick: between two open blocks along a line,
        // or between one and the outside, never a single block of wall.
        for (const [at, tile] of tiles) {
            if (tile === "wall") continue;
            const [x, z] = at.split(",").map(Number) as [number, number];
            for (const [dx, dz] of SIDES) {
                if (tiles.get(key(x + dx, z + dz)) !== "wall") continue;
                const after = tiles.get(key(x + 2 * dx, z + 2 * dz));
                if (after !== "wall") problems.push(`a wall one block thick at ${at}${on}`);
            }
        }
        // Hazards: never where the race starts or ends, nor next to where a
        // floor is come into, nor in a stair's room; lava only ever one block
        // across, and a jet only across a doorway.
        const arrival = level.arrival;
        for (const [at, tile] of tiles) {
            if (tile !== "fire" && tile !== "magma" && tile !== "lava" && tile !== "jet") continue;
            const [x, z] = at.split(",").map(Number) as [number, number];
            const room = roomOf(x, z, cells);
            if (!room) {
                problems.push(`a hazard outside the rooms at ${at}${on}`);
                continue;
            }
            if (room.cx === middle && room.cz === middle)
                problems.push(`a hazard at the goal ${at}${on}`);
            if (Math.abs(room.cx - arrival.cx) + Math.abs(room.cz - arrival.cz) <= 1)
                problems.push(`a hazard by the start at ${at}${on}`);
            if (same(room, level.exit)) problems.push(`a hazard by the stairs at ${at}${on}`);
            const inDoorway = (x - WALL) % PITCH >= CORRIDOR || (z - WALL) % PITCH >= CORRIDOR;
            if (tile === "jet" && !inDoorway) problems.push(`a jet in a room at ${at}${on}`);
            // One block across, along a line with safe ground on both sides of it.
            if (
                tile === "lava" &&
                !(safe(tiles.get(key(x - 1, z))) && safe(tiles.get(key(x + 1, z)))) &&
                !(safe(tiles.get(key(x, z - 1))) && safe(tiles.get(key(x, z + 1))))
            )
                problems.push(`lava more than one block across at ${at}${on}`);
        }
    });
    // Each stair from a dead end, out the same side on both floors, to a dead
    // end over it that is neither the goal nor another stair's foot.
    for (const stair of maze.stairs) {
        const below = maze.levels[stair.level];
        const above = maze.levels[stair.level + 1];
        if (!below || !above) {
            problems.push(`a stair from floor ${stair.level} to nowhere`);
            continue;
        }
        for (const [name, level] of [
            ["below", below],
            ["above", above]
        ] as const) {
            const way = onlyWayOut(level.maze, stair);
            if (!way || way[0] !== stair.dx || way[1] !== stair.dz)
                problems.push(`a stair ${name} floor ${stair.level + 1} not in a dead end`);
        }
        if (!same(below.exit, stair) || !same(above.arrival, stair))
            problems.push(`a stair not where floor ${stair.level} is left`);
        if (stair.cx === middle && stair.cz === middle) problems.push("a stair at the goal");
        if (same(below.arrival, stair)) problems.push(`a stair where floor ${stair.level} starts`);
    }
    return problems;
}

/** How many layouts are kept: a race, its preview and a few run ids. */
const PLANS_KEPT = 16;
const plans = new Map<string, Plan>();

function planned(
    options: Pick<EventOptions<"nether-maze">, "size" | "hazards">,
    seed: string,
    design: number
): Plan {
    const cached = `${design}:${options.size}:${options.hazards}:${seed}`;
    const kept = plans.get(cached);
    if (kept) return kept;
    const made = plan(options, seed, design);
    plans.set(cached, made);
    if (plans.size > PLANS_KEPT) plans.delete(plans.keys().next().value!);
    return made;
}

// ------------------------------------------------------------------ the blocks

export interface Maze {
    readonly plan: Plan;
    /** The ground floor's height: a player stands a block over it. */
    readonly floor: number;
    /** The top floor's, where the goal is: the ground floor's in a maze of one. */
    readonly goalFloor: number;
    /** What is built, in order, floor by floor: under the floor, the floor,
     *  the walls, the hazards on it, the door, the roof and its lights; then
     *  the stairs and the jets' flames. */
    readonly boxes: readonly Box[];
    /** The glass door, taken out at "Go!". */
    readonly door: Box;
    /** The middle room of the top floor, in world blocks. */
    readonly goal: {
        readonly x1: number;
        readonly z1: number;
        readonly x2: number;
        readonly z2: number;
    };
    /** The middle of the starting room, facing the door. */
    readonly spawn: Spot;
    /** Where whoever is sent back on each floor over the ground one is put:
     *  the top of the stair up to it, facing out of its room. */
    readonly landings: readonly Spot[];
    /** The blocks the doorway jets flare in, in world blocks. */
    readonly jets: readonly { readonly x: number; readonly y: number; readonly z: number }[];
    /** The maze's own (0, 0) in world blocks. */
    readonly origin: { readonly x: number; readonly z: number };
    readonly volume: Volume;
    readonly reach: number;
}

/**
 * The blocks right round the goal, side by side with it: the open ones are
 * its threshold - the way in, crossed to finish - and the wall ones the face
 * of the wall inside it. Never a hazard: the goal and the doorways into it
 * are spared (`plan`).
 */
export function boothOf(
    tiles: ReadonlyMap<string, Tile>,
    goal: ReadonlySet<string>
): { threshold: Set<string>; faces: Set<string> } {
    const threshold = new Set<string>();
    const faces = new Set<string>();
    for (const at of goal) {
        const [x, z] = at.split(",").map(Number) as [number, number];
        for (const [dx, dz] of SIDES) {
            const near = key(x + dx, z + dz);
            if (goal.has(near)) continue;
            const tile = tiles.get(near);
            if (tile === "wall") faces.add(near);
            else if (tile === "floor") threshold.add(near);
        }
    }
    return { threshold, faces };
}

function yawOf(dx: number, dz: number): number {
    return Math.round((Math.atan2(-dx, dz) * 180) / Math.PI);
}

/**
 * The maze over a site: its middle over the column, its ground floor at `y`
 * and every floor over it `LEVEL_PITCH` higher. The same run gives the same
 * maze wherever it is put.
 */
export function maze(
    options: Pick<EventOptions<"nether-maze">, "size" | "hazards">,
    seed: string,
    site: { x: number; z: number },
    y: number,
    design = DESIGN
): Maze {
    const made = planned(options, seed, design);
    const side = made.cells * PITCH + WALL;
    const dx = site.x - Math.floor(side / 2);
    const dz = site.z - Math.floor(side / 2);
    const world = <T extends { x1: number; z1: number; x2: number; z2: number }>(box: T): T => ({
        ...box,
        x1: box.x1 + dx,
        x2: box.x2 + dx,
        z1: box.z1 + dz,
        z2: box.z2 + dz
    });
    const middle = (made.cells - 1) / 2;
    const top = made.levels.length - 1;
    const floorOf = (level: number) => y + level * LEVEL_PITCH;
    // What the stairs take over, by `x,h,z` (the maze's own x and z, the
    // world's height): a step's block, or the air kept over a step - a floor,
    // roof or rock layer is never built there.
    const carved = new Map<string, "step" | "air">();
    const stairBoxes: Box[] = [];
    const column = (x: number, z: number, y1: number, y2: number, block: Box["block"]) =>
        world({ x1: x, z1: z, x2: x, z2: z, y1, y2, block });
    for (const stair of made.stairs) {
        const base = floorOf(stair.level);
        stepsOf(stair).forEach(([x, z], step) => {
            if (step === 0) return;
            for (let h = 1; h <= step; h += 1) carved.set(`${x},${base + h},${z}`, "step");
            for (let h = step + 1; h <= step + STEP_CLEAR; h += 1)
                carved.set(`${x},${base + h},${z}`, "air");
            stairBoxes.push(column(x, z, base + 1, base + step, STAIR));
        });
        // The post the steps wind round, a light at the top of it.
        const px = roomStart(stair.cx) + 1;
        const pz = roomStart(stair.cz) + 1;
        for (let h = 1; h <= HEADROOM; h += 1) carved.set(`${px},${base + h},${pz}`, "step");
        stairBoxes.push(
            column(px, pz, base + 1, base + HEADROOM - 1, STAIR),
            column(px, pz, base + HEADROOM, base + HEADROOM, LIGHT)
        );
    }
    /** Cells of one layer the stairs leave alone. */
    const cut = (cells: ReadonlySet<string>, h: number) =>
        new Set(
            [...cells].filter((at) => {
                const [x, z] = at.split(",");
                return !carved.has(`${x},${h},${z}`);
            })
        );
    const layer = (
        cells: ReadonlySet<string>,
        y1: number,
        y2: number,
        block: Box["block"]
    ): Box[] =>
        rectangles(y1 === y2 ? cut(cells, y1) : cells).map((one) =>
            world({ ...one, y1, y2, block })
        );
    let door: Box | null = null;
    const all = new Set(made.tiles.keys());
    const startRoom = [...made.tiles].filter(([, tile]) => tile === "start").map(([at]) => at);
    const startXs = startRoom.map((at) => Number(at.split(",")[0]));
    const startZs = startRoom.map((at) => Number(at.split(",")[1]));
    const jets: { x: number; y: number; z: number }[] = [];
    const floors: Box[] = made.levels.flatMap((level, index) => {
        const tiles = level.tiles;
        const at = floorOf(index);
        const where = (wanted: (tile: Tile, at: string) => boolean) =>
            new Set([...tiles].filter(([spot, tile]) => wanted(tile, spot)).map(([spot]) => spot));
        const every = where(() => true);
        const ceiling = at + HEADROOM + 1;
        // A light in the roof over the middle of every other room, and the goal.
        const lights = new Set<string>();
        for (let cz = 0; cz < made.cells; cz += 1)
            for (let cx = 0; cx < made.cells; cx += 1)
                if ((cx % 2 === 0 && cz % 2 === 0) || (cx === middle && cz === middle))
                    lights.add(key(roomStart(cx) + 1, roomStart(cz) + 1));
        if (index === 0) lights.add(key(Math.min(...startXs) + 1, Math.min(...startZs) + 1));
        const goalHere = where((tile) => tile === "goal");
        // The finish booth (`FINISH_SINCE`): the blocks right round the goal,
        // the way in (its threshold) and the wall's face inside.
        const booth = design >= FINISH_SINCE ? boothOf(tiles, goalHere) : null;
        const threshold = booth?.threshold ?? new Set<string>();
        const faces = booth?.faces ?? new Set<string>();
        const roof = new Set(
            [...every].filter(
                (spot) => !lights.has(spot) && !goalHere.has(spot) && !threshold.has(spot)
            )
        );
        for (const spot of goalHere) lights.delete(spot);
        const doorTiles = where((tile) => tile === "door");
        const doorHere =
            doorTiles.size > 0 ? layer(doorTiles, at + 1, at + HEADROOM, DOOR)[0]! : null;
        door ??= doorHere;
        /** One block of a chequer: dark or light by where it is. */
        const square = (spot: string, h: number, light: Box["block"]): Box => {
            const [x, z] = spot.split(",").map(Number) as [number, number];
            const block = (((x + z + h) % 2) + 2) % 2 === 0 ? DARK : light;
            return world({ x1: x, z1: z, x2: x, z2: z, y1: h, y2: h, block });
        };
        const finish: Box[] =
            booth && goalHere.size > 0
                ? [
                      ...[...goalHere].map((spot) => square(spot, at, GOAL)),
                      ...[...threshold].map((spot) => square(spot, at, LIGHT_SQUARE)),
                      ...[...faces].flatMap((spot) =>
                          Array.from({ length: HEADROOM }, (_, step) =>
                              square(spot, at + 1 + step, LIGHT_SQUARE)
                          )
                      ),
                      ...layer(threshold, ceiling, ceiling, GOAL_LIGHT)
                  ]
                : [];
        for (const spot of where((tile) => tile === "jet")) {
            const [x, z] = spot.split(",").map(Number) as [number, number];
            jets.push({ x: x + dx, y: at + 1, z: z + dz });
        }
        return [
            ...layer(all, at - 1, at - 1, NETHERRACK),
            ...layer(
                where(
                    (tile, spot) =>
                        (tile === "wall" ||
                            tile === "floor" ||
                            tile === "fire" ||
                            tile === "door" ||
                            tile === "jet") &&
                        !threshold.has(spot)
                ),
                at,
                at,
                NETHERRACK
            ),
            ...layer(
                where((tile) => tile === "start"),
                at,
                at,
                START
            ),
            ...(booth ? [] : layer(goalHere, at, at, GOAL)),
            ...layer(
                where((tile) => tile === "magma"),
                at,
                at,
                MAGMA
            ),
            ...layer(
                where((tile) => tile === "soul"),
                at,
                at,
                SOUL
            ),
            ...layer(
                where((tile) => tile === "lava"),
                at,
                at,
                LAVA
            ),
            ...layer(
                where((tile, spot) => tile === "wall" && !faces.has(spot)),
                at + 1,
                at + HEADROOM,
                NETHERRACK
            ),
            ...layer(
                where((tile) => tile === "fire"),
                at + 1,
                at + 1,
                FIRE
            ),
            ...(doorHere ? [doorHere] : []),
            ...layer(roof, ceiling, ceiling, NETHERRACK),
            ...layer(lights, ceiling, ceiling, LIGHT),
            ...layer(goalHere, ceiling, ceiling, GOAL_LIGHT),
            ...finish,
            // A jet's flame, there from the start: what takes it away at the
            // end knows where it was.
            ...layer(
                where((tile) => tile === "jet"),
                at + 1,
                at + 1,
                FIRE
            )
        ];
    });
    const boxes = [...floors, ...stairBoxes];
    const xs = [...all].map((spot) => Number(spot.split(",")[0]));
    const zs = [...all].map((spot) => Number(spot.split(",")[1]));
    const low = { x: Math.min(...xs), z: Math.min(...zs) };
    const high = { x: Math.max(...xs), z: Math.max(...zs) };
    const goalX = roomStart(middle);
    return {
        plan: made,
        floor: y,
        goalFloor: floorOf(top),
        boxes,
        door: door!,
        goal: world({ x1: goalX, z1: goalX, x2: goalX + CORRIDOR - 1, z2: goalX + CORRIDOR - 1 }),
        spawn: {
            x: Math.min(...startXs) + 1 + dx + 0.5,
            y: y + 1,
            z: Math.min(...startZs) + 1 + dz + 0.5,
            yaw: yawOf(-made.entry.dx, -made.entry.dz)
        },
        landings: made.stairs.map((stair) => {
            const [x, z] = stepsOf(stair)[0]!;
            return {
                x: x + dx + 0.5,
                y: floorOf(stair.level + 1) + 1,
                z: z + dz + 0.5,
                yaw: yawOf(stair.dx, stair.dz)
            };
        }),
        jets,
        origin: { x: dx, z: dz },
        volume: {
            x1: low.x + dx,
            y1: y - 1,
            z1: low.z + dz,
            x2: high.x + dx,
            y2: floorOf(top) + HEADROOM + 1,
            z2: high.z + dz
        },
        reach: Math.ceil(Math.hypot(high.x - low.x, high.z - low.z) / 2) + 1
    };
}

/** Where each of `count` racers waits for "Go!": spread over the starting room. */
export function spots(built: Maze, count: number): Spot[] {
    const offsets = [
        [0, 0],
        [-1, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0]
    ] as const;
    return Array.from({ length: count }, (_, index) => {
        const [ox, oz] = offsets[index % offsets.length]!;
        return { ...built.spawn, x: built.spawn.x + ox, z: built.spawn.z + oz };
    });
}

/** In the starting room, standing: where a racer waits for "Go!". */
export function inStart(built: Maze, at: { x: number; y: number; z: number }): boolean {
    return (
        at.y >= built.floor + 0.5 &&
        at.y <= built.floor + 3 &&
        Math.abs(at.x - built.spawn.x) <= 2 &&
        Math.abs(at.z - built.spawn.z) <= 2
    );
}

/** The floor somebody at height `y` is on - on a stair, the one it climbs
 *  from - or the ground floor when the height is not known. */
export function levelAt(built: Maze, y?: number): number {
    if (y === undefined) return 0;
    const level = Math.floor((Math.floor(y + 0.5) - 1 - built.floor) / LEVEL_PITCH);
    return Math.min(Math.max(level, 0), built.plan.levels.length - 1);
}

const routes = new WeakMap<Plan, { far: number[][]; rest: number[] }>();

/** Each floor's rooms to its way up, and the rooms from each floor's way up
 *  to the goal: a run's plan never changes, so worked out once. */
function routeOf(made: Plan): { far: number[][]; rest: number[] } {
    const known = routes.get(made);
    if (known) return known;
    const far = made.levels.map((floor) => distances(floor.maze, floor.exit));
    const rest = new Array<number>(made.levels.length).fill(0);
    for (let level = made.levels.length - 2; level >= 0; level -= 1) {
        const floor = made.levels[level + 1]!;
        const across = far[level + 1]![floor.arrival.cz * made.cells + floor.arrival.cx]!;
        rest[level] = rest[level + 1]! + 1 + Math.max(0, across);
    }
    const route = { far, rest };
    routes.set(made, route);
    return route;
}

/** Rooms still to go from a room of a floor to the goal: to the floor's way
 *  up, a room for each stair, and every floor over it from stair to stair. */
function toGo(made: Plan, level: number, room: Room): number | null {
    const route = routeOf(made);
    const here = route.far[level]![room.cz * made.cells + room.cx]!;
    if (here < 0) return null;
    return here + route.rest[level]!;
}

/**
 * How many rooms closer to the goal a racer standing at `at` is than the
 * door's room: their progress, for whoever has not finished. Null outside the
 * rooms - a doorway, the starting room.
 */
export function progressAt(built: Maze, at: { x: number; y?: number; z: number }): number | null {
    const x = Math.floor(at.x) - built.origin.x;
    const z = Math.floor(at.z) - built.origin.z;
    const room = roomOf(x, z, built.plan.cells);
    if (!room) return null;
    const left = toGo(built.plan, levelAt(built, at.y), room);
    if (left === null) return null;
    return Math.max(0, roomsToGo(built) - left);
}

/** Rooms from the door's room to the goal: progress at the finish. */
export function roomsToGo(built: Maze): number {
    const entry = built.plan.entry;
    return toGo(built.plan, 0, { cx: entry.x, cz: entry.z }) ?? 0;
}

/** Whether boxes are a nether maze's: it is the only thing built of netherrack. */
export function isMaze(boxes: readonly Pick<Box, "block">[]): boolean {
    return boxes.some((one) => one.block === NETHERRACK);
}

/** The door taken away at "Go!" - only where it is still its glass. */
export function doorGone(built: Maze): string {
    const door = built.door;
    return `execute in minecraft:overworld run fill ${door.x1} ${door.y1} ${door.z1} ${door.x2} ${door.y2} ${door.z2} minecraft:air replace ${door.block}`;
}

// ------------------------------------------------------------------ in the game

/** Each racer's finish tick (0 while racing) and a count of times sent back. */
export const FINISH_SCORE = "pe_mfin";
export const BACK_SCORE = "pe_mback";
/** The pack's own switch and boxes. At most 16 characters. */
export const OBJECTIVE = "polaris_maze";
const SCALE = 64;
/** The stand in the starting room the burned are sent back to. */
export const START_TAG = "polaris_maze_start";
/** The stand at the top of the stair up to each floor over the ground one: the
 *  burned on that floor are sent back to it, not all the way down. */
export const LANDING_TAG = "polaris_maze_up";
const upTag = (level: number) => `${LANDING_TAG}${level}`;
/** The stands in the doorways whose jets flare. */
export const JET_TAG = "polaris_maze_jet";
/** A jet's beat, in ticks: alight for the first half, out for the second, and
 *  sparking for `JET_WARNING` before it lights again. */
export const JET_PERIOD = 60;
export const JET_WARNING = 15;
/** Higher than anybody ever stands: the height of a floor a maze does not have. */
const NOWHERE = 2_147_483_647;

/**
 * The racers' own team: nobody's name over their head in the maze
 * (`nametagVisibility never`), so nobody is found or followed through a wall
 * by it, no pushing in a corridor (`collisionRule never`) and no hitting each
 * other (`friendlyFire false`) - the maze is the danger. Made with the
 * scores and gone with them; taking the team away takes everybody off it.
 */
export const RACERS_TEAM = "pe_maze";

export const SCORES_ADDED = [
    ...[FINISH_SCORE, BACK_SCORE, OBJECTIVE].map(
        (name) => `scoreboard objectives add ${name} dummy`
    ),
    `team add ${RACERS_TEAM}`,
    `team modify ${RACERS_TEAM} nametagVisibility never`,
    `team modify ${RACERS_TEAM} collisionRule never`,
    `team modify ${RACERS_TEAM} friendlyFire false`
];
export const SCORES_REMOVED = [
    ...[FINISH_SCORE, BACK_SCORE].map((name) => `scoreboard objectives remove ${name}`),
    `team remove ${RACERS_TEAM}`
];

/** A racer coming in: not finished, never sent back, and on the racers' team -
 *  only if they are on none of the server's own, whose colour and prefix are
 *  theirs to keep. */
export function racerScores(name: string): string[] {
    return [
        `scoreboard players set ${name} ${FINISH_SCORE} 0`,
        `scoreboard players set ${name} ${BACK_SCORE} 0`,
        `execute if entity @a[name=${name},team=] run team join ${RACERS_TEAM} ${name}`
    ];
}

/** Off the racers' team, for one going home while the race goes on. */
export function leaveTeam(name: string): string {
    return `execute if entity @a[name=${name},team=${RACERS_TEAM}] run team leave ${name}`;
}

function score(name: string): string {
    return `#${name} ${OBJECTIVE}`;
}

function within(box: string): string {
    return ["x", "y", "z"]
        .map(
            (axis) =>
                `if score ${score(`p${axis}`)} >= ${score(`${box}${axis}1`)} if score ${score(`p${axis}`)} <= ${score(`${box}${axis}2`)}`
        )
        .join(" ");
}

/**
 * The functions, by name under `polaris:maze/`. Every tick, for every racer
 * still racing inside the maze: in fire or lava, or standing on magma, they
 * are sent back to the starting room's stand; in the middle room, their finish
 * is noted to the tick.
 */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [
        `execute if score ${score("on")} matches 1 in minecraft:overworld as @a[tag=pe_in,scores={${FINISH_SCORE}=0},distance=0..] run function polaris:maze/racer`,
        `execute if score ${score("on")} matches 1 if entity @e[type=minecraft:armor_stand,tag=${JET_TAG},limit=1] run function polaris:maze/jets`
    ],
    // The jets' beat, from the game's own clock: alight, out, sparks before
    // lighting again - a fire lit only where nothing stands in the way.
    jets: [
        `execute store result score ${score("t")} run time query gametime`,
        `scoreboard players operation ${score("t")} %= ${score("jp")}`,
        `execute if score ${score("t")} matches 0 as @e[type=minecraft:armor_stand,tag=${JET_TAG}] at @s run setblock ~ ~ ~ ${FIRE} keep`,
        `execute if score ${score("t")} matches ${JET_PERIOD / 2} as @e[type=minecraft:armor_stand,tag=${JET_TAG}] at @s if block ~ ~ ~ ${FIRE} run setblock ~ ~ ~ minecraft:air`,
        `execute if score ${score("t")} matches ${JET_PERIOD - JET_WARNING}..${JET_PERIOD - 1} as @e[type=minecraft:armor_stand,tag=${JET_TAG}] at @s run particle minecraft:flame ~ ~0.1 ~ 0.3 0 0.3 0.01 2`
    ],
    racer: [
        ...["x", "y", "z"].map(
            (axis, index) =>
                `execute store result score ${score(`p${axis}`)} run data get entity @s Pos[${index}] ${SCALE}`
        ),
        `execute ${within("s")} at @s if block ~ ~ ~ ${FIRE} run function polaris:maze/back`,
        `execute ${within("s")} at @s if block ~ ~ ~ ${LAVA} run function polaris:maze/back`,
        `execute ${within("s")} at @s if block ~ ~-0.5 ~ ${MAGMA} run function polaris:maze/back`,
        `execute ${within("g")} run function polaris:maze/done`
    ],
    // Back to the start - or, on a floor over the ground one, to the top of
    // the stair up to it.
    back: [
        `tp @s @e[type=minecraft:armor_stand,tag=${START_TAG},limit=1]`,
        ...Array.from(
            { length: MOST_LEVELS - 1 },
            (_, index) =>
                `execute if score ${score("py")} >= ${score(`up${index + 1}`)} run tp @s @e[type=minecraft:armor_stand,tag=${upTag(index + 1)},limit=1]`
        ),
        `scoreboard players add @s ${BACK_SCORE} 1`,
        "playsound minecraft:entity.generic.burn master @s ~ ~ ~ 1 1"
    ],
    done: [
        `execute store result score @s ${FINISH_SCORE} run time query gametime`,
        "playsound minecraft:ui.toast.challenge_complete master @s ~ ~ ~ 1 1"
    ]
};

/**
 * Switched on for one maze, at "Go!": the maze (`s`) and its middle room (`g`)
 * in 64ths, a fresh stand in the starting room to send the burned to, and the
 * switch last, so the pack never runs against half a box.
 */
export function armLines(built: Maze): string[] {
    const from = (block: number) => block * SCALE;
    const to = (block: number) => (block + 1) * SCALE - 1;
    const set = (name: string, value: number) => `scoreboard players set ${score(name)} ${value}`;
    const v = built.volume;
    const g = built.goal;
    const stand = (spot: Spot, tag: string) =>
        `execute in minecraft:overworld run summon minecraft:armor_stand ${spot.x} ${spot.y} ${spot.z} {Tags:["${tag}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b,Rotation:[${spot.yaw.toFixed(1)}f,0f]}`;
    const tags = [
        START_TAG,
        JET_TAG,
        ...Array.from({ length: MOST_LEVELS - 1 }, (_, index) => upTag(index + 1))
    ];
    return [
        ...SCORES_ADDED,
        set("on", 0),
        set("sx1", from(v.x1)),
        set("sx2", to(v.x2)),
        set("sy1", from(v.y1)),
        set("sy2", to(v.y2)),
        set("sz1", from(v.z1)),
        set("sz2", to(v.z2)),
        set("gx1", from(g.x1)),
        set("gx2", to(g.x2)),
        set("gy1", from(built.goalFloor + 1) - SCALE / 4),
        set("gy2", to(built.goalFloor + 2)),
        set("gz1", from(g.z1)),
        set("gz2", to(g.z2)),
        // From the height a floor is stood on, the burned go back to its landing.
        ...Array.from({ length: MOST_LEVELS - 1 }, (_, index) => {
            const landing = built.landings[index];
            return set(`up${index + 1}`, landing ? from(landing.y) - SCALE / 4 : NOWHERE);
        }),
        set("jp", JET_PERIOD),
        ...tags.map((tag) => `kill @e[type=minecraft:armor_stand,tag=${tag}]`),
        stand(built.spawn, START_TAG),
        ...built.landings.map((landing, index) => stand(landing, upTag(index + 1))),
        ...built.jets.map((jet) =>
            stand({ x: jet.x + 0.5, y: jet.y, z: jet.z + 0.5, yaw: 0 }, JET_TAG)
        ),
        set("on", 1)
    ];
}

/**
 * Switched off, its stands taken away - only while the switch is still this
 * maze's (`boxes` holds its netherrack), so ending an old maze never stops a
 * newer one. Safe when it was never on.
 */
export function stopLines(boxes: readonly Pick<Box, "x1" | "y1" | "z1" | "block">[]): string[] {
    const rock = boxes.filter((one) => one.block === NETHERRACK);
    if (rock.length === 0) return [];
    const x = Math.min(...rock.map((one) => one.x1));
    const z = Math.min(...rock.map((one) => one.z1));
    const ours = `if score ${score("sx1")} matches ${x * SCALE} if score ${score("sz1")} matches ${z * SCALE}`;
    const tags = [
        JET_TAG,
        ...Array.from({ length: MOST_LEVELS - 1 }, (_, index) => upTag(index + 1))
    ];
    return [
        `execute ${ours} run kill @e[type=minecraft:armor_stand,tag=${START_TAG}]`,
        ...tags.map((tag) => `execute ${ours} run kill @e[type=minecraft:armor_stand,tag=${tag}]`),
        `execute ${ours} run scoreboard players set ${score("on")} 0`
    ];
}

export const READ_FINISHED = `execute as @a[tag=pe_in,scores={${FINISH_SCORE}=1..}] run scoreboard players get @s ${FINISH_SCORE}`;

/** Whoever the pack sent back since the last look: told `json`, once. */
export function backLines(json: string): string[] {
    const selector = `@a[tag=pe_in,scores={${BACK_SCORE}=1..}]`;
    return [
        `execute as ${selector} run tellraw @s ${json}`,
        `scoreboard players set ${selector} ${BACK_SCORE} 0`
    ];
}

/** Fire never burns anybody inside for long: whoever was sent out of it is
 *  given Fire Resistance with the rest of the tick's protection. */
export const COOL_INSIDE = "effect give @a[tag=pe_in] minecraft:fire_resistance 10 0 true";
