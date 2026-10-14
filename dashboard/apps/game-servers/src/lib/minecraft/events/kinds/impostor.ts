/**
 * Impostor: a station of rooms in the sky, a crew doing its tasks and one to
 * three impostors among them, unknown to the rest.
 *
 * The station is a grid of rooms three wide - three rows up to eight players,
 * four past - joined by a corridor to every room beside it, all of it walled
 * and roofed (`stationFills`). The middle room of the second row is the
 * meeting room: a table with the emergency button on it, and a seat round it
 * for everybody (`seatSpot`). Every other room has two task stations in its
 * corners - a switch to flip, a button to press or a plate to stand on - and
 * some have a vent, an iron trapdoor in the floor that takes an impostor to
 * the vent it is paired with (`layoutFor`). Laid out from the run's id and the
 * number of rows, so a restart lays out the same.
 *
 * From design 3 (`SHIP_SINCE`) the station is a ship instead
 * (`impostor-ship.ts`): a cafeteria with the emergency table, themed rooms
 * of their own sizes joined by long corridors and halls, each furnished by
 * hand for what it is, with its tasks where they make sense and a vent where
 * one can go. A run built on an older design keeps its own.
 *
 * Who is an impostor is drawn from the run's id among who was brought in, never
 * more than a third of them (`impostorsFor`); each crew member is given tasks
 * drawn the same way (`tasksFor`), an impostor a list of the same shape to
 * pretend with. Everybody is weakened past doing harm but an impostor whose
 * kill is ready, so a hit a crew member takes is an impostor's (`killerOf`):
 * they are dead, a body is left where they fell, and the impostor's kill waits
 * `killCooldown` again. A body reported - or the emergency button pressed -
 * calls everybody alive to the table to talk, then to vote; the most votes is
 * voted out, a tie or a skip votes out nobody (`tally`). The crew wins with
 * every task done or every impostor out, the impostors as soon as they are as
 * many as the crew, or when the time runs out on them still aboard
 * (`verdict`).
 *
 * Pure; the loop is `impostor-service.ts`.
 */

import { z } from "zod";
import * as hits from "./hits";
import type { Box } from "../state";
import { slices, type Spot } from "./arena";
import type { Fill } from "./arena-game";
import { asciiJson, customNameValue, text } from "../commands";
import { seeded, shuffled } from "../trivia-bank";
import * as decor from "./arena-decor";
import * as ship from "./impostor-ship";

/** How many can play: a seat each at the table. */
export const MOST = 15;
/** The fewest it is played by, whatever the event says: one impostor needs
 *  three crew round them for a vote to mean anything. */
export const FLOOR = 4;
/** Impostors at the most, and never more than one for every three players. */
export const MOST_IMPOSTORS = 3;
export const PER_IMPOSTOR = 3;

/** The station's layout version, written into the run as it is built: from 2
 *  (`FURNISHED_SINCE`) bigger rooms, a bridge looking out on space, a dark
 *  room, and every room furnished for what it is. */
export const DESIGN = 3;
export const FURNISHED_SINCE = 2;
/** From 3: the ship (`impostor-ship.ts`), past eight players with its engine
 *  wing. */
export const SHIP_SINCE = 3;

// ------------------------------------------------------------------ the station

/** How a design is measured, each length from a room's corner. */
interface Geometry {
    /** A room's side, walls included. */
    readonly room: number;
    /** The corridor between two rooms, wall to wall. */
    readonly gap: number;
    /** How high a wall stands over the floor; the roof is on top of it. */
    readonly wall: number;
    /** A corridor's two side walls, across the side of a room it goes through. */
    readonly door: readonly [number, number];
    /** A working room's two stations. */
    readonly stations: readonly (readonly [number, number])[];
    /** A vent, and where whoever comes out of it stands. */
    readonly vent: {
        readonly x: number;
        readonly z: number;
        readonly outX: number;
        readonly outZ: number;
    };
    /** The middle of the meeting room's table. */
    readonly table: number;
    /** How far out from the table the seats' ring is. */
    readonly seats: number;
    /** Where a room's ceiling has a light, across and along. */
    readonly lights: readonly number[];
}

const GEOMETRY_1: Geometry = {
    room: 11,
    gap: 4,
    wall: 4,
    door: [3, 7],
    stations: [
        [2, 2],
        [8, 8]
    ],
    vent: { x: 8, z: 2, outX: 7, outZ: 3 },
    table: 5,
    seats: 3,
    lights: [3, 7]
};
/** A 13 by 13 floor inside, a block higher, the stations clear of the
 *  bridge's window along the top of its room. */
const GEOMETRY_2: Geometry = {
    room: 15,
    gap: 5,
    wall: 5,
    door: [5, 9],
    stations: [
        [3, 11],
        [11, 11]
    ],
    vent: { x: 11, z: 3, outX: 10, outZ: 4 },
    table: 7,
    seats: 4,
    lights: [3, 7, 11]
};

/** How a design is measured: a run built on an older one keeps its own. */
function geometryOf(design: number): Geometry {
    return design >= FURNISHED_SINCE ? GEOMETRY_2 : GEOMETRY_1;
}

/** A room's side, walls included, as rooms are built now. */
export const ROOM = GEOMETRY_2.room;
export const COLS = 3;
/** The meeting room: the middle of the second row. */
const MEETING = { col: 1, row: 1 } as const;
/** The bridge, from `FURNISHED_SINCE`: the middle of the first row, its top
 *  side the station's edge. */
const BRIDGE = { col: 1, row: 0 } as const;
/** The bridge's rows given to space - the backdrop and the dark in front of
 *  it - before its window. */
const SPACE_ROWS = 2;

/** Rows of rooms for this many players. */
export function rowsFor(players: number): number {
    return players <= 8 ? 3 : 4;
}

function sizeOf(rows: number, design: number): { width: number; depth: number } {
    if (design >= SHIP_SINCE)
        return {
            width: shipCols(rows) * ship.PITCH,
            depth: ship.ROWS_FULL * ship.PITCH
        };
    const g = geometryOf(design);
    const pitch = g.room + g.gap;
    return { width: COLS * pitch - g.gap, depth: rows * pitch - g.gap };
}

/** How far from its center the ground under it is judged. */
export function reachOf(players: number, design = DESIGN): number {
    const { width, depth } = sizeOf(rowsFor(players), design);
    return Math.ceil(Math.max(width, depth) / 2) + 2;
}

/** The box the station takes: its floor at `floorY`, its roof on top. */
export function stationBox(
    center: { x: number; z: number },
    floorY: number,
    players: number,
    design = DESIGN
): Box {
    const g = geometryOf(design);
    const { width, depth } = sizeOf(rowsFor(players), design);
    const x1 = Math.round(center.x) - Math.floor(width / 2);
    const z1 = Math.round(center.z) - Math.floor(depth / 2);
    return { x1, y1: floorY, z1, x2: x1 + width - 1, y2: floorY + g.wall + 1, z2: z1 + depth - 1 };
}

/** The rows a built station has, from its box. */
export function rowsOf(box: Box, design = DESIGN): number {
    if (design >= SHIP_SINCE) return box.x2 - box.x1 + 1 >= ship.COLS_FULL * ship.PITCH ? 4 : 3;
    const g = geometryOf(design);
    return Math.round((box.z2 - box.z1 + 1 + g.gap) / (g.room + g.gap));
}

export const STATION_KINDS = ["switch", "button", "scan"] as const;
export type StationKind = (typeof STATION_KINDS)[number];

/** The rooms' names, each a key the messages give words to. */
export const ROOM_NAMES = [
    "engine",
    "greenhouse",
    "library",
    "kitchen",
    "workshop",
    "observatory",
    "cargo",
    "lab",
    "archive",
    "armory",
    "infirmary",
    "radio"
] as const;
export type RoomName = (typeof ROOM_NAMES)[number];
/** What any room is called: a working room's name, the meeting room or the
 *  bridge, or one of the ship's (`SHIP_SINCE`). */
export type PlaceName = RoomName | "meeting" | "bridge" | ship.ShipRoom;

export interface Room {
    readonly index: number;
    readonly col: number;
    readonly row: number;
    /** Its corner, walls included. */
    readonly x: number;
    readonly z: number;
    readonly name: PlaceName;
    readonly floor: string;
    /** Left unlit, its floor dark glass (`FURNISHED_SINCE`). */
    readonly dark?: boolean;
    /** Its size, walls included, where rooms differ (`SHIP_SINCE`). */
    readonly w?: number;
    readonly d?: number;
}

export interface Station {
    readonly id: number;
    readonly room: number;
    readonly kind: StationKind;
    /** The column it stands in; the plate, or the console under the switch or
     *  button, is on the floor, the switch or button on top of the console. */
    readonly x: number;
    readonly z: number;
}

export interface Vent {
    readonly room: number;
    readonly x: number;
    readonly z: number;
    /** The vent it leads to, by its place in `vents`. */
    readonly to: number;
    /** Where whoever comes out of it stands: beside it, not on it. */
    readonly outX: number;
    readonly outZ: number;
}

/** A piece of a room's furnishing, standing on its floor, `high` blocks tall. */
export interface Prop {
    readonly x: number;
    readonly z: number;
    readonly high: number;
    readonly block: string;
}

export interface Layout {
    readonly box: Box;
    readonly design: number;
    readonly rows: number;
    readonly rooms: readonly Room[];
    readonly meeting: Room;
    readonly stations: readonly Station[];
    readonly vents: readonly Vent[];
    /** What furnishes the rooms, from `FURNISHED_SINCE`. */
    readonly props: readonly Prop[];
    /** Where the bridge's sky has a star, by `dx,dy` along its backdrop. */
    readonly stars: ReadonlySet<string>;
    /** What furnishes the ship's rooms, as it is built (`SHIP_SINCE`). */
    readonly pieces: readonly Fill[];
}

