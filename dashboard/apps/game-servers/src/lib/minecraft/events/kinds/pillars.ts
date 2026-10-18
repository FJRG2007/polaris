/**
 * Pillars: every player alone on a pillar in a ring, an item each every few
 * seconds, and the last one left wins.
 *
 * The ring is one pillar a player, spaced so no jump reaches the next one (a
 * player bridges with what they are given), round an optional small platform
 * in the middle. A pillar is one block wide and `PILLAR_DEPTH` tall: a bedrock
 * top to stand on, a shaft of stone bricks and a sea lantern at its foot, so
 * the ring reads as built rather than a row of bare posts; the middle is a
 * small floor round a gold block. Under the play area a barrier floor spans
 * the whole box, so water, lava and whatever falls stay inside it and come
 * down with the arena.
 *
 * Kept short on purpose: the box is what the site is counted, built and taken
 * down over (`arena-service`), block kind by block kind, so every layer of it
 * is time at the start and at the end. A drop of `PILLAR_DEPTH` is as final as
 * a long one - under the pillars is out - and the void has that much less to
 * climb before it ends the game.
 *
 * The items come from a weighted pool (`POOLS`): a balanced mix, blocks only,
 * or chaos. They are handed out inside the server by the events data pack
 * (`FUNCTIONS`, `LOOT_TABLES`): every `interval` seconds each player still in
 * rolls the pool's loot table once - one command for everybody, no round trip
 * per player. Where the pack is not on, the loop gives the same draws itself,
 * every player's in one batch (`dropLines`). Every item is marked as the kit,
 * so only it is taken back and a player's own things, stashed on the way in,
 * are given back untouched.
 *
 * Out is out, as in SkyWars: dead, fallen under the pillars, past the play
 * area, or caught by the void, which starts rising after `voidAfter` minutes
 * and reaches the pillars' tops within `PILLAR_DEPTH` seconds, so a game always
 * ends. Optional twists (`TWISTS`) stir the game up now and then.
 *
 * Pure; the loop is `pillars-service.ts`.
 */

import { z } from "zod";
import type { Spot } from "./arena";
import * as decor from "./arena-decor";
import { seeded } from "../trivia-bank";
import type { Fill } from "./arena-game";
import type { Box, Marker } from "../state";
import type { EventOptions } from "../catalog";

/** The layout's version, written into the run when it is built. 2: the
 *  shorter, themed pillars. */
export const DESIGN = 2;

/** How many can play: a pillar each. */
export const MOST = 16;

/** Blocks from one pillar to the next along the ring, at the least: four of
 *  air, past any jump. */
const SPACING = 6;
/** The ring's radius, at the least. */
const LEAST_RING = 10;
/** How far a pillar reaches down from its top. */
export const PILLAR_DEPTH = 10;
/** The middle platform's half width. */
const MIDDLE_HALF = 1;
/** Room round the ring that is still the play area. */
const PAD = 6;
/** How far under the pillars' feet the play area goes, and over their tops. */
const BELOW = 2;
const ABOVE = 10;
/** Design 1's pillars and the room over them, kept for a run built on it. */
const DEPTH_1 = 24;
const ABOVE_1 = 16;
/** Room past the play area to the box's wall (`sky-wars.MARGIN`). */
export const MARGIN = 12;
const GALLERY_LIFT = 3;
const GALLERY_HALF = 3;

const BEDROCK = "minecraft:bedrock";
const BARRIER = "minecraft:barrier";
/** A pillar's shaft and the light at its foot. Every block here is one every
 *  release since 1.13 knows. */
const SHAFT = "minecraft:stone_bricks";
const FOOT = "minecraft:sea_lantern";
const MIDDLE = "minecraft:polished_andesite";
const MIDDLE_HEART = "minecraft:gold_block";

export type Pool = EventOptions<"pillars">["pool"];

// ------------------------------------------------------------------ the items

