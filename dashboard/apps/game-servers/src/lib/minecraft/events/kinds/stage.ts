/**
 * Events played on something Polaris builds in the sky - a parkour course, a
 * spleef floor - for the players who choose to take part, and takes down again.
 * A team duel and a build battle, played by sides with a kit, have an arena of
 * their own (`arena.ts`) under the same guarantees.
 *
 * Players have homes and belongings, and an event must never cost anybody either.
 * How that is kept, one rule at a time:
 *
 * - **Nothing of anybody's is changed.** The whole volume the structure will
 *   occupy is first proved to be empty air: it is filled with `structure_void`
 *   using `keep` (which only ever replaces air) and the game's count of blocks
 *   filled must equal the volume. Anything short of that - a treetop, a
 *   mountain, somebody's sky base - and the probe is taken out again and the
 *   place given up. Only then is anything built, and again with `keep`.
 * - **Nothing is removed that the event did not place.** Every box it fills is
 *   written into the run state before it is filled, and taken out with
 *   `fill <box> air replace <the block it used>`: inside its own box, and only
 *   where that block still is.
 * - **Nobody is moved who did not ask.** A player takes part by typing `join`
 *   (or `unirse`) in the chat; their exact position, facing, world and game mode
 *   are written down before they are moved, and they are sent back there at the
 *   end, on a cancel, on a failure and after a restart - or, if they were
 *   offline by then, the first time they are back on.
 * - **Nobody can die, or lose anything.** Inside it every player has
 *   Resistance V (no damage at all, falls included) and is in adventure mode, so
 *   they can neither break nor place anything but the event's own floor. A fall
 *   lands on a net a few blocks down and is undone on the next look. Any
 *   creature on it that is not a player - a dog that followed its owner up -
 *   has slow falling, and is given it again before the arena is taken down, so
 *   it floats to the ground. The only item handed out carries a
 *   `polaris_event` marker, and only items with that marker are ever cleared.
 *
 * Pure: every line is a function of what it is given, so all of it is asserted
 * in tests. What must survive a restart - the boxes, the saved positions, the
 * players - is in `stageSchema`, kept on the run and, once the run is over,
 * as a `Leftover` until every last part of it is settled.
 */

import { z } from "zod";
import { PLAYER_NAME } from "../catalog";
import { stripFormatting } from "../../parse";
import { CHAT_LINE, text } from "../commands";
import { stashSchema } from "./stash";

/** Every block an arena is ever built of - and so every block it may remove. */
export const ARENA_BLOCKS = [
    "minecraft:structure_void",
    "minecraft:white_concrete",
    "minecraft:light_blue_concrete",
    "minecraft:lime_concrete",
    "minecraft:yellow_concrete",
    "minecraft:light_weighted_pressure_plate",
    "minecraft:white_stained_glass",
    "minecraft:light_blue_stained_glass",
    "minecraft:snow_block"
] as const;

export type ArenaBlock = (typeof ARENA_BLOCKS)[number];

/** The block the volume is proved empty with: one nobody builds with. */
export const PROBE_BLOCK: ArenaBlock = "minecraft:structure_void";

/** The tag every player inside an arena carries, and only while inside. */
export const IN_ARENA = "pe_in";

/** The most one `fill` may change: the game's own default limit. */
export const FILL_LIMIT = 32_768;

const DIMENSION = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

const boxSchema = z.object({
    x1: z.number().int(),
    y1: z.number().int(),
    z1: z.number().int(),
    x2: z.number().int(),
    y2: z.number().int(),
    z2: z.number().int(),
    block: z.enum(ARENA_BLOCKS)
});

/** A box of blocks, corners included, and what it is (or will be) filled with. */
export type Box = z.infer<typeof boxSchema>;

/** A box with nothing in it yet: the volume an arena takes up. */
export type Volume = Omit<Box, "block">;

const areaSchema = z.object({
    x1: z.number().int(),
    z1: z.number().int(),
    x2: z.number().int(),
    z2: z.number().int()
});

/** The columns kept loaded while an arena stands. */
export type Area = z.infer<typeof areaSchema>;