const WALL_BLOCK = "minecraft:light_gray_concrete";
const CORRIDOR_FLOOR = "minecraft:gray_concrete";
const MEETING_FLOOR = "minecraft:polished_andesite";
const ROOF = "minecraft:quartz_block";
const LIGHT = "minecraft:sea_lantern";
const TABLE = "minecraft:dark_oak_planks";
const TABLE_MIDDLE = "minecraft:red_concrete";
const CONSOLE = "minecraft:polished_diorite";
const EMERGENCY = "minecraft:stone_button";
const SWITCH = "minecraft:lever";
const BUTTON = "minecraft:oak_button";
const PLATE = "minecraft:heavy_weighted_pressure_plate";
const VENT = "minecraft:iron_trapdoor";
/** The dark room's floor: dark, and nothing spawns on glass. */
const DARK_FLOOR = "minecraft:black_stained_glass";
const BRIDGE_FLOOR = "minecraft:polished_andesite";
/** Space past the bridge's window: black, a star here and there. */
const SPACE = "minecraft:black_concrete";
const WINDOW = "minecraft:glass";
/** A room's own floor, drawn for it. */
const ROOM_FLOORS = [
    "minecraft:white_concrete",
    "minecraft:light_blue_terracotta",
    "minecraft:cyan_terracotta",
    "minecraft:smooth_sandstone",
    "minecraft:polished_granite",
    "minecraft:birch_planks",
    "minecraft:spruce_planks",
    "minecraft:stone_bricks"
] as const;

/** How the switches, buttons and vents are written: one state each, so
 *  nothing is read back but what the game itself changes. */
export const SWITCH_OFF = `${SWITCH}[face=floor,facing=north,powered=false]`;
const SWITCH_ON = `${SWITCH}[powered=true]`;
const BUTTON_FLOOR = `${BUTTON}[face=floor,facing=north,powered=false]`;
const BUTTON_ON = `${BUTTON}[powered=true]`;
const EMERGENCY_FLOOR = `${EMERGENCY}[face=floor,facing=north,powered=false]`;
const EMERGENCY_ON = `${EMERGENCY}[powered=true]`;
const VENT_SHUT = `${VENT}[half=bottom,open=false,facing=north]`;

/** Furnishing that stands on the block under it: taken down before anything. */
const STANDING = [
    "minecraft:potted_red_tulip",
    "minecraft:potted_fern",
    "minecraft:potted_dandelion",
    "minecraft:potted_cactus",
    "minecraft:potted_white_tulip",
    "minecraft:skeleton_skull",
    "minecraft:wither_skeleton_skull",
    "minecraft:redstone_torch",
    "minecraft:end_rod",
    "minecraft:brewing_stand",
    "minecraft:daylight_detector"
] as const;

/**
 * What furnishes each room, from `FURNISHED_SINCE`: blocks every version from
 * 1.13 has, none that falls, flows, spreads, burns on its own, takes power or
 * moves anything. One is drawn for each spot; a `tall` one stands two high.
 */
const FURNISHING: Readonly<
    Record<RoomName | "bridge" | "dark", { tall: readonly string[]; low: readonly string[] }>