export interface Drop {
    readonly id: string;
    readonly count: number;
    /** What the potion holds, for a potion. */
    readonly potion?: string;
    /** Its weight in each pool; 0 or absent is never drawn. */
    readonly weights: Readonly<Partial<Record<Pool, number>>>;
}

const both = (balanced: number, chaos: number, blocks = 0) => ({ balanced, chaos, blocks });

/**
 * Everything a pillar can hand out, with its weight in each pool. Only items
 * every release since 1.13 knows, so no loot table fails to load. No falling
 * blocks (sand would fall out of the box) and no eggs (a chick hatches and
 * stays). Nothing that leaves an unmarked item behind once used either - a
 * bucket emptied, a potion drunk - since only marked items are ever taken
 * back: the potions are splash potions, and there are no buckets.
 */
export const DROPS: readonly Drop[] = [
    // Blocks: the way across.
    { id: "minecraft:oak_planks", count: 16, weights: both(14, 8, 20) },
    { id: "minecraft:cobblestone", count: 16, weights: both(12, 6, 20) },
    { id: "minecraft:white_wool", count: 16, weights: both(10, 6, 16) },
    { id: "minecraft:oak_log", count: 4, weights: both(4, 2, 8) },
    { id: "minecraft:glass", count: 8, weights: both(3, 2, 8) },
    { id: "minecraft:ladder", count: 8, weights: both(4, 2, 6) },
    { id: "minecraft:slime_block", count: 2, weights: both(2, 3, 4) },
    { id: "minecraft:cobweb", count: 2, weights: both(2, 4, 3) },
    { id: "minecraft:obsidian", count: 2, weights: both(1, 2, 3) },
    // Weapons.
    { id: "minecraft:wooden_sword", count: 1, weights: both(3, 2) },
    { id: "minecraft:stone_sword", count: 1, weights: both(3, 2) },
    { id: "minecraft:iron_sword", count: 1, weights: both(1, 2) },
    { id: "minecraft:stone_axe", count: 1, weights: both(2, 1) },
    { id: "minecraft:bow", count: 1, weights: both(2, 3) },
    { id: "minecraft:arrow", count: 8, weights: both(3, 4) },
    { id: "minecraft:snowball", count: 8, weights: both(4, 5) },
    { id: "minecraft:fishing_rod", count: 1, weights: both(2, 3) },
    { id: "minecraft:shield", count: 1, weights: both(1, 1) },
    // Tools and armor.
    { id: "minecraft:wooden_pickaxe", count: 1, weights: both(2, 1) },
    { id: "minecraft:shears", count: 1, weights: both(1, 1) },
    { id: "minecraft:chainmail_helmet", count: 1, weights: both(1, 1) },
    { id: "minecraft:iron_chestplate", count: 1, weights: both(1, 1) },
    // Getting about.
    { id: "minecraft:ender_pearl", count: 1, weights: both(3, 5) },
    { id: "minecraft:chorus_fruit", count: 2, weights: both(1, 3) },
    // Potions.
    { id: "minecraft:splash_potion", count: 1, potion: "minecraft:swiftness", weights: both(1, 2) },
    { id: "minecraft:splash_potion", count: 1, potion: "minecraft:leaping", weights: both(1, 2) },
    { id: "minecraft:splash_potion", count: 1, potion: "minecraft:healing", weights: both(1, 1) },
    {
        id: "minecraft:splash_potion",
        count: 1,
        potion: "minecraft:slow_falling",
        weights: both(1, 2)
    },
    { id: "minecraft:splash_potion", count: 1, potion: "minecraft:harming", weights: both(0, 2) },
    // Food.
    { id: "minecraft:bread", count: 3, weights: both(3, 1) },
    { id: "minecraft:cooked_beef", count: 2, weights: both(2, 1) },
    { id: "minecraft:golden_apple", count: 1, weights: both(1, 2) },
    // Chaos only.
    { id: "minecraft:tnt", count: 1, weights: both(0, 3) },
    { id: "minecraft:flint_and_steel", count: 1, weights: both(0, 2) }
];