const savedSchema = z.object({
    name: z.string().regex(PLAYER_NAME),
    dimension: z.string().regex(DIMENSION),
    x: z.number(),
    y: z.number(),
    z: z.number(),
    yaw: z.number(),
    pitch: z.number(),
    mode: z.enum(["survival", "adventure"]),
    /** What they carried, kept in barrels until it is given back (`stash`). */
    stash: stashSchema.nullable().default(null)
});

/** Where a player was, and how they were playing, before they were moved. */
export type Saved = z.infer<typeof savedSchema>;

const racerSchema = z.object({
    name: z.string().regex(PLAYER_NAME),
    /** When they were brought in, which a parkour time counts from. */
    since: z.number(),
    /** Parkour: the furthest platform they have stood on. */
    best: z.number().int().default(0),
    /** Parkour: the checkpoint a fall sends them back to (a platform index). */
    checkpoint: z.number().int().default(0),
    finishedAt: z.number().nullable().default(null),
    /** Out of it: fell through a spleef floor, typed `leave`, or went away. */
    outAt: z.number().nullable().default(null),
    /** Spleef: the points they went out with. */
    points: z.number().int().default(0)
});

export type Racer = z.infer<typeof racerSchema>;

export const stageSchema = z.object({
    /** Who typed `join` and has not been brought in yet. */
    joined: z.array(z.string().regex(PLAYER_NAME)).default([]),
    /** The column it stands over and the height it is built at, once placed. */
    origin: z
        .object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
        .nullable()
        .default(null),
    area: areaSchema.nullable().default(null),
    /** Every box filled so far, in the order it was filled - written down first. */
    boxes: z.array(boxSchema).default([]),
    built: z.boolean().default(false),
    /** Ticks spent waiting for the area to load before it can be probed. */
    waits: z.number().int().default(0),
    /** The players inside, until each one is sent back. */
    saved: z.array(savedSchema).default([]),
    racers: z.array(racerSchema).default([]),
    /** Spleef: when the shovels are handed out, and whether they have been. */
    goAt: z.number().nullable().default(null),
    armed: z.boolean().default(false)
});

export type StageState = z.infer<typeof stageSchema>;

export const EMPTY_STAGE: StageState = stageSchema.parse({});

/**
 * What an arena left behind when its event ended and could not be settled on
 * the spot: boxes still standing, players still owed a trip back. Kept in the
 * event state, apart from the run, and settled by the minute sweep.
 */
export const stageLeftoverSchema = z.object({
    runId: z.string(),
    area: areaSchema.nullable(),
    boxes: z.array(boxSchema),
    saved: z.array(savedSchema),
    /** The chunks held before the event, which letting its area go must spare. */
    keepForced: z.array(z.string()).nullable().default(null)
});

export type Leftover = z.infer<typeof stageLeftoverSchema>;

/** Everything of an arena that still has to be undone, or null when nothing does. */
export function leftoverOf(
    runId: string,
    arena: StageState | null,
    keepForced: readonly string[] | null = null
): Leftover | null {
    if (!arena) return null;
    if (arena.boxes.length === 0 && arena.saved.length === 0 && !arena.area) return null;
    return {
        runId,
        area: arena.area,
        boxes: arena.boxes,
        saved: arena.saved,
        keepForced: keepForced ? [...keepForced] : null
    };
}

/** The list with this leftover in it - in place of an older copy of the same run's. */
export function withLeftover(list: readonly Leftover[], leftover: Leftover | null): Leftover[] {
    const rest = list.filter((one) => one.runId !== leftover?.runId);
    return leftover ? [...rest, leftover] : rest;
}

// ------------------------------------------------------------------ server flavour

/** How this server's version spells marked items, and how high it may build. */
export interface Flavour {
    /** `components` from 1.20.5 (`item[custom_data=...]`), `nbt` before. */
    readonly items: "components" | "nbt";
    /** The highest block a structure may reach: 319 from 1.18, 255 before. */
    readonly top: number;
}

// ------------------------------------------------------------------ boxes

const WORLD = "execute in minecraft:overworld run";