> = {
    engine: {
        tall: ["minecraft:iron_bars"],
        low: [
            "minecraft:furnace",
            "minecraft:iron_block",
            "minecraft:coal_block",
            "minecraft:cauldron"
        ]
    },
    greenhouse: {
        tall: ["minecraft:oak_leaves[persistent=true]", "minecraft:birch_leaves[persistent=true]"],
        low: [
            "minecraft:potted_red_tulip",
            "minecraft:potted_fern",
            "minecraft:potted_dandelion",
            "minecraft:hay_block"
        ]
    },
    library: {
        tall: ["minecraft:bookshelf"],
        low: ["minecraft:enchanting_table", "minecraft:crafting_table"]
    },
    kitchen: {
        tall: [],
        low: [
            "minecraft:furnace",
            "minecraft:cauldron",
            "minecraft:crafting_table",
            "minecraft:melon",
            "minecraft:pumpkin"
        ]
    },
    workshop: {
        tall: ["minecraft:iron_bars"],
        low: [
            "minecraft:crafting_table",
            "minecraft:iron_block",
            "minecraft:furnace",
            "minecraft:chiseled_stone_bricks"
        ]
    },
    observatory: {
        tall: ["minecraft:quartz_pillar", WINDOW],
        low: ["minecraft:end_rod", "minecraft:beacon"]
    },
    cargo: {
        tall: ["minecraft:oak_log"],
        low: ["minecraft:hay_block", "minecraft:coal_block", "minecraft:dried_kelp_block"]
    },
    lab: {
        tall: [WINDOW],
        low: [
            "minecraft:brewing_stand",
            "minecraft:cauldron",
            "minecraft:potted_cactus",
            "minecraft:purpur_block"
        ]
    },
    archive: {
        tall: ["minecraft:bookshelf"],
        low: ["minecraft:crafting_table", "minecraft:chiseled_stone_bricks"]
    },
    armory: {
        tall: ["minecraft:iron_bars"],
        low: ["minecraft:iron_block", "minecraft:chiseled_stone_bricks"]
    },
    infirmary: {
        tall: [],
        low: [
            "minecraft:white_wool",
            "minecraft:red_wool",
            "minecraft:cauldron",
            "minecraft:potted_white_tulip"
        ]
    },
    radio: {
        tall: [],
        low: [
            "minecraft:note_block",
            "minecraft:jukebox",
            "minecraft:redstone_lamp",
            "minecraft:daylight_detector"
        ]
    },
    bridge: {
        tall: [],
        low: ["minecraft:redstone_lamp", "minecraft:daylight_detector", CONSOLE]
    },
    // Nothing a mob spawns on: glass, bars, skulls and a dim red light.
    dark: {
        tall: [DARK_FLOOR, "minecraft:iron_bars"],
        low: [
            "minecraft:skeleton_skull",
            "minecraft:wither_skeleton_skull",
            "minecraft:redstone_torch"
        ]
    }
};
/** How many pieces furnish a room at the most. */
const PROPS_PER_ROOM = 10;
const bareId = (id: string) => id.replace(/\[.*$/, "");

/** Every kind of block the station is built of. */
export const STATION_BLOCKS: readonly string[] = [
    // What stands on something first, so it comes down before what holds it.
    SWITCH,
    BUTTON,
    EMERGENCY,
    PLATE,
    VENT,
    ...STANDING,
    ...ship.SHIP_STANDING.map(bareId),
    CONSOLE,
    TABLE,
    TABLE_MIDDLE,
    // The rest of the furnishing: on the floor, or on its own kind.
    ...new Set(
        Object.values(FURNISHING)
            .flatMap((one) => [...one.tall, ...one.low])
            .map(bareId)
            .filter(
                (id) =>
                    !(STANDING as readonly string[]).includes(id) &&
                    ![CONSOLE, WINDOW, DARK_FLOOR].includes(id)
            )
    ),
    ...ship.SHIP_BLOCKS,
    LIGHT,
    ROOF,
    WALL_BLOCK,
    SPACE,
    WINDOW,
    CORRIDOR_FLOOR,
    MEETING_FLOOR,
    DARK_FLOOR,
    ...ROOM_FLOORS
];

/** Where a room's corner is, by its column and row. */
function roomCorner(box: Box, col: number, row: number, g: Geometry): { x: number; z: number } {
    return { x: box.x1 + col * (g.room + g.gap), z: box.z1 + row * (g.room + g.gap) };
}

/**
 * The station's rooms, stations and vents, from the run's id: which room is
 * which, its floor, what each of its two corners is, and which rooms have a
 * vent and where it leads. A vent leads to the one it is paired with, both
 * ways; two pairs on three rows, three on four. From `FURNISHED_SINCE` the
 * middle of the first row is the bridge, one other room is dark, and every
 * room but the meeting room is furnished (`furnishing`).
 */
export function layoutFor(seed: string, box: Box, design = DESIGN): Layout {
    if (design >= SHIP_SINCE) return shipLayout(seed, box, design);
    const g = geometryOf(design);
    const furnished = design >= FURNISHED_SINCE;
    const rows = rowsOf(box, design);
    const random = seeded(`${seed}-impostor-${design}`);
    const names = shuffled(ROOM_NAMES, random);
    const rooms: Room[] = [];
    let named = 0;
    for (let row = 0; row < rows; row += 1)
        for (let col = 0; col < COLS; col += 1) {
            const corner = roomCorner(box, col, row, g);
            const meeting = col === MEETING.col && row === MEETING.row;
            const bridge = furnished && col === BRIDGE.col && row === BRIDGE.row;
            rooms.push({
                index: rooms.length,
                col,
                row,
                ...corner,
                name: meeting ? "meeting" : bridge ? "bridge" : names[named++ % names.length]!,
                floor: meeting
                    ? MEETING_FLOOR
                    : bridge
                      ? BRIDGE_FLOOR
                      : ROOM_FLOORS[Math.floor(random() * ROOM_FLOORS.length)]!
            });
        }
    if (furnished) {
        // One room left in the dark, never the bridge.
        const dark = shuffled(
            rooms.filter((one) => one.name !== "meeting" && one.name !== "bridge"),
            random
        )[0]!;
        rooms[dark.index] = { ...dark, floor: DARK_FLOOR, dark: true };
    }
    const meeting = rooms.find((one) => one.name === "meeting")!;
    const working = rooms.filter((one) => one !== meeting);
    const stations: Station[] = [];
    // Every kind in turn, shuffled, so each is played on every station.
    let kinds: StationKind[] = [];
    for (const room of working)
        for (const [dx, dz] of g.stations) {
            if (kinds.length === 0) kinds = shuffled(STATION_KINDS, random);
            stations.push({
                id: stations.length,
                room: room.index,
                kind: kinds.pop()!,
                x: room.x + dx,
                z: room.z + dz
            });
        }
    const pairs = rows <= 3 ? 2 : 3;
    // The bridge's window is where its vent would go: none there.
    const vented = shuffled(
        working.filter((one) => one.name !== "bridge"),
        random
    ).slice(0, pairs * 2);
    const vents: Vent[] = vented.map((room, index) => ({
        room: room.index,
        x: room.x + g.vent.x,
        z: room.z + g.vent.z,
        to: index % 2 === 0 ? index + 1 : index - 1,
        outX: room.x + g.vent.outX,
        outZ: room.z + g.vent.outZ
    }));
    const bare: Layout = {
        box,
        design,
        rows,
        rooms,
        meeting,
        stations,
        vents,
        props: [],
        stars: new Set(),
        pieces: []
    };
    if (!furnished) return bare;
    const stars = new Set<string>();
    for (let dx = 1; dx < g.room - 1; dx += 1)
        for (let dy = 1; dy <= g.wall; dy += 1) if (random() < 0.22) stars.add(`${dx},${dy}`);
    return { ...bare, props: furnishing(bare, random), stars };
}

/**
 * What furnishes each room but the meeting room: up to `PROPS_PER_ROOM` pieces
 * of its own kind (`FURNISHING`) along the inside of its walls - never within
 * a block of a station, a vent or where a vent lets out, never within two of
 * a doorway, and never along the bridge's window.
 */
function furnishing(layout: Layout, random: () => number): Prop[] {
    const g = geometryOf(layout.design);
    const plan = planOf(layout);
    const { box } = layout;
    const cell = (x: number, z: number) => plan[x - box.x1]?.[z - box.z1];
    const kept = [
        ...layout.stations,
        ...layout.vents,
        ...layout.vents.map((vent) => ({ x: vent.outX, z: vent.outZ }))
    ];
    const props: Prop[] = [];
    for (const room of layout.rooms) {
        if (room.name === "meeting") continue;
        const kind = room.dark ? FURNISHING.dark : FURNISHING[room.name as RoomName | "bridge"];
        const spots: { x: number; z: number }[] = [];
        for (let dx = 1; dx < g.room - 1; dx += 1)
            for (let dz = 1; dz < g.room - 1; dz += 1) {
                if (dx !== 1 && dz !== 1 && dx !== g.room - 2 && dz !== g.room - 2) continue;
                const x = room.x + dx;
                const z = room.z + dz;
                if (cell(x, z) !== room.index || cell(x, z - 1) === "window") continue;
                if (kept.some((one) => Math.abs(one.x - x) <= 1 && Math.abs(one.z - z) <= 1))
                    continue;
                let byDoor = false;
                for (let ax = -2; ax <= 2; ax += 1)
                    for (let az = -2; az <= 2; az += 1)
                        if (cell(x + ax, z + az) === "corridor") byDoor = true;
                if (!byDoor) spots.push({ x, z });
            }
        const choices = [...kind.tall, ...kind.low];
        for (const spot of shuffled(spots, random).slice(0, PROPS_PER_ROOM)) {
            const block = choices[Math.floor(random() * choices.length)]!;
            props.push({ ...spot, block, high: kind.tall.includes(block) ? 2 : 1 });
        }
    }
    return props;
}

export type Cell = "void" | "wall" | "corridor" | "space" | "window" | number;

/** The station from above: each column a wall, a corridor, a room's floor
 *  (its index), the bridge's space or window, or nothing, with `x1`, `z1` at
 *  [0][0]. */
export function planOf(layout: Layout): Cell[][] {
    if (layout.design >= SHIP_SINCE) return shipPlan(layout);
    const { box, rooms } = layout;
    const g = geometryOf(layout.design);
    const side = g.room;
    const width = box.x2 - box.x1 + 1;
    const depth = box.z2 - box.z1 + 1;
    const plan: Cell[][] = Array.from({ length: width }, () =>
        Array.from({ length: depth }, (): Cell => "void")
    );
    const at = (x: number, z: number) => plan[x - box.x1]?.[z - box.z1];
    const set = (x: number, z: number, cell: Cell) => {
        if (at(x, z) !== undefined) plan[x - box.x1]![z - box.z1] = cell;
    };
    for (const room of rooms)
        for (let dx = 0; dx < side; dx += 1)
            for (let dz = 0; dz < side; dz += 1) {
                const edge = dx === 0 || dz === 0 || dx === side - 1 || dz === side - 1;
                set(room.x + dx, room.z + dz, edge ? "wall" : room.index);
            }
    // The bridge's top rows: space, behind a window the width of the room.
    for (const room of rooms)
        if (room.name === "bridge")
            for (let dx = 1; dx < side - 1; dx += 1)
                for (let dz = 1; dz <= SPACE_ROWS + 1; dz += 1)
                    set(room.x + dx, room.z + dz, dz <= SPACE_ROWS ? "space" : "window");
    // A corridor to every room beside, through both walls.
    const [from, to] = g.door;
    for (const room of rooms) {
        const east = rooms.find((one) => one.row === room.row && one.col === room.col + 1);
        if (east)
            for (let x = room.x + side - 1; x <= east.x; x += 1)
                for (let dz = from; dz <= to; dz += 1) {
                    const side = dz === from || dz === to;
                    if (!side) set(x, room.z + dz, "corridor");
                    else if (at(x, room.z + dz) === "void") set(x, room.z + dz, "wall");
                }
        const south = rooms.find((one) => one.col === room.col && one.row === room.row + 1);
        if (south)
            for (let z = room.z + side - 1; z <= south.z; z += 1)
                for (let dx = from; dx <= to; dx += 1) {
                    const side = dx === from || dx === to;
                    if (!side) set(room.x + dx, z, "corridor");
                    else if (at(room.x + dx, z) === "void") set(room.x + dx, z, "wall");
                }
    }
    return plan;
}

/** Whether a column is walked on: a room's floor or a corridor. */
export function walkable(cell: Cell | undefined): boolean {
    return cell === "corridor" || typeof cell === "number";
}

/** Columns of one kind merged into as few rectangles as cover them exactly. */
function rectangles(
    plan: readonly (readonly Cell[])[],
    wanted: (cell: Cell, x: number, z: number) => boolean
): { x1: number; z1: number; x2: number; z2: number }[] {
    const width = plan.length;
    const depth = plan[0]?.length ?? 0;
    const used = plan.map((column) => column.map(() => false));
    const take = (x: number, z: number) => !used[x]![z] && wanted(plan[x]![z]!, x, z);
    const found: { x1: number; z1: number; x2: number; z2: number }[] = [];
    for (let z = 0; z < depth; z += 1)
        for (let x = 0; x < width; x += 1) {
            if (!take(x, z)) continue;
            let x2 = x;
            while (x2 + 1 < width && take(x2 + 1, z)) x2 += 1;
            let z2 = z;
            const rowFree = (row: number) => {
                for (let each = x; each <= x2; each += 1) if (!take(each, row)) return false;
                return true;
            };
            while (z2 + 1 < depth && rowFree(z2 + 1)) z2 += 1;
            for (let each = x; each <= x2; each += 1)
                for (let row = z; row <= z2; row += 1) used[each]![row] = true;
            found.push({ x1: x, z1: z, x2, z2 });
        }
    return found;
}

/** The middle of the meeting room's floor. */
export function tableAt(layout: Layout): { x: number; z: number } {
    const { meeting } = layout;
    if (meeting.w !== undefined && meeting.d !== undefined)
        return { x: meeting.x + (meeting.w - 1) / 2, z: meeting.z + (meeting.d - 1) / 2 };
    const middle = geometryOf(layout.design).table;
    return { x: layout.meeting.x + middle, z: layout.meeting.z + middle };
}

/** The emergency button, on the middle of the table. */
export function emergencyAt(layout: Layout): { x: number; y: number; z: number } {
    const table = tableAt(layout);
    return { ...table, y: layout.box.y1 + 2 };
}

/** Whether a room's ceiling has a light over this column of it. */
function lit(g: Geometry, room: Room, dx: number, dz: number): boolean {
    return !room.dark && g.lights.includes(dx) && g.lights.includes(dz);
}

/**
 * What it is built of, each only into air: the floor, the walls, the lights
 * and the roof, and the bridge's space and window; then the table and the
 * consoles, then what stands on them, the plates and vents on the floor and
 * the rooms' furnishing; and last one stretch of corridor floor, nothing on
 * it, its first corner the proof that the blocks stayed. The floor goes in
 * before anything stands on it, or a switch put into air with nothing under
 * it would drop as an item.
 */
export function stationFills(layout: Layout): Fill[] {
    if (layout.design >= SHIP_SINCE) return shipFills(layout);
    const { box } = layout;
    const g = geometryOf(layout.design);
    const wall = g.wall;
    const plan = planOf(layout);
    const y0 = box.y1;
    const fills: Fill[] = [];
    const flat = (
        rect: { x1: number; z1: number; x2: number; z2: number },
        block: string,
        y1: number,
        y2 = y1
    ): Fill => ({
        box: {
            x1: box.x1 + rect.x1,
            z1: box.z1 + rect.z1,
            x2: box.x1 + rect.x2,
            z2: box.z1 + rect.z2,
            y1,
            y2
        },
        block
    });
    // The floor: rooms, walls' foot, corridors - one corridor stretch kept back.
    const corridors = rectangles(plan, (cell) => cell === "corridor");
    const proof = corridors.shift();
    for (const room of layout.rooms)
        for (const rect of rectangles(plan, (cell) => cell === room.index))
            fills.push(flat(rect, room.floor, y0));
    for (const rect of rectangles(plan, (cell) => cell === "wall"))
        fills.push(flat(rect, WALL_BLOCK, y0, y0 + wall));
    for (const rect of corridors) fills.push(flat(rect, CORRIDOR_FLOOR, y0));
    // Lights in the roof, then the roof round them.
    for (const room of layout.rooms)
        for (let dx = 1; dx < g.room - 1; dx += 1)
            for (let dz = 1; dz < g.room - 1; dz += 1)
                if (
                    lit(g, room, dx, dz) &&
                    plan[room.x + dx - box.x1]?.[room.z + dz - box.z1] === room.index
                )
                    fills.push({
                        box: {
                            x1: room.x + dx,
                            z1: room.z + dz,
                            x2: room.x + dx,
                            z2: room.z + dz,
                            y1: y0 + wall + 1,
                            y2: y0 + wall + 1
                        },
                        block: LIGHT
                    });
    const underLight = (cell: Cell, x: number, z: number) => {
        if (typeof cell !== "number") return false;
        const room = layout.rooms[cell]!;
        return lit(g, room, box.x1 + x - room.x, box.z1 + z - room.z);
    };
    const bridgeTop = (cell: Cell) => cell === "space" || cell === "window";
    for (const rect of rectangles(
        plan,
        (cell, x, z) => cell !== "void" && !bridgeTop(cell) && !underLight(cell, x, z)
    ))
        fills.push(flat(rect, ROOF, y0 + wall + 1));
    // The bridge's view: a black sky with its stars against the station's
    // edge, dark glass under the space in front of it, the window the whole
    // height of the room, and black over all three.
    for (const rect of rectangles(plan, (cell) => cell === "window"))
        fills.push(flat(rect, WINDOW, y0, y0 + wall));
    for (const rect of rectangles(plan, bridgeTop)) fills.push(flat(rect, SPACE, y0 + wall + 1));
    const bridge = layout.rooms.find((one) => one.name === "bridge");
    if (bridge)
        for (let dx = 1; dx < g.room - 1; dx += 1) {
            const x = bridge.x + dx;
            const z = bridge.z + 1;
            fills.push(
                flat({ x1: x - box.x1, z1: z - box.z1, x2: x - box.x1, z2: z - box.z1 }, SPACE, y0)
            );
            for (let dy = 1; dy <= wall; dy += 1)
                fills.push(
                    flat(
                        { x1: x - box.x1, z1: z - box.z1, x2: x - box.x1, z2: z - box.z1 },
                        layout.stars.has(`${dx},${dy}`) ? LIGHT : SPACE,
                        y0 + dy
                    )
                );
            for (let dz = 2; dz <= SPACE_ROWS; dz += 1)
                fills.push(
                    flat(
                        {
                            x1: x - box.x1,
                            z1: bridge.z + dz - box.z1,
                            x2: x - box.x1,
                            z2: bridge.z + dz - box.z1
                        },
                        DARK_FLOOR,
                        y0
                    )
                );
        }
    fills.push(...furniture(layout));
    for (const prop of layout.props)
        for (let dy = 1; dy <= prop.high; dy += 1)
            fills.push(one(prop.x, y0 + dy, prop.z, prop.block));
    if (proof) fills.push(flat(proof, CORRIDOR_FLOOR, y0));
    return fills;
}

/** One block. */
function one(x: number, y: number, z: number, block: string): Fill {
    return { box: { x1: x, y1: y, z1: z, x2: x, y2: y, z2: z }, block };
}

/** The table with the emergency button on it, the stations - a console with a
 *  switch or a button on it, or a plate - and the vents, shut. */
function furniture(layout: Layout): Fill[] {
    const y0 = layout.box.y1;
    const fills: Fill[] = [];
    const table = tableAt(layout);
    const edge = (z: number): Fill => ({
        box: { x1: table.x - 1, z1: z, x2: table.x + 1, z2: z, y1: y0 + 1, y2: y0 + 1 },
        block: TABLE
    });
    fills.push(
        one(table.x, y0 + 1, table.z, TABLE_MIDDLE),
        edge(table.z - 1),
        edge(table.z + 1),
        one(table.x - 1, y0 + 1, table.z, TABLE),
        one(table.x + 1, y0 + 1, table.z, TABLE)
    );
    const button = emergencyAt(layout);
    fills.push(one(button.x, button.y, button.z, EMERGENCY_FLOOR));
    // The stations: a console, and on it a switch or a button; or a plate.
    for (const station of layout.stations) {
        if (station.kind === "scan") {
            fills.push(one(station.x, y0 + 1, station.z, PLATE));
            continue;
        }
        fills.push(
            one(station.x, y0 + 1, station.z, CONSOLE),
            one(station.x, y0 + 2, station.z, station.kind === "switch" ? SWITCH_OFF : BUTTON_FLOOR)
        );
    }
    for (const vent of layout.vents) fills.push(one(vent.x, y0 + 1, vent.z, VENT_SHUT));
    return fills;
}

// ------------------------------------------------------------------ the ship

/** The ship's columns of cells: the engine wing only on four rows. */
function shipCols(rows: number): number {
    return rows >= 4 ? ship.COLS_FULL : ship.COLS_FULL - ship.WING_COLS;
}

/** The first column of cells a ship of this many rows has. */
function shipFirst(rows: number): number {
    return rows >= 4 ? 0 : ship.WING_COLS;
}

/** The middle of a span of cells, by the ship's own columns. */
function cellMiddle(
    box: Box,
    first: number,
    cols: readonly [number, number],
    rows: readonly [number, number]
): { x: number; z: number } {
    return {
        x: box.x1 + ((cols[0] + cols[1] - 2 * first + 1) * ship.PITCH) / 2,
        z: box.z1 + ((rows[0] + rows[1] + 1) * ship.PITCH) / 2
    };
}

/** Vent pairs on the small ship and the full one. */
const SHIP_PAIRS = { small: 3, full: 4 } as const;
/** How near a doorway nothing in the way of walking is put. */
const DOOR_CLEAR = 2;

/**
 * The ship's rooms, from the run's id: every room where `impostor-ship`
 * places it, drawn by its template; the stations each template asks for; the
 * vents drawn among the rooms that have a place for one, paired both ways; and
 * the furnishing, kept off the stations, the vents and where they let out, the
 * seats round the table and the doorways, merged into as few fills as cover it.
 */
function shipLayout(seed: string, box: Box, design: number): Layout {
    const rows = rowsOf(box, design);
    const first = shipFirst(rows);
    const random = seeded(`${seed}-impostor-${design}`);
    const rooms: Room[] = ship.PLOTS.filter((plot) => rows >= 4 || !plot.wing).map(
        (plot, index) => {
            const middle = cellMiddle(box, first, plot.cols, plot.rows);
            return {
                index,
                col: plot.cols[0] - first,
                row: plot.rows[0],
                x: middle.x - (plot.w - 1) / 2,
                z: middle.z - (plot.d - 1) / 2,
                w: plot.w,
                d: plot.d,
                name: plot.name,
                floor: ship.FLOORS[plot.name]
            };
        }
    );
    const meeting = rooms.find((one) => one.name === "cafeteria")!;
    const stations: Station[] = [];
    const spots: Omit<Vent, "to">[] = [];
    const drawn = new Map<string, string>();
    for (const room of rooms) {
        const w = room.w! - 2;
        const d = room.d! - 2;
        const at = (u: number, l: number, v: number) => `${room.x + 1 + u},${l},${room.z + 1 + v}`;
        ship.TEMPLATES[room.name as ship.ShipRoom]({
            w,
            d,
            random,
            put(block, u1, l1, v1, u2 = u1, l2 = l1, v2 = v1) {
                for (let u = Math.max(0, u1); u <= Math.min(w - 1, u2); u += 1)
                    for (let l = Math.max(1, l1); l <= Math.min(ship.WALL, l2); l += 1)
                        for (let v = Math.max(0, v1); v <= Math.min(d - 1, v2); v += 1)
                            if (!drawn.has(at(u, l, v))) drawn.set(at(u, l, v), block);
            },
            station(kind, u, v) {
                stations.push({
                    id: stations.length,
                    room: room.index,
                    kind,
                    x: room.x + 1 + u,
                    z: room.z + 1 + v
                });
            },
            vent(u, v, outU, outV) {
                spots.push({
                    room: room.index,
                    x: room.x + 1 + u,
                    z: room.z + 1 + v,
                    outX: room.x + 1 + outU,
                    outZ: room.z + 1 + outV
                });
            }
        });
    }
    const pairs = rows >= 4 ? SHIP_PAIRS.full : SHIP_PAIRS.small;
    const vents: Vent[] = shuffled(spots, random)
        .slice(0, pairs * 2)
        .map((spot, index) => ({ ...spot, to: index % 2 === 0 ? index + 1 : index - 1 }));
    const stars = new Set<string>();
    const navigation = rooms.find((one) => one.name === "navigation")!;
    for (let dz = 1; dz < navigation.d! - 1; dz += 1)
        for (let dy = 1; dy <= ship.WALL; dy += 1) if (random() < 0.22) stars.add(`${dz},${dy}`);
    const bare: Layout = {
        box,
        design,
        rows,
        rooms,
        meeting,
        stations,
        vents,
        props: [],
        stars,
        pieces: []
    };
    return { ...bare, pieces: shipPieces(bare, drawn) };
}

/** What the templates drew, kept where it is in nobody's way. */
function shipPieces(layout: Layout, drawn: ReadonlyMap<string, string>): Fill[] {
    const { box } = layout;
    const plan = planOf(layout);
    const cell = (x: number, z: number) => plan[x - box.x1]?.[z - box.z1];
    const clear = new Set<string>();
    for (const spot of [
        ...layout.stations,
        ...layout.vents,
        ...layout.vents.map((vent) => ({ x: vent.outX, z: vent.outZ }))
    ])
        clear.add(`${spot.x},${spot.z}`);
    const table = tableAt(layout);
    const seats = geometryOf(layout.design).seats + 1;
    const byDoor = (x: number, z: number) => {
        for (let ax = -DOOR_CLEAR; ax <= DOOR_CLEAR; ax += 1)
            for (let az = -DOOR_CLEAR; az <= DOOR_CLEAR; az += 1)
                if (cell(x + ax, z + az) === "corridor") return true;
        return false;
    };
    const stays = new Map<string, string>();
    for (const [key, block] of drawn) {
        const [x, level, z] = key.split(",").map(Number) as [number, number, number];
        if (typeof cell(x, z) !== "number") continue;
        if (level <= 2) {
            if (clear.has(`${x},${z}`) || byDoor(x, z)) continue;
            if (Math.max(Math.abs(x - table.x), Math.abs(z - table.z)) <= seats) continue;
        }
        stays.set(key, block);
    }
    // Nothing left standing on what was kept out, nor hanging from it.
    const held = (key: string, block: string) => {
        const [x, level, z] = key.split(",").map(Number) as [number, number, number];
        if (block.includes("hanging=true"))
            return level === ship.WALL || stays.has(`${x},${level + 1},${z}`);
        if (!(ship.SHIP_STANDING as readonly string[]).includes(bareId(block))) return true;
        return level === 1 || stays.has(`${x},${level - 1},${z}`);
    };
    for (let changed = true; changed; ) {
        changed = false;
        for (const [key, block] of stays)
            if (!held(key, block)) {
                stays.delete(key);
                changed = true;
            }
    }
    const kept = new Map<string, Map<number, Set<string>>>();
    for (const [key, block] of stays) {
        const [x, level, z] = key.split(",").map(Number) as [number, number, number];
        const levels = kept.get(block) ?? new Map<number, Set<string>>();
        const columns = levels.get(level) ?? new Set<string>();
        columns.add(`${x},${z}`);
        levels.set(level, columns);
        kept.set(block, levels);
    }
    const pieces: { fill: Fill; level: number; hanging: boolean }[] = [];
    for (const [block, levels] of kept)
        for (const [level, columns] of levels)
            for (const rect of merged(columns))
                pieces.push({
                    fill: { box: { ...rect, y1: box.y1 + level, y2: box.y1 + level }, block },
                    level,
                    hanging: block.includes("hanging=true")
                });
    // What stands on something after it; what hangs from something last, the
    // highest first.
    pieces.sort((a, b) => {
        if (a.hanging !== b.hanging) return a.hanging ? 1 : -1;
        return a.hanging ? b.level - a.level : a.level - b.level;
    });
    return pieces.map((piece) => piece.fill);
}

/** Columns, by `x,z`, merged into as few rectangles as cover them exactly. */
function merged(
    columns: ReadonlySet<string>
): { x1: number; z1: number; x2: number; z2: number }[] {
    const order = [...columns]
        .map((key) => key.split(",").map(Number) as [number, number])
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const used = new Set<string>();
    const free = (x: number, z: number) => columns.has(`${x},${z}`) && !used.has(`${x},${z}`);
    const found: { x1: number; z1: number; x2: number; z2: number }[] = [];
    for (const [x, z] of order) {
        if (!free(x, z)) continue;
        let x2 = x;
        while (free(x2 + 1, z)) x2 += 1;
        let z2 = z;
        const rowFree = (row: number) => {
            for (let each = x; each <= x2; each += 1) if (!free(each, row)) return false;
            return true;
        };
        while (rowFree(z2 + 1)) z2 += 1;
        for (let each = x; each <= x2; each += 1)
            for (let row = z; row <= z2; row += 1) used.add(`${each},${row}`);
        found.push({ x1: x, z1: z, x2, z2 });
    }
    return found;
}

/** The ship from above: its rooms, navigation's space and window, the halls
 *  and the corridors between cells, walled where they cross nothing. */
function shipPlan(layout: Layout): Cell[][] {
    const { box, rooms } = layout;
    const first = shipFirst(layout.rows);
    const cols = shipCols(layout.rows);
    const width = box.x2 - box.x1 + 1;
    const depth = box.z2 - box.z1 + 1;
    const plan: Cell[][] = Array.from({ length: width }, () =>
        Array.from({ length: depth }, (): Cell => "void")
    );
    const at = (x: number, z: number) => plan[x - box.x1]?.[z - box.z1];
    const set = (x: number, z: number, cell: Cell) => {
        if (at(x, z) !== undefined) plan[x - box.x1]![z - box.z1] = cell;
    };
    for (const room of rooms)
        for (let dx = 0; dx < room.w!; dx += 1)
            for (let dz = 0; dz < room.d!; dz += 1) {
                const edge = dx === 0 || dz === 0 || dx === room.w! - 1 || dz === room.d! - 1;
                set(room.x + dx, room.z + dz, edge ? "wall" : room.index);
            }
    // Navigation's east: space, behind a window the depth of the room.
    const navigation = rooms.find((one) => one.name === "navigation")!;
    const inner = navigation.w! - 2;
    for (let dz = 1; dz < navigation.d! - 1; dz += 1)
        for (let u = inner - ship.SPACE_COLS - 1; u < inner; u += 1)
            set(
                navigation.x + 1 + u,
                navigation.z + dz,
                u >= inner - ship.SPACE_COLS ? "space" : "window"
            );
    const middle = (col: number, row: number) => cellMiddle(box, first, [col, col], [row, row]);
    const has = (col: number) => col >= first && col - first < cols;
    const walls: { x: number; z: number }[] = [];
    const corridor = (x: number, z: number) => {
        const here = at(x, z);
        if (here === "void" || here === "wall") set(x, z, "corridor");
    };
    for (const [col, row] of ship.HALLS) {
        if (!has(col)) continue;
        const hall = middle(col, row);
        for (let dx = -2; dx <= 2; dx += 1)
            for (let dz = -2; dz <= 2; dz += 1)
                if (Math.abs(dx) === 2 || Math.abs(dz) === 2)
                    walls.push({ x: hall.x + dx, z: hall.z + dz });
                else corridor(hall.x + dx, hall.z + dz);
    }
    for (const [c1, r1, c2, r2] of ship.EDGES) {
        if (!has(c1) || !has(c2)) continue;
        const from = middle(c1, r1);
        const to = middle(c2, r2);
        const across = r1 === r2;
        const start = across ? Math.min(from.x, to.x) : Math.min(from.z, to.z);
        const end = across ? Math.max(from.x, to.x) : Math.max(from.z, to.z);
        for (let along = start; along <= end; along += 1)
            for (let side = -2; side <= 2; side += 1) {
                const x = across ? along : from.x + side;
                const z = across ? from.z + side : along;
                if (Math.abs(side) === 2) walls.push({ x, z });
                else corridor(x, z);
            }
    }
    for (const spot of walls) if (at(spot.x, spot.z) === "void") set(spot.x, spot.z, "wall");
    return plan;
}

/** Where the ship's roof has a light, by `x,z`: a grid of them over every
 *  room, and every fourth block along the middle of a corridor. */
function shipLights(layout: Layout, plan: readonly (readonly Cell[])[]): Set<string> {
    const { box } = layout;
    const cell = (x: number, z: number) => plan[x - box.x1]?.[z - box.z1];
    const lights = new Set<string>();
    for (const room of layout.rooms)
        for (let u = 2; u < room.w! - 2; u += 4)
            for (let v = 2; v < room.d! - 2; v += 4) {
                const x = room.x + 1 + u;
                const z = room.z + 1 + v;
                if (cell(x, z) === room.index) lights.add(`${x},${z}`);
            }
    for (let x = box.x1; x <= box.x2; x += 1)
        for (let z = box.z1; z <= box.z2; z += 1)
            if (
                cell(x, z) === "corridor" &&
                (x - box.x1 + z - box.z1) % 4 === 0 &&
                [cell(x + 1, z), cell(x - 1, z), cell(x, z + 1), cell(x, z - 1)].every(walkable)
            )
                lights.add(`${x},${z}`);
    return lights;
}

/**
 * The ship, each block only into air: floors, walls, the corridors but one
 * stretch, the lights and the roof, navigation's window and space; then the
 * table, the stations and the vents; then the rooms' furnishing, what stands
 * on something after what holds it; and last the corridor stretch kept back,
 * its first corner the proof that the blocks stayed.
 */
function shipFills(layout: Layout): Fill[] {
    const { box } = layout;
    const wall = ship.WALL;
    const plan = planOf(layout);
    const y0 = box.y1;
    const roof = y0 + wall + 1;
    const fills: Fill[] = [];
    const flat = (
        rect: { x1: number; z1: number; x2: number; z2: number },
        block: string,
        y1: number,
        y2 = y1
    ): Fill => ({
        box: {
            x1: box.x1 + rect.x1,
            z1: box.z1 + rect.z1,
            x2: box.x1 + rect.x2,
            z2: box.z1 + rect.z2,
            y1,
            y2
        },
        block
    });
    const corridors = rectangles(plan, (cell) => cell === "corridor");
    const proof = corridors.shift();
    for (const room of layout.rooms)
        for (const rect of rectangles(plan, (cell) => cell === room.index))
            fills.push(flat(rect, room.floor, y0));
    for (const rect of rectangles(plan, (cell) => cell === "wall"))
        fills.push(flat(rect, WALL_BLOCK, y0, y0 + wall));
    for (const rect of corridors) fills.push(flat(rect, CORRIDOR_FLOOR, y0));
    const lights = shipLights(layout, plan);
    for (const key of lights) {
        const [x, z] = key.split(",").map(Number) as [number, number];
        fills.push(one(x, roof, z, LIGHT));
    }
    const spaceTop = (cell: Cell) => cell === "space" || cell === "window";
    for (const rect of rectangles(
        plan,
        (cell, x, z) =>
            cell !== "void" && !spaceTop(cell) && !lights.has(`${box.x1 + x},${box.z1 + z}`)
    ))
        fills.push(flat(rect, ROOF, roof));
    // Navigation's view: a black sky with its stars against the ship's edge,
    // dark glass under the space in front of it, the window the whole height
    // of the room, and black over all three.
    for (const rect of rectangles(plan, (cell) => cell === "window"))
        fills.push(flat(rect, WINDOW, y0, y0 + wall));
    for (const rect of rectangles(plan, spaceTop)) fills.push(flat(rect, SPACE, roof));
    const navigation = layout.rooms.find((room) => room.name === "navigation")!;
    const backdrop = navigation.x + navigation.w! - 2;
    for (let dz = 1; dz < navigation.d! - 1; dz += 1) {
        const z = navigation.z + dz;
        fills.push(one(backdrop, y0, z, SPACE));
        for (let dy = 1; dy <= wall; dy += 1)
            fills.push(one(backdrop, y0 + dy, z, layout.stars.has(`${dz},${dy}`) ? LIGHT : SPACE));
        for (let x = backdrop - ship.SPACE_COLS + 1; x < backdrop; x += 1)
            fills.push(one(x, y0, z, DARK_FLOOR));
    }
    fills.push(...furniture(layout), ...layout.pieces);
    if (proof) fills.push(flat(proof, CORRIDOR_FLOOR, y0));
    // The ship is bigger than one fill, so it comes down a slice at a time
    // (`arena.teardown`): each fill cut along the same slices, so every block
    // put down is in one of them whole.
    const pieces = slices(box);
    return fills.flatMap((fill) =>
        pieces.flatMap((piece): Fill[] => {
            const cut = {
                x1: Math.max(fill.box.x1, piece.x1),
                y1: Math.max(fill.box.y1, piece.y1),
                z1: Math.max(fill.box.z1, piece.z1),
                x2: Math.min(fill.box.x2, piece.x2),
                y2: Math.min(fill.box.y2, piece.y2),
                z2: Math.min(fill.box.z2, piece.z2)
            };
            return cut.x1 <= cut.x2 && cut.y1 <= cut.y2 && cut.z1 <= cut.z2
                ? [{ box: cut, block: fill.block }]
                : [];
        })
    );
}
/** Every kind of block the station can hold while it stands: what it is built of. */
export function stationBlocks(): string[] {
    return [...STATION_BLOCKS];
}

/** The way to face from `from` to look at `to`: 0 is south, 90 west, in this game. */
function yawTowards(from: { x: number; z: number }, to: { x: number; z: number }): number {
    return Math.round((-Math.atan2(to.x - from.x, to.z - from.z) * 1800) / Math.PI) / 10;
}

/** The seats round the table: the ring two blocks out from it, 24 of them,
 *  in order round it. */
function seatRing(layout: Layout): { x: number; z: number }[] {
    const table = tableAt(layout);
    const ring: { x: number; z: number }[] = [];
    const r = geometryOf(layout.design).seats;
    for (let dx = -r; dx <= r; dx += 1) ring.push({ x: table.x + dx, z: table.z - r });
    for (let dz = -r + 1; dz <= r; dz += 1) ring.push({ x: table.x + r, z: table.z + dz });
    for (let dx = r - 1; dx >= -r; dx -= 1) ring.push({ x: table.x + dx, z: table.z + r });
    for (let dz = r - 1; dz > -r; dz -= 1) ring.push({ x: table.x - r, z: table.z + dz });
    return ring;
}

/** The `index`th of `count` seats round the table, spread evenly, facing it. */
export function seatSpot(layout: Layout, index: number, count: number): Spot {
    const ring = seatRing(layout);
    const at = ring[Math.floor((index * ring.length) / Math.max(1, count)) % ring.length]!;
    return { ...at, y: layout.box.y1 + 1, yaw: yawTowards(at, tableAt(layout)) };
}

/** Whether somebody stands inside the station, between its floor and its roof. */
export function inside(
    layout: Layout,
    at: { x: number; y: number; z: number },
    plan: readonly (readonly Cell[])[] = planOf(layout)
): boolean {
    const { box } = layout;
    if (at.y < box.y1 + 1 || at.y >= box.y2) return false;
    return walkable(plan[Math.floor(at.x) - box.x1]?.[Math.floor(at.z) - box.z1]);
}

/** The column somebody stands on. */
function column(at: { x: number; z: number }): { x: number; z: number } {
    return { x: Math.floor(at.x), z: Math.floor(at.z) };
}

/** Whether somebody stands on a column, on the floor (a plate or a vent is
 *  under the soles of whoever is on it). */
export function standsOn(
    layout: Layout,
    at: { x: number; y: number; z: number },
    spot: { x: number; z: number }
): boolean {
    const here = column(at);
    return (
        here.x === spot.x &&
        here.z === spot.z &&
        at.y >= layout.box.y1 + 1 &&
        at.y < layout.box.y1 + 1.6
    );
}

/** The vent somebody stands on, or null. */
export function ventUnder(
    layout: Layout,
    at: { x: number; y: number; z: number }
): { vent: Vent; index: number } | null {
    const index = layout.vents.findIndex((vent) => standsOn(layout, at, vent));
    return index < 0 ? null : { vent: layout.vents[index]!, index };
}

/** Where an impostor comes out of a vent: beside it, facing into the room. */
export function ventExit(layout: Layout, vent: Vent): Spot {
    return {
        x: vent.outX,
        y: layout.box.y1 + 1,
        z: vent.outZ,
        yaw: yawTowards({ x: vent.outX, z: vent.outZ }, { x: vent.outX - 3, z: vent.outZ + 3 })
    };
}

// ------------------------------------------------------------------ the run's own

/** What a crew member has done, and when somebody went out of the game. */
const deadSchema = z.object({
    name: z.string(),
    at: z.number(),
    how: z.enum(["killed", "voted", "left"]),
    by: z.string().nullable().default(null)
});

const bodySchema = z.object({
    name: z.string(),
    x: z.number(),
    y: z.number(),
    z: z.number(),
    /** Taken away at a meeting: not reported again. */
    gone: z.boolean().default(false)
});
export type Body = z.infer<typeof bodySchema>;

export const SKIP = "-";

const meetingSchema = z.object({
    reason: z.enum(["report", "emergency"]),
    by: z.string(),
    /** Whose body, for a report. */
    body: z.string().nullable().default(null),
    startedAt: z.number(),
    /** When the talking ends and the vote opens. */
    voteAt: z.number(),
    endsAt: z.number(),
    /** Whether the ballots were handed out. */
    ballots: z.boolean().default(false),
    /** Who voted for whom, by voter: a name, or `SKIP`. */
    votes: z.record(z.string(), z.string()).default({})
});
export type Meeting = z.infer<typeof meetingSchema>;

/** What the server could show when the station was built. */
export const eraSchema = z.object({
    /** An entity a body can be right-clicked by (1.19.4). */
    interaction: z.boolean().default(false),
    /** Items written with components (1.20.5). */
    components: z.boolean().default(false),
    /** `item replace` (1.17). */
    itemCommand: z.boolean().default(false),
    /** A name written as a text component rather than JSON in a string (1.21.5). */
    modernText: z.boolean().default(false)
});
export type Era = z.infer<typeof eraSchema>;
export const OLDEST: Era = {
    interaction: false,
    components: false,
    itemCommand: false,
    modernText: false
};

export const stateSchema = z.object({
    design: z.number().int().default(DESIGN),
    era: eraSchema.default(OLDEST),
    rows: z.number().int().min(3).max(4).default(3),
    /** Whether "Go!" has been played: the roles drawn and said. */
    started: z.boolean().default(false),
    impostors: z.array(z.string()).default([]),
    /** Each player's stations to do (an impostor's, to pretend with). */
    tasks: z.record(z.string(), z.array(z.number().int())).default({}),
    /** Each crew member's stations done. */
    done: z.record(z.string(), z.array(z.number().int())).default({}),
    dead: z.array(deadSchema).default([]),
    bodies: z.array(bodySchema).default([]),
    kills: z.record(z.string(), z.number().int()).default({}),
    /** When each impostor's next kill is ready. */
    ready: z.record(z.string(), z.number()).default({}),
    /** Emergency meetings each player has called. */
    called: z.record(z.string(), z.number().int()).default({}),
    /** The emergency button waits until then: after "Go!" and every meeting. */
    calmUntil: z.number().default(0),
    meeting: meetingSchema.nullable().default(null),
    meetings: z.number().int().default(0),
    winner: z.enum(["crew", "impostors"]).nullable().default(null),
    why: z.enum(["tasks", "voted", "outnumbered", "time"]).nullable().default(null)
});
export type ImpostorState = z.infer<typeof stateSchema>;

/** The run's game as written; null before it is. */
export function stateOf(game: unknown): ImpostorState | null {
    if (game === null || game === undefined) return null;
    const parsed = stateSchema.safeParse(game);
    return parsed.success ? parsed.data : null;
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** In the order of their names, the way every draw reads them. */
function byName(names: readonly string[]): string[] {
    return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// ------------------------------------------------------------------ roles and tasks

/** How many impostors `players` are played with: what was asked, never more
 *  than one for every three players, and always one. */
export function impostorCount(players: number, wanted: number): number {
    return Math.max(
        1,
        Math.min(wanted, MOST_IMPOSTORS, Math.floor(Math.max(players, 0) / PER_IMPOSTOR))
    );
}

/** Who the impostors are, drawn from the run's id among `names`. */
export function impostorsFor(seed: string, names: readonly string[], wanted: number): string[] {
    if (names.length === 0) return [];
    const count = impostorCount(names.length, wanted);
    return shuffled(byName(names), seeded(`${seed}-impostor-roles`)).slice(0, count);
}

/** The stations one player is given: `count` different ones, drawn from the
 *  run's id and their name, never two in one room while there are rooms left. */
export function tasksFor(seed: string, name: string, layout: Layout, count: number): number[] {
    const random = seeded(`${seed}-impostor-tasks-${name.toLowerCase()}`);
    const order = shuffled(layout.stations, random);
    const chosen: Station[] = [];
    for (const station of order) {
        if (chosen.length >= count) break;
        if (!chosen.some((one) => one.room === station.room)) chosen.push(station);
    }
    for (const station of order) {
        if (chosen.length >= count) break;
        if (!chosen.includes(station)) chosen.push(station);
    }
    return chosen.map((one) => one.id);
}

export function isImpostor(state: ImpostorState, name: string): boolean {
    return state.impostors.some((one) => same(one, name));
}

export function isDead(state: ImpostorState, name: string): boolean {
    return state.dead.some((one) => same(one.name, name));
}

/** Who is still playing, of `names`. */
export function aliveOf(state: ImpostorState, names: readonly string[]): string[] {
    return names.filter((name) => !isDead(state, name));
}

/** The crew's tasks: done, and how many there are. A crew member who is dead
 *  keeps what they did, and what they never got to is no longer asked of anybody. */
export function progressOf(
    state: ImpostorState,
    names: readonly string[]
): { done: number; total: number } {
    let done = 0;
    let total = 0;
    for (const name of names) {
        if (isImpostor(state, name)) continue;
        const did = (state.done[name] ?? []).length;
        done += did;
        total += isDead(state, name) ? did : (state.tasks[name] ?? []).length;
    }
    return { done, total };
}

/**
 * Whether it is decided, and for whom: the crew with every impostor out; the
 * impostors once they are as many as the crew left; the crew with every task
 * done. In that order, so the last task and the kill that made the impostors
 * as many as the crew in one look go to the impostors.
 */
export function verdict(
    state: ImpostorState,
    names: readonly string[]
): { winner: "crew" | "impostors"; why: "tasks" | "voted" | "outnumbered" } | null {
    const alive = aliveOf(state, names);
    const impostors = alive.filter((name) => isImpostor(state, name)).length;
    const crew = alive.length - impostors;
    if (impostors === 0) return { winner: "crew", why: "voted" };
    if (impostors >= crew) return { winner: "impostors", why: "outnumbered" };
    const progress = progressOf(state, names);
    if (progress.total > 0 && progress.done >= progress.total)
        return { winner: "crew", why: "tasks" };
    return null;
}

// ------------------------------------------------------------------ timing

/** How long a plate is stood on to scan. */
export const SCAN_SECONDS = 5;
/** How long a player may be off the server before they are out of the game. */
export const MISSING_MS = 20_000;
/** The emergency button waits this long after "Go!" and after each meeting. */
export const EMERGENCY_CALM_MS = 15_000;
/** How soon an impostor out of a vent can take one again. */
export const VENT_PAUSE_MS = 2_000;

// ------------------------------------------------------------------ kills

/** How near an impostor who struck must stand to have been the one, where the
 *  game cannot say who hurt whom (before 1.19.4). */
export const KILL_REACH = 5;

/**
 * Who killed a crew member hurt since the last look, of the impostors whose
 * kill was ready and who struck: the one the game says hurt them (from
 * 1.19.4; null when it names nobody, or somebody who is not one of these), or
 * else the nearest of them within `KILL_REACH`.
 */
export function killerOf(
    victim: { x: number; z: number },
    strikers: readonly { name: string; x: number; z: number }[],
    attacker: string | null | undefined
): string | null {
    if (attacker !== undefined)
        return attacker === null
            ? null
            : (strikers.find((one) => same(one.name, attacker))?.name ?? null);
    let best: string | null = null;
    let nearest = KILL_REACH;
    for (const one of strikers) {
        const away = Math.hypot(one.x - victim.x, one.z - victim.z);
        if (away <= nearest) {
            nearest = away;
            best = one.name;
        }
    }
    return best;
}

/** Whether an impostor can kill now: alive, out of a meeting, and their
 *  cooldown over. */
export function canKill(state: ImpostorState, name: string, now: number): boolean {
    return (
        isImpostor(state, name) &&
        !isDead(state, name) &&
        state.meeting === null &&
        now >= (state.ready[name] ?? 0)
    );
}

// ------------------------------------------------------------------ votes

/**
 * Who is voted out: the one with the most votes, counting only votes from and
 * for players still in; nobody on a tie at the top, when skipping has the
 * most, or with no votes at all.
 */
export function tally(
    votes: Readonly<Record<string, string>>,
    alive: readonly string[]
): string | null {
    const named = (name: string) => alive.find((one) => same(one, name)) ?? null;
    const counts = new Map<string, number>();
    for (const [voter, target] of Object.entries(votes)) {
        if (!named(voter)) continue;
        const key = target === SKIP ? SKIP : named(target);
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let top = 0;
    let leaders: string[] = [];
    for (const [key, count] of counts) {
        if (count > top) {
            top = count;
            leaders = [key];
        } else if (count === top) leaders.push(key);
    }
    if (top === 0 || leaders.length !== 1 || leaders[0] === SKIP) return null;
    return leaders[0]!;
}

/** How a vote came out: who is voted out, or nobody - because skipping had
 *  the most votes (`skipped`), or on a tie. */
export function voteOutcome(
    votes: Readonly<Record<string, string>>,
    alive: readonly string[]
): { out: string | null; skipped: boolean } {
    const out = tally(votes, alive);
    if (out) return { out, skipped: false };
    const counted = Object.entries(votes).filter(([voter]) =>
        alive.some((one) => same(one, voter))
    );
    const skips = counted.filter(([, target]) => target === SKIP).length;
    const others = new Map<string, number>();
    for (const [, target] of counted)
        if (target !== SKIP)
            others.set(target.toLowerCase(), (others.get(target.toLowerCase()) ?? 0) + 1);
    const most = Math.max(0, ...others.values());
    return { out: null, skipped: skips > most || counted.length === 0 };
}

/** What one vote in the chat says: a name of somebody still in, or a skip;
 *  null for anything else. `vote Ana`, `votar Ana`, `skip`, `saltar`. */
export function voteSaid(said: string, alive: readonly string[]): string | null {
    const line = said.trim();
    if (/^(skip|saltar|omitir)$/i.test(line)) return SKIP;
    const named = /^(?:vote|votar|votar a)\s+@?(\.?[A-Za-z0-9_]{1,16})$/i.exec(line);
    if (!named) return null;
    return alive.find((one) => same(one, named[1]!)) ?? null;
}

/** Whether a chat line reports a body: `report`, `reportar`. */
export function reportSaid(said: string): boolean {
    return /^(report|reportar)$/i.test(said.trim());
}

// ------------------------------------------------------------------ points

export const TASK_POINTS = 10;
export const KILL_POINTS = 25;
/** More than anybody on the losing side can score - every task (8 at most) or a
 *  kill of everybody else (`MOST` - 1) - so the podium's top is always the side
 *  players name as the winner, and points only rank within a side. */
export const WIN_POINTS = Math.max(8 * TASK_POINTS, (MOST - 1) * KILL_POINTS) + TASK_POINTS;

/** The scores: a crew member's tasks, an impostor's kills, and the side that
 *  won given the win on top - everybody on it, alive or not. Nothing until the
 *  game is decided, since a kill counted would name who made it. */
export function scoresOf(
    state: ImpostorState | null,
    names: readonly string[]
): Map<string, number> {
    const scores = new Map<string, number>();
    for (const name of names) {
        if (!state?.winner) {
            scores.set(name, 0);
            continue;
        }
        const impostor = isImpostor(state, name);
        const own = impostor
            ? (state.kills[name] ?? 0) * KILL_POINTS
            : (state.done[name] ?? []).length * TASK_POINTS;
        const won = state.winner === (impostor ? "impostors" : "crew") ? WIN_POINTS : 0;
        scores.set(name, own + won);
    }
    return scores;
}

// ------------------------------------------------------------------ the commands

/** Everybody playing: nobody's name over their head, no pushing. */
export const TEAM = "pe_im";
/** Who is still in, who is out and watching, who is an impostor. */
export const LIVE_TAG = "pe_im_live";
export const GHOST_TAG = "pe_im_ghost";
export const IMPOSTOR_TAG = "pe_im_imp";
/** What a player's clicks and the station's switches set: one count every
 *  player may set by `/trigger`, read and put back to 0 each look. */
export const PRESS = "pe_imp";
export const DEALT = "pe_imd";
export const TAKEN = "pe_imt";
export const READ_DEALT = `execute as @a run scoreboard players get @s ${DEALT}`;
export const READ_TAKEN = `execute as @a run scoreboard players get @s ${TAKEN}`;
export const READ_PRESS = `execute as @a run scoreboard players get @s ${PRESS}`;

/** What each value of `PRESS` means. */
export const PRESSED_SKIP = 1;
export const PRESSED_EMERGENCY = 2;
/** A vote for the entrant at this place plus the index. */
export const VOTE_BASE = 100;
/** A station worked, plus its id. */
export const TASK_BASE = 1000;
/** A body reported, plus its place in `bodies`. */
export const REPORT_BASE = 2000;

/** What a value of `PRESS` read back is. */
export type Press =
    | { kind: "skip" }
    | { kind: "emergency" }
    | { kind: "vote"; entrant: number }
    | { kind: "task"; station: number }
    | { kind: "report"; body: number };

export function pressOf(value: number): Press | null {
    if (value === PRESSED_SKIP) return { kind: "skip" };
    if (value === PRESSED_EMERGENCY) return { kind: "emergency" };
    if (value >= REPORT_BASE) return { kind: "report", body: value - REPORT_BASE };
    if (value >= TASK_BASE) return { kind: "task", station: value - TASK_BASE };
    if (value >= VOTE_BASE) return { kind: "vote", entrant: value - VOTE_BASE };
    return null;
}

/** How far from what it names a press is still taken: the reach of a click,
 *  and the run on from it to the look that reads it. */
export const PRESS_REACH = 8;

/** Whether somebody here could have made this press: a task at a switch or
 *  button of theirs, a body or the emergency button within `PRESS_REACH`. A
 *  plate is only worked by standing on it, never by a press. */
export function pressReaches(
    layout: Layout,
    bodies: readonly Body[],
    press: Press,
    at: { x: number; y: number; z: number } | undefined
): boolean {
    if (press.kind === "skip" || press.kind === "vote") return true;
    if (!at) return false;
    const near = (spot: { x: number; y: number; z: number }) =>
        Math.hypot(spot.x - at.x, spot.z - at.z) <= PRESS_REACH && Math.abs(spot.y - at.y) < 3;
    const y = layout.box.y1 + 1;
    if (press.kind === "task") {
        const station = layout.stations.find((one) => one.id === press.station);
        return (
            !!station &&
            station.kind !== "scan" &&
            near({ x: station.x + 0.5, y, z: station.z + 0.5 })
        );
    }
    if (press.kind === "report") {
        const body = bodies[press.body];
        return !!body && near(body);
    }
    const button = emergencyAt(layout);
    return near({ x: button.x + 0.5, y, z: button.z + 0.5 });
}

export function resetPress(name: string): string {
    return `scoreboard players set ${name} ${PRESS} 0`;
}

/** The team, the counts and the trigger, from nothing. */
export function setupLines(): string[] {
    return [
        `team remove ${TEAM}`,
        `team add ${TEAM}`,
        `team modify ${TEAM} nametagVisibility never`,
        `team modify ${TEAM} collisionRule never`,
        `team modify ${TEAM} friendlyFire true`,
        `scoreboard objectives remove ${PRESS}`,
        `scoreboard objectives add ${PRESS} trigger`,
        ...[DEALT, TAKEN].flatMap((objective, index) => [
            `scoreboard objectives remove ${objective}`,
            `scoreboard objectives add ${objective} minecraft.custom:minecraft.damage_${index === 0 ? "dealt" : "taken"}`
        ])
    ];
}

/** Bodies and labels: armor stands and the bodies' click boxes, by tag. */
export const BODY_TAG = "pe_im_body";
export const LABEL_TAG = "pe_im_label";

/** Every body gone, wherever it is: the head taken off first, so killing
 *  the stand drops nothing. Both spellings: one fails harmlessly. */
export const BODIES_OFF: readonly string[] = [
    `execute as @e[type=minecraft:armor_stand,tag=${BODY_TAG}] run item replace entity @s armor.head with minecraft:air`,
    `execute as @e[type=minecraft:armor_stand,tag=${BODY_TAG}] run replaceitem entity @s armor.head minecraft:air`,
    `kill @e[type=minecraft:armor_stand,tag=${BODY_TAG}]`,
    `kill @e[type=minecraft:interaction,tag=${BODY_TAG}]`
];

/** Every station's label gone. */
export const LABELS_OFF = `kill @e[type=minecraft:armor_stand,tag=${LABEL_TAG}]`;

/** Every body and label gone. */
export function entitiesOff(): string[] {
    return [...BODIES_OFF, LABELS_OFF];
}

export const TEARDOWN = [
    `team remove ${TEAM}`,
    ...[PRESS, DEALT, TAKEN].map((objective) => `scoreboard objectives remove ${objective}`),
    ...[LIVE_TAG, GHOST_TAG, IMPOSTOR_TAG].map((tag) => `tag @a[tag=${tag}] remove ${tag}`),
    ...hits.TAGS_OFF
];

/**
 * The teardown's tags taken off one player: what `TEARDOWN` could not reach on
 * somebody offline when the game ended. A ghost tag left on would keep their
 * chat to ghosts only.
 */
export function tagsOff(name: string): string[] {
    return [
        ...[LIVE_TAG, GHOST_TAG, IMPOSTOR_TAG].map((tag) => `tag ${name} remove ${tag}`),
        ...hits.tagsOff(name)
    ];
}

/** Onto the players' team, only if they are on none of the server's own. */
export function joinTeam(name: string): string {
    return `execute if entity @a[name=${name},team=] run team join ${TEAM} ${name}`;
}

/** In at "Go!": alive, and an impostor tagged as one. */
export function startLines(name: string, impostor: boolean): string[] {
    return [
        joinTeam(name),
        `tag ${name} add ${LIVE_TAG}`,
        `tag ${name} remove ${GHOST_TAG}`,
        impostor ? `tag ${name} add ${IMPOSTOR_TAG}` : `tag ${name} remove ${IMPOSTOR_TAG}`,
        `scoreboard players set ${name} ${PRESS} 0`
    ];
}

/** Nobody alive is hurt: a hit is a fifth of nothing, mended at once. */
export function unhurtLines(name: string): string[] {
    return [
        `effect give ${name} minecraft:resistance 3 3 true`,
        `effect give ${name} minecraft:regeneration 3 2 true`,
        `effect give ${name} minecraft:saturation 3 0 true`
    ];
}

/** Unable to hurt anybody: the crew, and an impostor whose kill waits. */
export function weakLine(name: string): string {
    return `effect give ${name} minecraft:weakness 3 100 true`;
}

/** An impostor whose kill is ready. */
export function armedLine(name: string): string {
    return `effect clear ${name} minecraft:weakness`;
}

/** Everybody alive may press the chat's buttons: again every look, since the
 *  game takes it back each time one is used. */
export const ENABLE_PRESS = `scoreboard players enable @a[tag=${LIVE_TAG}] ${PRESS}`;

/** Out of the game: watching, unseen, through walls. Their own game mode is
 *  given back when they go home. */
export function ghostLines(name: string): string[] {
    return [
        `tag ${name} remove ${LIVE_TAG}`,
        `tag ${name} add ${GHOST_TAG}`,
        `effect clear ${name}`,
        `gamemode spectator ${name}`
    ];
}

const IN = "execute in minecraft:overworld";

/**
 * Each look - and the quick look between - the station's switches and buttons,
 * and the emergency button, read where they stand: one pressed is credited to
 * the nearest player alive by `PRESS` (a crew member's task, or an impostor
 * pretending, which counts nothing), and a switch is flipped back for the
 * next.
 */
export function pressLines(layout: Layout): string[] {
    const y = layout.box.y1 + 2;
    const out: string[] = [];
    for (const station of layout.stations) {
        if (station.kind === "scan") continue;
        const at = `${station.x} ${y} ${station.z}`;
        const on = station.kind === "switch" ? SWITCH_ON : BUTTON_ON;
        out.push(
            `${IN} if block ${at} ${on} positioned ${station.x + 0.5} ${y} ${station.z + 0.5} run scoreboard players set @p[tag=${LIVE_TAG},distance=..4] ${PRESS} ${TASK_BASE + station.id}`
        );
        if (station.kind === "switch")
            out.push(`${IN} if block ${at} ${on} run setblock ${at} ${SWITCH_OFF} replace`);
    }
    const button = emergencyAt(layout);
    out.push(
        `${IN} if block ${button.x} ${button.y} ${button.z} ${EMERGENCY_ON} positioned ${button.x + 0.5} ${button.y} ${button.z + 0.5} run scoreboard players set @p[tag=${LIVE_TAG},distance=..4] ${PRESS} ${PRESSED_EMERGENCY}`
    );
    return out;
}

/** The tag of one body, by its place in `bodies`. */
export function bodyTag(index: number): string {
    return `pe_im_b${index}`;
}

/** A player head as this server writes an item. */
function headOf(name: string, era: Era): string {
    return era.components
        ? `minecraft:player_head[minecraft:profile={name:"${name}"}]`
        : `minecraft:player_head{SkullOwner:"${name}"}`;
}

/**
 * A body where somebody fell: a small stand, wearing their head, nothing taken
 * from it, and - from 1.19.4 - a box round it that a right-click on reports it.
 */
export function bodyLines(body: Body, index: number, era: Era): string[] {
    const at = `${(Math.floor(body.x) + 0.5).toFixed(1)} ${body.y.toFixed(1)} ${(Math.floor(body.z) + 0.5).toFixed(1)}`;
    const tags = `Tags:["${BODY_TAG}","${bodyTag(index)}"]`;
    const stand = `@e[type=minecraft:armor_stand,tag=${bodyTag(index)},limit=1]`;
    return [
        `${IN} run summon minecraft:armor_stand ${at} {${tags},Small:1b,NoGravity:1b,Invulnerable:1b,DisabledSlots:4144959,Rotation:[0f,0f]}`,
        era.itemCommand
            ? `item replace entity ${stand} armor.head with ${headOf(body.name, era)} 1`
            : `replaceitem entity ${stand} armor.head ${headOf(body.name, era)} 1`,
        ...(era.interaction
            ? [
                  `${IN} run summon minecraft:interaction ${at} {${tags},width:1.2f,height:1.2f,response:1b}`
              ]
            : [])
    ];
}

/** Every body still lying there, right-clicked since the last look: the one
 *  who clicked, if alive, is credited with reporting it. From 1.19.4. */
export function reportLines(bodies: readonly Body[], era: Era): string[] {
    if (!era.interaction) return [];
    const out: string[] = [];
    for (const [index, body] of bodies.entries()) {
        if (body.gone) continue;
        const box = `@e[type=minecraft:interaction,tag=${bodyTag(index)}]`;
        out.push(
            `execute as ${box} if data entity @s interaction on target run scoreboard players set @s[tag=${LIVE_TAG}] ${PRESS} ${REPORT_BASE + index}`,
            `execute as ${box} if data entity @s interaction run data remove entity @s interaction`
        );
    }
    return out;
}

/** The label over a station, in the server's own language. */
export function labelLine(station: Station, y: number, label: string, era: Era): string {
    return `${IN} run summon minecraft:armor_stand ${station.x + 0.5} ${y} ${station.z + 0.5} {Tags:["${LABEL_TAG}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b,CustomNameVisible:1b,CustomName:${customNameValue(label, era.modernText, "villager")}}`;
}

/** Whoever is a body's nearest living player within reach of it. */
export const REPORT_REACH = 3;

/**
 * A line to one player ending in buttons, each setting `PRESS` to its value
 * when clicked. Written in both spellings the game has used - `clickEvent` with
 * `value` before 1.21.5, `click_event` with `command` from it - and each
 * version reads its own. No hover, to keep a line short.
 */
export function buttonsLine(
    target: string,
    lead: string,
    buttons: readonly { label: string; color: string; value: number }[]
): string {
    const intro = JSON.parse(text(lead)) as unknown;
    const parts: unknown[] = ["", ...(Array.isArray(intro) ? intro : [intro])];
    for (const one of buttons) {
        const command = `/trigger ${PRESS} set ${one.value}`;
        parts.push(" ", {
            text: `[${one.label}]`,
            color: one.color,
            bold: true,
            clickEvent: { action: "run_command", value: command },
            click_event: { action: "run_command", command }
        });
    }
    return `tellraw ${target} ${asciiJson(JSON.stringify(parts))}`;
}

/** Candidates a ballot line carries at the most: a line stays within what one
 *  command can be with sixteen-letter names. */
export const BALLOT_PER_LINE = 3;

/** Where the season's pieces go (`arena-decor`): high in one wall of every
 *  other room, a full block in place of the wall's - nothing seen through,
 *  nothing in the way. */
export function decorSpots(layout: Layout): decor.Spot[] {
    const y = layout.box.y1 + geometryOf(layout.design).wall;
    return layout.rooms
        .filter((room) => room.index % 2 === 0)
        .map(
            (room): decor.Spot => ({
                x: room.x + 2,
                y,
                z: room.z,
                kind: "set",
                replaces: WALL_BLOCK
            })
        );
}