/** The draws a pool can make, with their weights. */
export function poolOf(pool: Pool): { drop: Drop; weight: number }[] {
    return DROPS.map((drop) => ({ drop, weight: drop.weights[pool] ?? 0 })).filter(
        (one) => one.weight > 0
    );
}

/** One weighted draw from a pool. */
export function draw(pool: Pool, random: () => number): Drop {
    const entries = poolOf(pool);
    const total = entries.reduce((sum, one) => sum + one.weight, 0);
    let left = random() * total;
    for (const one of entries) {
        left -= one.weight;
        if (left < 0) return one.drop;
    }
    return entries.at(-1)!.drop;
}

/** Every item any pool hands out, as bare ids: the kit taken back. */
export const KIT_IDS: readonly string[] = [...new Set(DROPS.map((one) => one.id))];

/** The marker every item carries (`arena.marked`). */
const MARK = "polaris_event:1b";

/** One draw as an item argument this server reads. */
export function itemOf(drop: Drop, marker: Marker): string {
    if (marker === "components") {
        const parts = [`minecraft:custom_data={${MARK}}`];
        if (drop.potion) parts.push(`minecraft:potion_contents={potion:"${drop.potion}"}`);
        return `${drop.id}[${parts.join(",")}]`;
    }
    return `${drop.id}{${MARK}${drop.potion ? `,Potion:"${drop.potion}"` : ""}}`;
}

/** The fallback: one draw for each player still in, all given in one batch. */
export function dropLines(
    seed: string,
    round: number,
    names: readonly string[],
    pool: Pool,
    marker: Marker
): string[] {
    return names.map((name) => {
        const drop = draw(pool, seeded(`${seed}-drop-${round}-${name.toLowerCase()}`));
        return `give ${name} ${itemOf(drop, marker)} ${drop.count}`;
    });
}

/** A pool's loot table, the way this server's era writes an item's data. */
export function lootTable(pool: Pool, marker: Marker): Record<string, unknown> {
    return {
        pools: [
            {
                rolls: 1,
                entries: poolOf(pool).map(({ drop, weight }) => {
                    const functions: Record<string, unknown>[] = [];
                    if (drop.count > 1)
                        functions.push({ function: "minecraft:set_count", count: drop.count });
                    if (marker === "components") {
                        functions.push({ function: "minecraft:set_custom_data", tag: `{${MARK}}` });
                        if (drop.potion)
                            functions.push({ function: "minecraft:set_potion", id: drop.potion });
                    } else
                        functions.push({
                            function: "minecraft:set_nbt",
                            tag: `{${MARK}${drop.potion ? `,Potion:"${drop.potion}"` : ""}}`
                        });
                    return { type: "minecraft:item", name: drop.id, weight, functions };
                })
            }
        ]
    };
}

export const POOLS = ["balanced", "blocks", "chaos"] as const satisfies readonly Pool[];

/**
 * The loot tables in the events pack, by their name under `polaris:pillars/`.
 * Two eras, because what marks an item changed: `set_nbt` up to 1.20.4,
 * `set_custom_data` and `set_potion` from 1.20.5 (`set_potion` is 1.18+, so
 * the older tables write the potion into the item's data instead). A release
 * loads only the tables whose functions it knows; the rest are logged and
 * skipped.
 */
export const LOOT_TABLES: Readonly<Record<string, Record<string, unknown>>> = Object.fromEntries(
    POOLS.flatMap((pool) => [
        [`${pool}_components`, lootTable(pool, "components")],
        [`${pool}_tag`, lootTable(pool, "tag")]
    ])
);

// ------------------------------------------------------------------ the pack

/** Its scores. At most 16 characters, for the oldest releases. */
export const OBJECTIVE = "polaris_pillar";
/** Who is in and still standing: the pack hands items only to them. */
export const IN_TAG = "pe_pi_in";
/** Who is out, so the quick look leaves them be. */
export const OUT_TAG = "pe_pi_out";
/** Who the quick look found past the play area, for the tick to put out. */
export const GONE_TAG = "pe_pi_gone";
/** Who the quick look found under the risen void, so the tick says so. */
export const VOID_TAG = "pe_pi_void";