function corners(box: Volume): string {
    return `${box.x1} ${box.y1} ${box.z1} ${box.x2} ${box.y2} ${box.z2}`;
}

export function volumeOf(box: Volume): number {
    return (
        (Math.abs(box.x2 - box.x1) + 1) *
        (Math.abs(box.y2 - box.y1) + 1) *
        (Math.abs(box.z2 - box.z1) + 1)
    );
}

/** A box cut into horizontal slabs, each within what one `fill` may change. */
export function slices<T extends Volume>(box: T, limit = FILL_LIMIT): T[] {
    const layer = (box.x2 - box.x1 + 1) * (box.z2 - box.z1 + 1);
    const tall = Math.max(1, Math.floor(limit / layer));
    const cut: T[] = [];
    for (let y = box.y1; y <= box.y2; y += tall) {
        cut.push({ ...box, y1: y, y2: Math.min(box.y2, y + tall - 1) });
    }
    return cut;
}

/** The boxes that prove a volume empty: each fills only air, and its count says how much was. */
export function probeBoxes(volume: Volume): Box[] {
    return slices({ ...volume, block: PROBE_BLOCK });
}

/** Built into air only: `keep` never replaces anything that is there. */
export function buildLine(box: Box): string {
    return `${WORLD} fill ${corners(box)} ${box.block} keep`;
}

/** Taken out only where the block is still the one that was put there. */
export function removeLine(box: Box): string {
    return `${WORLD} fill ${corners(box)} minecraft:air replace ${box.block}`;
}

/**
 * How many blocks a `fill` changed: `Successfully filled 25 block(s)`, or none
 * (`No blocks were filled`). Null when it did not run at all - the area was not
 * loaded, the box was too big, the block unknown - which is never read as a count.
 */
export function fillCount(output: string): number | null {
    const plain = stripFormatting(output);
    const filled = /filled (\d+)/i.exec(plain);
    if (filled) return Number(filled[1]);
    if (/no blocks were filled/i.test(plain)) return 0;
    return null;
}

/** The columns under a volume, to keep loaded while it stands. */
export function areaOf(volume: Volume): Area {
    return {
        x1: Math.min(volume.x1, volume.x2),
        z1: Math.min(volume.z1, volume.z2),
        x2: Math.max(volume.x1, volume.x2),
        z2: Math.max(volume.z1, volume.z2)
    };
}

/** The smallest volume holding every box, and the room above the top one. */
export function boundsOf(boxes: readonly Volume[]): Volume | null {
    if (boxes.length === 0) return null;
    return {
        x1: Math.min(...boxes.map((box) => Math.min(box.x1, box.x2))),
        y1: Math.min(...boxes.map((box) => Math.min(box.y1, box.y2))),
        z1: Math.min(...boxes.map((box) => Math.min(box.z1, box.z2))),
        x2: Math.max(...boxes.map((box) => Math.max(box.x1, box.x2))),
        y2: Math.max(...boxes.map((box) => Math.max(box.y1, box.y2))) + 3,
        z2: Math.max(...boxes.map((box) => Math.max(box.z1, box.z2)))
    };
}

/**
 * Slow falling for every creature in a volume that is not a player: a dog that
 * followed its owner up, a mob that wandered onto the floor. Nothing standing on
 * an arena falls hard - not while it lasts, and not when it is taken down.
 */
export function floatDown(volume: Volume, seconds: number): string {
    const dx = Math.abs(volume.x2 - volume.x1);
    const dy = Math.abs(volume.y2 - volume.y1);
    const dz = Math.abs(volume.z2 - volume.z1);
    const at = `x=${Math.min(volume.x1, volume.x2)},y=${Math.min(volume.y1, volume.y2)},z=${Math.min(volume.z1, volume.z2)}`;
    return `${WORLD} effect give @e[type=!player,${at},dx=${dx},dy=${dy},dz=${dz}] minecraft:slow_falling ${seconds} 0 true`;
}

/**
 * Nothing that happens to them for a few seconds can make them fall to their
 * death: slow falling takes fall damage away, Resistance V the rest. Given
 * before anybody is moved off anything an event built, and before any of it
 * comes down.
 */
