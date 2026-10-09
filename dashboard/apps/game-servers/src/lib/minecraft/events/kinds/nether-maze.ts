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

/** How mazes are laid out now, written onto the stage when one is built. */
export const DESIGN = 1;

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

/** What stands on one column of the maze. */
export type Tile = "wall" | "floor" | "magma" | "fire" | "lava" | "goal" | "start" | "door";

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
    /** How many hazards it was given. */
    readonly hazards: number;
}

/** The first block of a room along one axis. */
export const roomStart = (cell: number) => WALL + cell * PITCH;

/** Rooms on the way from every room to the middle one, through open walls. */
export function distances(maze: seekMaze.Maze): number[] {
    const cells = maze.cells;
    const middle = (cells - 1) / 2;
    const far = new Array<number>(cells * cells).fill(-1);
    far[middle * cells + middle] = 0;
    const queue: [number, number][] = [[middle, middle]];
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

/** The tiles of a maze with no hazards yet: rooms, doorways, walls, the door
 *  and the starting room outside it. */
function plainTiles(maze: seekMaze.Maze, entry: Plan["entry"]): Map<string, Tile> {
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
            const room = cx === middle && cz === middle ? "goal" : "floor";
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

/**
 * The maze for a run: carved from its id, the door on the edge furthest from
 * the middle, then hazards placed one at a time - any that would cut a room
 * off is left out - until about `DENSITY` of the rooms have one.
 */
export function plan(
    options: Pick<EventOptions<"nether-maze">, "size" | "hazards">,
    seed: string,
    design = DESIGN
): Plan {
    const cells = CELLS[options.size];
    const random = seeded(`nether-maze-${design}-${seed}`);
    const maze = seekMaze.carve(cells, random, LOOPS);
    const entry = entryOf(maze, random);
    const tiles = plainTiles(maze, entry);
    const grid = gridOf(tiles);
    const middle = (cells - 1) / 2;
    // Rooms that never get a hazard: the goal, the room the door opens into,
    // and the rooms beside it.
    const spared = new Set<string>([key(middle, middle), key(entry.x, entry.z)]);
    for (const [dx, dz] of SIDES) spared.add(key(entry.x + dx, entry.z + dz));
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
        // A doorway east or south with a pit across it, or a patch in the room.
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
            // The first block of the doorway, across all of it: one to jump.
            for (let across = 0; across < CORRIDOR; across += 1)
                change.set(
                    dx === 1 ? key(x0 + CORRIDOR, z0 + across) : key(x0 + across, z0 + CORRIDOR),
                    "lava"
                );
        } else {
            const pattern = ROOM_PATTERNS[Math.floor(random() * ROOM_PATTERNS.length)]!;
            const kind: Tile = random() < 0.5 ? "fire" : "magma";
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
    return { design, cells, maze, entry, tiles, hazards: placed };
}

/** Whether a player can stand on a tile without being sent back. */
function safe(tile: Tile | undefined): boolean {
    return tile === "floor" || tile === "goal" || tile === "start" || tile === "door";
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
    fire: 3,
    magma: 3,
    lava: 4
};

function gridOf(tiles: ReadonlyMap<string, Tile>): Grid {
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
        if (tile === "start" && start === -1) start = (z - z0) * width + (x - x0);
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
 * The safe blocks no walk from the starting room reaches - nothing in a fair
 * maze. A walk steps onto a side's safe block, or jumps one block of lava in a
 * straight line onto a safe block beyond it.
 */
export function unreached(tiles: ReadonlyMap<string, Tile>): string[] {
    const grid = gridOf(tiles);
    if (grid.start < 0) return ["no starting room"];
    const { count, first } = lostOn(grid);
    if (count === 0) return [];
    const at = key((first % grid.width) + grid.x0, Math.floor(first / grid.width) + grid.z0);
    return Array.from({ length: count }, (_, index) => (index === 0 ? at : "more"));
}

/**
 * What is wrong with a plan, as sentences: nothing when it keeps every rule.
 * Worked out from the tiles, not from how they were placed.
 */
export function mazeProblems(maze: Plan): string[] {
    const problems: string[] = [];
    const { tiles, cells } = maze;
    const lost = unreached(tiles);
    if (lost.length > 0) problems.push(`${lost.length} safe blocks cut off, first ${lost[0]}`);
    const goal = [...tiles].filter(([, tile]) => tile === "goal");
    if (goal.length !== CORRIDOR * CORRIDOR) problems.push(`a goal of ${goal.length} blocks`);
    // Every wall at least two thick: between two open blocks along a line,
    // or between one and the outside, never a single block of wall.
    for (const [at, tile] of tiles) {
        if (tile === "wall") continue;
        const [x, z] = at.split(",").map(Number) as [number, number];
        for (const [dx, dz] of SIDES) {
            if (tiles.get(key(x + dx, z + dz)) !== "wall") continue;
            const after = tiles.get(key(x + 2 * dx, z + 2 * dz));
            if (after !== "wall") problems.push(`a wall one block thick at ${at}`);
        }
    }
    // Hazards: never where the race starts or ends, nor next to the start,
    // and lava only ever one block across, in a doorway.
    const middle = (cells - 1) / 2;
    for (const [at, tile] of tiles) {
        if (tile !== "fire" && tile !== "magma" && tile !== "lava") continue;
        const [x, z] = at.split(",").map(Number) as [number, number];
        const room = roomOf(x, z, cells);
        if (!room) {
            problems.push(`a hazard outside the rooms at ${at}`);
            continue;
        }
        if (room.cx === middle && room.cz === middle) problems.push(`a hazard at the goal ${at}`);
        if (Math.abs(room.cx - maze.entry.x) + Math.abs(room.cz - maze.entry.z) <= 1)
            problems.push(`a hazard by the start at ${at}`);
        // One block across, along a line with safe ground on both sides of it.
        if (
            tile === "lava" &&
            !(safe(tiles.get(key(x - 1, z))) && safe(tiles.get(key(x + 1, z)))) &&
            !(safe(tiles.get(key(x, z - 1))) && safe(tiles.get(key(x, z + 1))))
        )
            problems.push(`lava more than one block across at ${at}`);
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
    /** The floor's height: a player stands a block over it. */
    readonly floor: number;
    /** What is built, in order: under the floor, the floor, the walls, the
     *  hazards on it, the door, the roof and its lights. */
    readonly boxes: readonly Box[];
    /** The glass door, taken out at "Go!". */
    readonly door: Box;
    /** The middle room, in world blocks. */
    readonly goal: {
        readonly x1: number;
        readonly z1: number;
        readonly x2: number;
        readonly z2: number;
    };
    /** The middle of the starting room, facing the door. */
    readonly spawn: Spot;
    /** The maze's own (0, 0) in world blocks. */
    readonly origin: { readonly x: number; readonly z: number };
    readonly volume: Volume;
    readonly reach: number;
}

function yawOf(dx: number, dz: number): number {
    return Math.round((Math.atan2(-dx, dz) * 180) / Math.PI);
}

/**
 * The maze over a site: its middle over the column, its floor at `y`. The same
 * run gives the same maze wherever it is put.
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
    const where = (wanted: (tile: Tile) => boolean) =>
        new Set([...made.tiles].filter(([, tile]) => wanted(tile)).map(([at]) => at));
    const layer = (
        cells: ReadonlySet<string>,
        y1: number,
        y2: number,
        block: Box["block"]
    ): Box[] => rectangles(cells).map((one) => world({ ...one, y1, y2, block }));
    const all = where(() => true);
    const ceiling = y + HEADROOM + 1;
    // A light in the roof over the middle of every other room, and the goal.
    const lights = new Set<string>();
    const middle = (made.cells - 1) / 2;
    for (let cz = 0; cz < made.cells; cz += 1)
        for (let cx = 0; cx < made.cells; cx += 1)
            if ((cx % 2 === 0 && cz % 2 === 0) || (cx === middle && cz === middle))
                lights.add(key(roomStart(cx) + 1, roomStart(cz) + 1));
    const startRoom = where((tile) => tile === "start");
    const startXs = [...startRoom].map((at) => Number(at.split(",")[0]));
    const startZs = [...startRoom].map((at) => Number(at.split(",")[1]));
    lights.add(key(Math.min(...startXs) + 1, Math.min(...startZs) + 1));
    const goalTiles = where((tile) => tile === "goal");
    const roof = new Set([...all].filter((at) => !lights.has(at) && !goalTiles.has(at)));
    for (const at of goalTiles) lights.delete(at);
    const doorTiles = where((tile) => tile === "door");
    const door = layer(doorTiles, y + 1, y + HEADROOM, DOOR)[0]!;
    const boxes: Box[] = [
        ...layer(all, y - 1, y - 1, NETHERRACK),
        ...layer(
            where(
                (tile) => tile === "wall" || tile === "floor" || tile === "fire" || tile === "door"
            ),
            y,
            y,
            NETHERRACK
        ),
        ...layer(
            where((tile) => tile === "start"),
            y,
            y,
            START
        ),
        ...layer(goalTiles, y, y, GOAL),
        ...layer(
            where((tile) => tile === "magma"),
            y,
            y,
            MAGMA
        ),
        ...layer(
            where((tile) => tile === "lava"),
            y,
            y,
            LAVA
        ),
        ...layer(
            where((tile) => tile === "wall"),
            y + 1,
            y + HEADROOM,
            NETHERRACK
        ),
        ...layer(
            where((tile) => tile === "fire"),
            y + 1,
            y + 1,
            FIRE
        ),
        door,
        ...layer(roof, ceiling, ceiling, NETHERRACK),
        ...layer(lights, ceiling, ceiling, LIGHT),
        ...layer(goalTiles, ceiling, ceiling, GOAL_LIGHT)
    ];
    const xs = [...all].map((at) => Number(at.split(",")[0]));
    const zs = [...all].map((at) => Number(at.split(",")[1]));
    const low = { x: Math.min(...xs), z: Math.min(...zs) };
    const high = { x: Math.max(...xs), z: Math.max(...zs) };
    const goalX = roomStart(middle);
    return {
        plan: made,
        floor: y,
        boxes,
        door,
        goal: world({ x1: goalX, z1: goalX, x2: goalX + CORRIDOR - 1, z2: goalX + CORRIDOR - 1 }),
        spawn: {
            x: Math.min(...startXs) + 1 + dx + 0.5,
            y: y + 1,
            z: Math.min(...startZs) + 1 + dz + 0.5,
            yaw: yawOf(-made.entry.dx, -made.entry.dz)
        },
        origin: { x: dx, z: dz },
        volume: {
            x1: low.x + dx,
            y1: y - 1,
            z1: low.z + dz,
            x2: high.x + dx,
            y2: ceiling,
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

/**
 * How many rooms closer to the middle a racer standing at `at` is than the
 * door's room: their progress, for whoever has not finished. Null outside the
 * rooms - a doorway, the starting room.
 */
export function progressAt(built: Maze, at: { x: number; z: number }): number | null {
    const x = Math.floor(at.x) - built.origin.x;
    const z = Math.floor(at.z) - built.origin.z;
    const room = roomOf(x, z, built.plan.cells);
    if (!room) return null;
    const far = distances(built.plan.maze);
    const here = far[room.cz * built.plan.cells + room.cx]!;
    const from = far[built.plan.entry.z * built.plan.cells + built.plan.entry.x]!;
    return Math.max(0, from - here);
}

/** Rooms from the door's room to the middle: progress at the finish. */
export function roomsToGo(built: Maze): number {
    const far = distances(built.plan.maze);
    return far[built.plan.entry.z * built.plan.cells + built.plan.entry.x]!;
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

export const SCORES_ADDED = [FINISH_SCORE, BACK_SCORE, OBJECTIVE].map(
    (name) => `scoreboard objectives add ${name} dummy`
);
export const SCORES_REMOVED = [FINISH_SCORE, BACK_SCORE].map(
    (name) => `scoreboard objectives remove ${name}`
);

/** A racer coming in: not finished, never sent back. */
export function racerScores(name: string): string[] {
    return [
        `scoreboard players set ${name} ${FINISH_SCORE} 0`,
        `scoreboard players set ${name} ${BACK_SCORE} 0`
    ];
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
        `execute if score ${score("on")} matches 1 in minecraft:overworld as @a[tag=pe_in,scores={${FINISH_SCORE}=0},distance=0..] run function polaris:maze/racer`
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
    back: [
        `tp @s @e[type=minecraft:armor_stand,tag=${START_TAG},limit=1]`,
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
    const spawn = built.spawn;
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
        set("gy1", from(built.floor + 1) - SCALE / 4),
        set("gy2", to(built.floor + 2)),
        set("gz1", from(g.z1)),
        set("gz2", to(g.z2)),
        `kill @e[type=minecraft:armor_stand,tag=${START_TAG}]`,
        `execute in minecraft:overworld run summon minecraft:armor_stand ${spawn.x} ${spawn.y} ${spawn.z} {Tags:["${START_TAG}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b,Rotation:[${spawn.yaw.toFixed(1)}f,0f]}`,
        set("on", 1)
    ];
}

/**
 * Switched off, its stand taken away - only while the switch is still this
 * maze's (`boxes` holds its netherrack), so ending an old maze never stops a
 * newer one. Safe when it was never on.
 */
export function stopLines(boxes: readonly Pick<Box, "x1" | "y1" | "z1" | "block">[]): string[] {
    const rock = boxes.filter((one) => one.block === NETHERRACK);
    if (rock.length === 0) return [];
    const x = Math.min(...rock.map((one) => one.x1));
    const z = Math.min(...rock.map((one) => one.z1));
    const ours = `if score ${score("sx1")} matches ${x * SCALE} if score ${score("sz1")} matches ${z * SCALE}`;
    return [
        `execute ${ours} run kill @e[type=minecraft:armor_stand,tag=${START_TAG}]`,
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