const TARGET = `@a[tag=${IN_TAG},tag=!${OUT_TAG}]`;

/** One era's rolls: each player still in rolls the pool's table once -
 *  `execute as`, so each rolls their own. */
function rollLines(era: Marker): string[] {
    return POOLS.map(
        (pool, index) =>
            `execute if score #pool ${OBJECTIVE} matches ${index} as ${TARGET} run loot give @s loot polaris:pillars/${pool}_${era}`
    );
}

/** What everybody still standing sees and hears as an item lands: the pop of a
 *  pickup and a few green sparks round them. Played by the pack at each drop,
 *  and by the loop with its own where the pack is not on. */
export const DROP_FEEDBACK: readonly string[] = [
    `execute as ${TARGET} at @s run playsound minecraft:entity.item.pickup player @s ~ ~ ~ 0.6 1.4`,
    `execute as ${TARGET} at @s run particle minecraft:happy_villager ~ ~1 ~ 0.4 0.5 0.4 0 8`
];

/**
 * The pack's part: with the switch on, a countdown of game ticks, and at zero
 * one roll of the pool for each player still in. Bounded by the players in
 * it, `MOST` at the most.
 *
 * Each era's rolls are a function of their own. From 1.20.5 a function is
 * refused whole when one of its lines names a loot table that is not loaded,
 * and only one era's tables load on any release (`LOOT_TABLES`); a function
 * named by another is looked up only when it runs, so the other era's file
 * failing to load costs nothing.
 */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [`execute if score #on ${OBJECTIVE} matches 1 run function polaris:pillars/run`],
    run: [
        `scoreboard players remove #left ${OBJECTIVE} 1`,
        `execute if score #left ${OBJECTIVE} matches ..0 run function polaris:pillars/drop`
    ],
    drop: [
        `scoreboard players operation #left ${OBJECTIVE} = #every ${OBJECTIVE}`,
        `execute if score #era ${OBJECTIVE} matches 1 run function polaris:pillars/drop_components`,
        `execute if score #era ${OBJECTIVE} matches 0 run function polaris:pillars/drop_tag`,
        ...DROP_FEEDBACK
    ],
    drop_components: rollLines("components"),
    drop_tag: rollLines("tag")
};

/** Game ticks between two drops. */
export function intervalTicks(seconds: number): number {
    return Math.max(20, Math.round(seconds * 20));
}

/** Switched on at "Go!": the interval, the pool, the era, the first drop at
 *  once, then the switch. */
export function armLines(seconds: number, pool: Pool, marker: Marker): string[] {
    const set = (name: string, value: number) =>
        `scoreboard players set #${name} ${OBJECTIVE} ${value}`;
    return [
        `scoreboard objectives add ${OBJECTIVE} dummy`,
        set("on", 0),
        set("every", intervalTicks(seconds)),
        set("left", 1),
        set("pool", POOLS.indexOf(pool)),
        set("era", marker === "components" ? 1 : 0),
        set("on", 1)
    ];
}

/** One more drop at the next game tick: a twist. */
export const DROP_NOW = `scoreboard players set #left ${OBJECTIVE} 1`;

/** Switched off. Safe when it was never on. */
export const STOP_LINES: readonly string[] = [
    `scoreboard players set #on ${OBJECTIVE} 0`,
    `tag @a remove ${IN_TAG}`,
    `tag @a remove ${OUT_TAG}`,
    `tag @a remove ${GONE_TAG}`,
    `tag @a remove ${VOID_TAG}`
];

// ------------------------------------------------------------------ the ring

export interface Layout {
    /** One pillar a player, from the ring's middle. */
    readonly pillars: readonly { x: number; z: number }[];
    readonly ring: number;
    readonly middle: boolean;
    /** How far a pillar reaches down, and the play area over their tops: the
     *  run's own design's. */
    readonly depth: number;
    readonly above: number;
}