export function fallProof(selector: string, seconds = 10): string[] {
    return [
        `effect give ${selector} minecraft:slow_falling ${seconds} 0 true`,
        `effect give ${selector} minecraft:resistance ${seconds} 4 true`
    ];
}

/** The same for everything in a volume and over it, players included: what is
 *  still up there when it is taken down floats to the ground. */
export function fallProofOver(volume: Volume, seconds = 10): string[] {
    const dx = Math.abs(volume.x2 - volume.x1);
    const dz = Math.abs(volume.z2 - volume.z1);
    const y = Math.min(volume.y1, volume.y2);
    const dy = Math.abs(volume.y2 - volume.y1) + 64;
    const at = `x=${Math.min(volume.x1, volume.x2)},y=${y},z=${Math.min(volume.z1, volume.z2)},dx=${dx},dy=${dy},dz=${dz}`;
    return [
        `${WORLD} effect give @e[${at}] minecraft:slow_falling ${seconds} 0 true`,
        `${WORLD} effect give @e[${at}] minecraft:resistance ${seconds} 4 true`
    ];
}

export function holdArea(area: Area): string {
    return `${WORLD} forceload add ${area.x1} ${area.z1} ${area.x2} ${area.z2}`;
}

export function releaseArea(area: Area): string {
    return `${WORLD} forceload remove ${area.x1} ${area.z1} ${area.x2} ${area.z2}`;
}

// ------------------------------------------------------------------ joining

export type Call = "join" | "leave";

const CALLS: Readonly<Record<string, Call>> = {
    join: "join",
    unirse: "join",
    unirme: "join",
    leave: "leave",
    salir: "leave",
    salirme: "leave"
};

/**
 * Who asked to join or leave in a stretch of the server log: `join` or `unirse`,
 * `leave` or `salir`, alone on the line, in any case, with a `!` in front or
 * a full stop after if they like. Anything else said in the chat is not a call.
 */
export function readCalls(log: string): { name: string; call: Call }[] {
    const found: { name: string; call: Call }[] = [];
    for (const match of log.matchAll(CHAT_LINE)) {
        const word = (match[2] as string)
            .trim()
            .toLowerCase()
            .replace(/^[!.]+/, "")
            .replace(/[.!]+$/, "");
        const call = CALLS[word];
        if (call) found.push({ name: match[1] as string, call });
    }
    return found;
}

// ------------------------------------------------------------------ who is where

/** Where everybody inside is. */
export const ARENA_WHERE = `execute as @a[tag=${IN_ARENA}] run data get entity @s Pos`;
/** Which world everybody inside is in - a `/home` or a death takes them out of it. */
export const ARENA_DIMENSIONS = `execute as @a[tag=${IN_ARENA}] run data get entity @s Dimension`;
/** How everybody on is playing: `Alice has the following entity data: 0`. */
export const GAME_MODES = "execute as @a run data get entity @s playerGameType";

export function readGameModes(output: string): Map<string, number> {
    const found = new Map<string, number>();
    const pattern = /(\.?[A-Za-z0-9_]{1,16}) has the following entity data: (-?\d+)(?![\d.])/g;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        found.set(match[1] as string, Number(match[2]));
    }
    return found;
}

/**
 * A player's spot as it is now, to send them back to - or null when they cannot
 * take part: not on, in a world that could not be read, or in creative or
 * spectator (0 is survival, 2 adventure).
 */
export function savedFrom(
    name: string,
    where: readonly { name: string; x: number; y: number; z: number }[],
    facing: ReadonlyMap<string, { yaw: number; pitch: number }>,
    dimensions: ReadonlyMap<string, string>,
    modes: ReadonlyMap<string, number>
): Saved | null {
    const at = where.find((one) => one.name.toLowerCase() === name.toLowerCase());
    if (!at || !PLAYER_NAME.test(at.name)) return null;
    const mode = modes.get(at.name);
    if (mode !== 0 && mode !== 2) return null;
    const dimension = dimensions.get(at.name);
    if (!dimension || !DIMENSION.test(dimension)) return null;
    const turned = facing.get(at.name) ?? { yaw: 0, pitch: 0 };
    return {
        name: at.name,
        dimension,
        x: at.x,
        y: at.y,
        z: at.z,
        yaw: turned.yaw,
        pitch: turned.pitch,
        mode: mode === 0 ? "survival" : "adventure",
        stash: null
    };
}