/** A design's pillar depth and room over the tops: a run built on an older
 *  one keeps its own. */
function shapeOf(design: number): { depth: number; above: number } {
    return design >= 2 ? { depth: PILLAR_DEPTH, above: ABOVE } : { depth: DEPTH_1, above: ABOVE_1 };
}

export function layoutFor(players: number, middle: boolean, design = DESIGN): Layout {
    const count = Math.max(2, Math.min(MOST, players));
    const ring = Math.max(LEAST_RING, Math.ceil(SPACING / (2 * Math.sin(Math.PI / count))));
    const pillars = Array.from({ length: count }, (_, index) => {
        const angle = (2 * Math.PI * index) / count;
        return { x: Math.round(Math.sin(angle) * ring), z: Math.round(-Math.cos(angle) * ring) };
    });
    return { pillars, ring, middle, ...shapeOf(design) };
}

/** Where the ring stands: its middle, at the pillars' top. */
export interface Placed {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** The pillars' top over the ground found: `height` up, but never so low that
 *  the box under them reaches the ground. */
export function topOver(ground: number, height: number, design = DESIGN): number {
    return ground + Math.max(height, shapeOf(design).depth + BELOW + MARGIN + 2);
}

export function playArea(layout: Layout, at: Placed): Box {
    const reach = layout.ring + PAD;
    return {
        x1: at.x - reach,
        y1: at.y - layout.depth - BELOW,
        z1: at.z - reach,
        x2: at.x + reach,
        y2: at.y + layout.above,
        z2: at.z + reach
    };
}

export function galleryFloor(layout: Layout, at: Placed): Box {
    const y = playArea(layout, at).y2 + GALLERY_LIFT;
    return {
        x1: at.x - GALLERY_HALF,
        y1: y,
        z1: at.z - GALLERY_HALF,
        x2: at.x + GALLERY_HALF,
        y2: y,
        z2: at.z + GALLERY_HALF
    };
}

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

export function reachOf(layout: Layout): number {
    return layout.ring + PAD + MARGIN;
}

/** The barrier floor at the box's bottom, the gallery, the middle, then each
 *  pillar foot, shaft and top - its top last, the block whose being there
 *  proves the build went in (`arena-service.raise`). */
export function arenaFills(layout: Layout, at: Placed): Fill[] {
    const box = arenaBox(layout, at);
    const fills: Fill[] = [
        { box: { ...box, y2: box.y1 }, block: BARRIER },
        { box: galleryFloor(layout, at), block: BARRIER }
    ];
    const column = (x: number, z: number, y1: number, y2: number, block: string): Fill => ({
        box: { x1: x, y1, z1: z, x2: x, y2, z2: z },
        block
    });
    const foot = at.y - layout.depth + 1;
    if (layout.middle)
        fills.push(
            column(at.x, at.z, at.y, at.y, MIDDLE_HEART),
            {
                box: {
                    x1: at.x - MIDDLE_HALF,
                    y1: at.y,
                    z1: at.z - MIDDLE_HALF,
                    x2: at.x + MIDDLE_HALF,
                    y2: at.y,
                    z2: at.z + MIDDLE_HALF
                },
                block: MIDDLE
            },
            column(at.x, at.z, foot + 1, at.y - 1, SHAFT),
            column(at.x, at.z, foot, foot, FOOT)
        );
    for (const one of layout.pillars)
        fills.push(
            column(at.x + one.x, at.z + one.z, foot, foot, FOOT),
            column(at.x + one.x, at.z + one.z, foot + 1, at.y - 1, SHAFT)
        );
    // The tops last: the block the build is proved by.
    for (const one of layout.pillars)
        fills.push(column(at.x + one.x, at.z + one.z, at.y, at.y, BEDROCK));
    return fills;
}

/** Every block kind the box can hold while it stands, as bare ids: what hangs
 *  off a block first (`arena.teardown`), what fluids make, and the build. */
export const ARENA_BLOCKS: readonly string[] = [
    "minecraft:ladder",
    "minecraft:fire",
    "minecraft:cobweb",
    "minecraft:tnt",
    "minecraft:oak_planks",
    "minecraft:cobblestone",
    "minecraft:stone",
    "minecraft:obsidian",
    "minecraft:white_wool",
    "minecraft:oak_log",
    "minecraft:glass",
    "minecraft:slime_block",
    MIDDLE_HEART,
    MIDDLE,
    SHAFT,
    FOOT,
    BEDROCK,
    BARRIER
];

/** Where a player starts: on top of their pillar, facing the middle. */
export function startSpot(layout: Layout, at: Placed, index: number): Spot {
    const pillar = layout.pillars[index % layout.pillars.length]!;
    const yaw = Math.round((-Math.atan2(-pillar.x, -pillar.z) * 180) / Math.PI);
    return { x: at.x + pillar.x, y: at.y + 1, z: at.z + pillar.z, yaw };
}

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

export function decorSpots(layout: Layout, at: Placed): decor.Spot[] {
    const gallery = galleryFloor(layout, at);
    return decor
        .corners(gallery.x1 - 1, gallery.z1 - 1, gallery.x2 + 1, gallery.z2 + 1, gallery.y1 + 4)
        .map((one): decor.Spot => ({ ...one, kind: "stand" }));
}

// ------------------------------------------------------------------ the void

/** How long the void takes to rise a block, once it rises: from the play
 *  area's floor to the pillars' tops in `PILLAR_DEPTH + BELOW` seconds. */
export const RISE_MS = 1_000;

/** The void's level at `now`: the play area's floor until `voidAfter`
 *  minutes into the game, then a block every `RISE_MS`, up to the play
 *  area's top. 0 minutes: it never rises. */
export function voidLevel(
    play: Box,
    readyAt: number | null,
    voidAfter: number,
    now: number
): number {
    if (voidAfter <= 0 || readyAt === null) return play.y1;
    const rising = now - readyAt - voidAfter * 60_000;
    if (rising <= 0) return play.y1;
    return Math.min(play.y2, play.y1 + Math.floor(rising / RISE_MS));
}

/** Seconds until the void starts rising, or null: it never does, the game has
 *  not started, or it is rising already. */
export function voidRisesIn(readyAt: number | null, voidAfter: number, now: number): number | null {
    if (voidAfter <= 0 || readyAt === null) return null;
    const left = readyAt + voidAfter * 60_000 - now;
    return left > 0 ? left / 1000 : null;
}

/**
 * Between ticks, nothing read: whoever crossed the play area's edge or is
 * under the void taken up to the gallery and marked for the tick, and under
 * a risen void marked as caught by it. First the tag taken from anybody who
 * carries it and is not playing (`names`): one who left, or was offline when
 * the last game ended, is never moved or handed items.
 */
export function quickLines(
    layout: Layout,
    at: Placed,
    box: Box,
    floor: number,
    names: readonly string[]
): string[] {
    const play = playArea(layout, at);
    const who = `tag=${IN_TAG},tag=!${OUT_TAG}`;
    const far = 64;
    const volume = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) =>
        `x=${x1},y=${y1},z=${z1},dx=${x2 - x1},dy=${y2 - y1},dz=${z2 - z1}`;
    const bottom = Math.max(play.y1, floor);
    const outside = [
        volume(
            box.x1 - far,
            box.y1 - far * 2,
            box.z1 - far,
            box.x2 + far,
            bottom - 1,
            box.z2 + far
        ),
        volume(box.x1 - far, bottom, box.z1 - far, play.x1 - 1, box.y2 + far, box.z2 + far),
        volume(play.x2 + 1, bottom, box.z1 - far, box.x2 + far, box.y2 + far, box.z2 + far),
        volume(play.x1, bottom, box.z1 - far, play.x2, box.y2 + far, play.z1 - 1),
        volume(play.x1, bottom, play.z2 + 1, play.x2, box.y2 + far, box.z2 + far),
        volume(play.x1, play.y2 + 1, play.z1, play.x2, box.y2 + far, play.z2)
    ];
    const seat = gallerySpot(layout, at, 0);
    const others = names.map((name) => `,name=!${name}`).join("");
    return [
        `tag @a[tag=${IN_TAG}${others}] remove ${IN_TAG}`,
        ...(floor > play.y1
            ? [`execute in minecraft:overworld run tag @a[${who},${outside[0]}] add ${VOID_TAG}`]
            : []),
        ...outside.map(
            (one) => `execute in minecraft:overworld run tag @a[${who},${one}] add ${GONE_TAG}`
        ),
        `execute in minecraft:overworld run tp @a[${who},tag=${GONE_TAG}] ${seat.x + 0.5} ${seat.y} ${seat.z + 0.5}`
    ];
}

/** The void, seen: a sheet of portal sparks across the play area at its level,
 *  once it rises. One line a tick, particles only. */
export function voidLines(play: Box, floor: number): string[] {
    if (floor <= play.y1) return [];
    const x = (play.x1 + play.x2 + 1) / 2;
    const z = (play.z1 + play.z2 + 1) / 2;
    const dx = (play.x2 - play.x1 + 1) / 4;
    const dz = (play.z2 - play.z1 + 1) / 4;
    return [
        `execute in minecraft:overworld run particle minecraft:portal ${x} ${floor} ${z} ${dx} 0.2 ${dz} 0.4 600 force`
    ];
}

// ------------------------------------------------------------------ the twists

export const TWISTS = ["speed", "jump", "float", "lift", "glow", "bonus"] as const;
export type Twist = (typeof TWISTS)[number];

/** How long between two twists. */
export const TWIST_MS = 45_000;

/** Which twist the `index`th is, drawn from the run's id. */
export function twistOf(seed: string, index: number): Twist {
    const random = seeded(`${seed}-twist-${index}`);
    return TWISTS[Math.floor(random() * TWISTS.length)]!;
}

/** What a twist does, to everybody still standing; `bonus` is a drop. */
export function twistLines(twist: Twist): string[] {
    const effect = (id: string, seconds: number, level: number) =>
        `effect give ${TARGET} minecraft:${id} ${seconds} ${level} true`;
    switch (twist) {
        case "speed":
            return [effect("speed", 10, 1)];
        case "jump":
            return [effect("jump_boost", 10, 1)];
        case "float":
            return [effect("slow_falling", 10, 0)];
        case "lift":
            return [effect("levitation", 2, 0)];
        case "glow":
            return [effect("glowing", 15, 0)];
        case "bonus":
            return [];
    }
}