const coordinate = (value: number) => value.toFixed(3);

/** No damage of any kind for the next ten seconds - a fall included. Given again
 *  every tick while inside, so it never runs out there and wears off soon after. */
export function protect(selector: string): string {
    return `effect give ${selector} minecraft:resistance 10 4 true`;
}

export const PROTECT_INSIDE = protect(`@a[tag=${IN_ARENA}]`);
/** Kept fed, so a long course never leaves anybody too hungry to sprint. */
export const FEED_INSIDE = `effect give @a[tag=${IN_ARENA}] minecraft:saturation 1 0 true`;

/** A spot to stand on inside an arena, and which way to face. */
export interface Spot {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly yaw: number;
}

/** Into the arena, protected first: tagged as inside before they are moved -
 *  so nobody is ever in it untagged, and taken for back already - then in
 *  adventure mode. */
export function admitLines(name: string, spot: Spot): string[] {
    return [
        protect(name),
        `tag ${name} add ${IN_ARENA}`,
        `${WORLD} tp ${name} ${coordinate(spot.x)} ${coordinate(spot.y)} ${coordinate(spot.z)} ${spot.yaw.toFixed(1)} 0.0`,
        `gamemode adventure ${name}`
    ];
}

/** Moved to a spot inside, for somebody already in - a fall undone. */
export function moveLine(name: string, spot: Spot): string {
    return `${WORLD} tp ${name} ${coordinate(spot.x)} ${coordinate(spot.y)} ${coordinate(spot.z)} ${spot.yaw.toFixed(1)} 0.0`;
}

/** Back to exactly where they were: the answer says whether it reached them. */
export function returnLine(saved: Saved): string {
    return `execute in ${saved.dimension} run tp ${saved.name} ${coordinate(saved.x)} ${coordinate(saved.y)} ${coordinate(saved.z)} ${saved.yaw.toFixed(1)} ${saved.pitch.toFixed(1)}`;
}

export function returned(output: string): boolean {
    return /teleported/i.test(stripFormatting(output));
}

/**
 * Everything else about being back: the event's own items taken (and nothing
 * else), the game mode they had, the tag off, and a few seconds more of
 * protection - somebody who joined mid-air lands safely where they left.
 */
export function afterReturnLines(saved: Saved, items: Flavour["items"], note: string): string[] {
    return [
        clearMarked(saved.name, items),
        `gamemode ${saved.mode} ${saved.name}`,
        `tag ${saved.name} remove ${IN_ARENA}`,
        protect(saved.name),
        `tellraw ${saved.name} ${text(note)}`
    ];
}

// ------------------------------------------------------------------ marked items

/**
 * The spleef shovel: breaks the snow floor and nothing else, even in adventure
 * mode, and carries the event's marker. From 1.20.5 its tool rules also mean the
 * snow drops nothing, so nobody leaves with a pocket of snowballs.
 */
export function markedShovel(name: string, items: Flavour["items"]): string {
    return items === "components"
        ? `give ${name} minecraft:iron_shovel[minecraft:custom_data={polaris_event:1b},minecraft:can_break={blocks:"minecraft:snow_block"},minecraft:tool={rules:[{blocks:"minecraft:snow_block",speed:15.0f,correct_for_drops:false}]}] 1`
        : `give ${name} minecraft:iron_shovel{polaris_event:1b,CanDestroy:["minecraft:snow_block"]} 1`;
}

/** Only what the event handed out, by its marker: never anything of the player's. */
export function clearMarked(name: string, items: Flavour["items"]): string {
    return items === "components"
        ? `clear ${name} *[minecraft:custom_data={polaris_event:1b}]`
        : `clear ${name} minecraft:iron_shovel{polaris_event:1b}`;
}