// ------------------------------------------------------------------ the game

const outSchema = z.object({
    name: z.string(),
    at: z.number(),
    why: z.enum(["fell", "left", "died", "gone", "void"])
});

export const stateSchema = z.object({
    design: z.number().int().default(DESIGN),
    out: z.array(outSchema).default([]),
    kills: z.record(z.number().int()).default({}),
    /** Drops handed out by the loop, where the pack is not on. */
    drops: z.number().int().min(0).default(0),
    /** Twists so far. */
    twists: z.number().int().min(0).default(0),
    /** Whether the void has been announced as rising. */
    rising: z.boolean().default(false)
});
export type PillarState = z.infer<typeof stateSchema>;

export function stateOf(game: unknown): PillarState {
    const parsed = stateSchema.safeParse(game ?? {});
    return parsed.success ? parsed.data : stateSchema.parse({});
}

/** How many drops are due by `now`, counted from the start: the first at once. */
export function dropsDue(readyAt: number, seconds: number, now: number): number {
    if (now < readyAt) return 0;
    return 1 + Math.floor((now - readyAt) / (intervalTicks(seconds) * 50));
}

/** How many twists are due by `now`. */
export function twistsDue(readyAt: number, now: number): number {
    return now < readyAt ? 0 : Math.floor((now - readyAt) / TWIST_MS);
}
