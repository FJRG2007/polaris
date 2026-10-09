/**
 * Acid rain: a walled square of mossy stone floating over a site, open to the
 * sky but for an invisible roof, where an acid rain falls on the players who
 * choose to take part. Standing with nothing over your head fills your acid
 * bar; full, you are out. Cover is a few ruined huts and the marked cobblestone
 * everybody is handed - placed only on the arena's own blocks - and the rain
 * eats it: a block it falls on turns mossy, then to green glass, then is gone.
 * The last one left wins; at the end of the time, whoever has the least acid.
 *
 * **The world's weather is never touched.** Rain over the whole server would
 * fall on every player in it: this rain is particles over the arena alone, and
 * what it does is worked out by the events data pack (`FUNCTIONS`).
 *
 * - **Who is in the rain**: every half second, for everybody inside, each block
 *   from two over their feet up past the roof is looked at; any block but air
 *   and the roof's barrier is cover. Under none, their acid goes up by the
 *   dose, and they hear it hiss. Nobody is ever hurt: Resistance V as on
 *   every stage, and the Poison shown is only the colour of the hearts.
 * - **What the rain eats**: a few invisible stands are scattered over the
 *   arena on every quick look (`spreadplayers ... under`, from 1.17), each onto
 *   the highest block under the roof where it lands - the top of a shelter, or
 *   the floor - and that block goes one step: cobblestone to mossy cobblestone,
 *   to lime glass, to air. The floor and the walls are never eaten. Bounded:
 *   a few blocks a look, whatever the size of the server.
 *
 * Everything placed in the arena is taken out at the end: what was built by its
 * own boxes, and whatever players placed or the rain left by `sweepBoxes` -
 * the arena's inside, once for each block a shelter can be, written down
 * before the first block is handed out.
 *
 * Pure: the arena, the boxes and the lines are functions of what they are given.
 */

import { seeded } from "../trivia-bank";
import type { EventOptions } from "../catalog";
import type { Box, Flavour, Spot, Volume } from "./stage";

export type AcidSize = EventOptions<"acid-rain">["size"];
export type Acidity = EventOptions<"acid-rain">["acidity"];

/** Blocks from the middle of the floor to its edge, inside the walls. */
export const HALF: Readonly<Record<AcidSize, number>> = { small: 8, medium: 11, large: 14 };
/** How far over the floor the invisible roof is: room to build, and to stand
 *  on what you built. */
export const ROOF = 7;
/** The acid that puts a player out. */
export const ACID_MAX = 100;
/** How much a half second in the rain adds. */
export const DOSE: Readonly<Record<Acidity, number>> = { mild: 2, harsh: 3 };
/** Columns of arena for each stand the rain eats with, per look. */
const COLUMNS_PER_DRIP: Readonly<Record<Acidity, number>> = { mild: 120, harsh: 60 };
/** Ruined huts to shelter in from the start. */
export const HUTS: Readonly<Record<AcidSize, number>> = { small: 3, medium: 4, large: 6 };
/** How far from the middle a hut stands at the least: never over anybody's
 *  starting spot, so nobody starts in the dry. */
const MIDDLE = 6;
/** Cobblestone handed out at "Go!", and again every `TOP_UP_MS`. */
export const START_BLOCKS = 16;
export const TOP_UP_BLOCKS = 8;
export const TOP_UP_MS = 40_000;

const FLOOR: Box["block"] = "minecraft:mossy_stone_bricks";
const WALL: Box["block"] = "minecraft:glass";
const ROOF_BLOCK: Box["block"] = "minecraft:barrier";
/** What a shelter is made of, and what the rain makes of it, step by step. */
export const SHELTER: readonly Box["block"][] = [
    "minecraft:cobblestone",
    "minecraft:mossy_cobblestone",
    "minecraft:lime_stained_glass"
];
const LIGHT: Box["block"] = "minecraft:sea_lantern";

/** A ruined hut: four posts and a roof of three by three. */
export interface Hut {
    readonly x: number;
    readonly z: number;
}

export interface Acid {
    readonly floor: number;
    readonly center: { readonly x: number; readonly z: number };
    readonly half: number;
    readonly huts: readonly Hut[];
    /** What is built, in order: the floor, the walls, the lights, the huts, the roof. */
    readonly boxes: readonly Box[];
    readonly volume: Volume;
    readonly reach: number;
    /** How many stands eat at the shelters on each look. */
    readonly drips: number;
    readonly dose: number;
}

/** Where the huts go: spread over the floor away from the middle (where
 *  everybody starts) and from each other, each wholly inside. */
export function hutsFor(half: number, count: number, seed: string): Hut[] {
    const random = seeded(`acid-rain-${seed}`);
    const huts: Hut[] = [];
    for (let tries = 0; tries < 400 && huts.length < count; tries += 1) {
        const x = Math.floor(random() * (2 * half - 3)) - half + 2;
        const z = Math.floor(random() * (2 * half - 3)) - half + 2;
        if (Math.max(Math.abs(x), Math.abs(z)) < MIDDLE) continue;
        if (huts.some((one) => Math.max(Math.abs(one.x - x), Math.abs(one.z - z)) < 6)) continue;
        huts.push({ x, z });
    }
    return huts;
}

/** The arena over a site: its middle over the column, its floor at `y`. */
export function arena(
    options: Pick<EventOptions<"acid-rain">, "size" | "acidity">,
    seed: string,
    site: { x: number; z: number },
    y: number
): Acid {
    const half = HALF[options.size];
    const { x, z } = site;
    const outer = half + 1;
    const huts = hutsFor(half, HUTS[options.size], seed);
    const box = (
        x1: number,
        y1: number,
        z1: number,
        x2: number,
        y2: number,
        z2: number,
        block: Box["block"]
    ): Box => ({ x1, y1, z1, x2, y2, z2, block });
    const top = y + ROOF - 1;
    const boxes: Box[] = [
        box(x - outer, y, z - outer, x + outer, y, z + outer, FLOOR),
        // The four walls, corner to corner, never overlapping.
        box(x - outer, y + 1, z - outer, x + outer, top, z - outer, WALL),
        box(x - outer, y + 1, z + outer, x + outer, top, z + outer, WALL),
        box(x - outer, y + 1, z - half, x - outer, top, z + half, WALL),
        box(x + outer, y + 1, z - half, x + outer, top, z + half, WALL),
        // A light in the floor at each corner of the inside.
        ...[
            [-half, -half],
            [half, -half],
            [-half, half],
            [half, half]
        ].map(([dx, dz]) => box(x + dx!, y, z + dz!, x + dx!, y, z + dz!, LIGHT))
    ];
    for (const hut of huts) {
        const hx = x + hut.x;
        const hz = z + hut.z;
        for (const [dx, dz] of [
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1]
        ] as const)
            boxes.push(box(hx + dx, y + 1, hz + dz, hx + dx, y + 3, hz + dz, SHELTER[0]!));
        boxes.push(box(hx - 1, y + 4, hz - 1, hx + 1, y + 4, hz + 1, SHELTER[0]!));
    }
    boxes.push(box(x - outer, y + ROOF, z - outer, x + outer, y + ROOF, z + outer, ROOF_BLOCK));
    // The lights sit in the floor: the floor's box leaves their blocks out.
    const floor = boxes[0]!;
    const lights = boxes.filter((one) => one.block === LIGHT);
    boxes.splice(0, 1, ...floorAround(floor, lights));
    const columns = (2 * half + 1) ** 2;
    return {
        floor: y,
        center: { x, z },
        half,
        huts,
        boxes,
        volume: { x1: x - outer, y1: y, z1: z - outer, x2: x + outer, y2: y + ROOF, z2: z + outer },
        reach: outer + 1,
        drips: Math.max(2, Math.ceil(columns / COLUMNS_PER_DRIP[options.acidity])),
        dose: DOSE[options.acidity]
    };
}

/** A one-block-high floor with holes for the lights, as rows of boxes. */
function floorAround(floor: Box, holes: readonly Box[]): Box[] {
    const out: Box[] = [];
    for (let z = floor.z1; z <= floor.z2; z += 1) {
        const gaps = holes
            .filter((one) => one.z1 === z)
            .map((one) => one.x1)
            .sort((a, b) => a - b);
        if (gaps.length === 0) {
            const last = out.at(-1);
            if (last && last.z2 === z - 1 && last.x1 === floor.x1 && last.x2 === floor.x2)
                out[out.length - 1] = { ...last, z2: z };
            else out.push({ ...floor, z1: z, z2: z });
            continue;
        }
        let from = floor.x1;
        for (const gap of gaps) {
            if (gap > from) out.push({ ...floor, x1: from, x2: gap - 1, z1: z, z2: z });
            from = gap + 1;
        }
        if (from <= floor.x2) out.push({ ...floor, x1: from, x2: floor.x2, z1: z, z2: z });
    }
    return out;
}

/**
 * The arena's inside once for each block a shelter can be: what takes out
 * whatever players placed and whatever the rain left, wherever it is. Written
 * down at "Go!", never built.
 */
export function sweepBoxes(acid: Acid): Box[] {
    const { x, z } = acid.center;
    return SHELTER.map((block) => ({
        x1: x - acid.half,
        y1: acid.floor + 1,
        z1: z - acid.half,
        x2: x + acid.half,
        y2: acid.floor + ROOF - 1,
        z2: z + acid.half,
        block
    }));
}

/** Where each of `count` players starts: round the middle, facing it. */
export function spots(acid: Acid, count: number): Spot[] {
    const radius = Math.min(3, acid.half - 2);
    return Array.from({ length: count }, (_, index) => {
        const angle = (index / Math.max(1, count)) * 2 * Math.PI;
        const dx = Math.round(Math.cos(angle) * radius * 100) / 100;
        const dz = Math.round(Math.sin(angle) * radius * 100) / 100;
        return {
            x: acid.center.x + 0.5 + dx,
            y: acid.floor + 1,
            z: acid.center.z + 0.5 + dz,
            yaw: Math.round((Math.atan2(dx, -dz) * 180) / Math.PI)
        };
    });
}

/** On the floor inside the walls, standing on it or on what was built there. */
export function inside(acid: Acid, at: { x: number; y: number; z: number }): boolean {
    return (
        at.y >= acid.floor + 0.5 &&
        at.y <= acid.floor + ROOF &&
        Math.abs(at.x - (acid.center.x + 0.5)) <= acid.half + 1 &&
        Math.abs(at.z - (acid.center.z + 0.5)) <= acid.half + 1
    );
}

/** Whether boxes are an acid arena's: it alone has an invisible roof. */
export function isAcid(boxes: readonly Pick<Box, "block">[]): boolean {
    return boxes.some((one) => one.block === ROOF_BLOCK);
}

// ------------------------------------------------------------------ items

/** The blocks a handed-out cobblestone can be placed on: the floor, and any
 *  shelter. */
const PLACE_ON = [FLOOR, ...SHELTER];

/** Marked cobblestone, placeable only on the arena's floor and its shelters. */
export function cobblestoneLine(name: string, items: Flavour["items"], count: number): string {
    return items === "components"
        ? `give ${name} minecraft:cobblestone[minecraft:custom_data={polaris_event:1b},minecraft:can_place_on={blocks:[${PLACE_ON.map((one) => `"${one}"`).join(",")}]}] ${count}`
        : `give ${name} minecraft:cobblestone{polaris_event:1b,CanPlaceOn:[${PLACE_ON.map((one) => `"${one}"`).join(",")}]} ${count}`;
}

// ------------------------------------------------------------------ in the game

/** Each player's acid, and the pack's own switch and clock. */
export const ACID_SCORE = "pe_acid";
export const OBJECTIVE = "polaris_acid";
const SKY_TAG = "polaris_acid_sky";
const DRIP_TAG = "polaris_acid_drip";
const WET_TAG = "pe_wet";
/** A half second between two looks at who is in the rain. */
const BEAT_TICKS = 10;
/** The sizes whose rain the pack knows how to draw: its spread can only be
 *  written in the function itself. */
const SIZES = Object.values(HALF);

export const SCORES_ADDED = [ACID_SCORE, OBJECTIVE].map(
    (name) => `scoreboard objectives add ${name} dummy`
);
export const SCORES_REMOVED = [`scoreboard objectives remove ${ACID_SCORE}`];

function score(name: string): string {
    return `#${name} ${OBJECTIVE}`;
}

/** A player coming in: no acid yet. */
export function racerScores(name: string): string[] {
    return [`scoreboard players set ${name} ${ACID_SCORE} 0`];
}

/** Over the cover a player can be under: from two over their feet to past the roof. */
const LOOK_UP = Array.from({ length: ROOF }, (_, index) => index + 2);

/**
 * The functions, by name under `polaris:acid/`. Every tick the rain is drawn
 * over the arena; every half second everybody inside with nothing over their
 * head takes the dose. `corrode` is run by the quick look at each stand it
 * scatters over the arena.
 */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [`execute if score ${score("on")} matches 1 run function polaris:acid/step`],
    step: [
        `scoreboard players add ${score("t")} 1`,
        `execute if score ${score("t")} matches ${BEAT_TICKS}.. run function polaris:acid/beat`,
        ...SIZES.map(
            (half) =>
                `execute if score ${score("half")} matches ${half} as @e[type=minecraft:armor_stand,tag=${SKY_TAG}] at @s run particle minecraft:item_slime ~ ~ ~ ${half / 2} 0 ${half / 2} 0 ${half * 2} normal`
        )
    ],
    beat: [
        `scoreboard players set ${score("t")} 0`,
        `execute in minecraft:overworld as @a[tag=pe_in,scores={${ACID_SCORE}=0..}] at @s run function polaris:acid/expose`
    ],
    expose: [
        `tag @s add ${WET_TAG}`,
        ...LOOK_UP.map(
            (up) =>
                `execute unless block ~ ~${up} ~ minecraft:air unless block ~ ~${up} ~ ${ROOF_BLOCK} run tag @s remove ${WET_TAG}`
        ),
        `scoreboard players operation @s[tag=${WET_TAG}] ${ACID_SCORE} += ${score("dose")}`,
        `effect give @s[tag=${WET_TAG}] minecraft:poison 1 0 true`,
        `execute if entity @s[tag=${WET_TAG}] run playsound minecraft:block.fire.extinguish master @s ~ ~ ~ 0.4 1.6`,
        `tag @s remove ${WET_TAG}`
    ],
    // One step at a time, the last step first, so a block goes one step a drop.
    corrode: [
        `execute if block ~ ~-1 ~ ${SHELTER[2]} run setblock ~ ~-1 ~ minecraft:air`,
        `execute if block ~ ~-1 ~ ${SHELTER[1]} run setblock ~ ~-1 ~ ${SHELTER[2]}`,
        `execute if block ~ ~-1 ~ ${SHELTER[0]} run setblock ~ ~-1 ~ ${SHELTER[1]}`,
        "particle minecraft:item_slime ~ ~0.2 ~ 0.3 0.1 0.3 0 6 normal"
    ]
};

/**
 * Switched on for one arena, at "Go!": the dose, its size, a stand over its
 * middle for the rain to fall from, the stands the rain eats with, and the
 * switch last.
 */
export function armLines(acid: Acid): string[] {
    const set = (name: string, value: number) => `scoreboard players set ${score(name)} ${value}`;
    const { x, z } = acid.center;
    const stand = (tag: string, y: number) =>
        `execute in minecraft:overworld run summon minecraft:armor_stand ${x + 0.5} ${y} ${z + 0.5} {Tags:["${tag}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b}`;
    return [
        ...SCORES_ADDED,
        set("on", 0),
        set("t", 0),
        set("dose", acid.dose),
        set("half", acid.half),
        set("x", x),
        set("z", z),
        `kill @e[type=minecraft:armor_stand,tag=${SKY_TAG}]`,
        `kill @e[type=minecraft:armor_stand,tag=${DRIP_TAG}]`,
        stand(SKY_TAG, acid.floor + ROOF - 0.5),
        ...Array.from({ length: acid.drips }, () => stand(DRIP_TAG, acid.floor + 1)),
        set("on", 1)
    ];
}

/** Switched off, its stands taken away - only while the switch is still this
 *  arena's, so ending an old one never stops a newer one. */
export function stopLines(
    boxes: readonly Pick<Box, "x1" | "z1" | "x2" | "z2" | "block">[]
): string[] {
    const roof = boxes.find((one) => one.block === ROOF_BLOCK);
    if (!roof) return [];
    const x = Math.round((roof.x1 + roof.x2) / 2);
    const z = Math.round((roof.z1 + roof.z2) / 2);
    const ours = `if score ${score("x")} matches ${x} if score ${score("z")} matches ${z}`;
    return [
        `execute ${ours} run kill @e[type=minecraft:armor_stand,tag=${SKY_TAG}]`,
        `execute ${ours} run kill @e[type=minecraft:armor_stand,tag=${DRIP_TAG}]`,
        `execute ${ours} run scoreboard players set ${score("on")} 0`
    ];
}

/** The rain eating at the shelters, on one quick look: the stands scattered
 *  over the inside onto the highest block under the roof, and each eats one. */
export function dripLines(acid: Acid): string[] {
    return [
        `execute in minecraft:overworld run spreadplayers ${acid.center.x + 0.5} ${acid.center.z + 0.5} 1 ${acid.half} under ${acid.floor + ROOF - 1} false @e[type=minecraft:armor_stand,tag=${DRIP_TAG}]`,
        `execute in minecraft:overworld as @e[type=minecraft:armor_stand,tag=${DRIP_TAG}] at @s run function polaris:acid/corrode`
    ];
}

/** Everybody's acid, as the game has it. */
export const READ_ACID = `execute as @a[tag=pe_in,scores={${ACID_SCORE}=0..}] run scoreboard players get @s ${ACID_SCORE}`;

/** A player's acid as a bar of ten. */
export function gauge(acid: number): string {
    const full = Math.max(0, Math.min(10, Math.round((acid / ACID_MAX) * 10)));
    return `&a${"|".repeat(full)}&8${"|".repeat(10 - full)}`;
}

/** How dry a player stayed, out of the whole bar: what ranks those still in. */
export function dryOf(acid: number): number {
    return Math.max(0, ACID_MAX - Math.max(0, acid));
}

/** A score for the podium: whoever lasted longer above whoever went out before
 *  them (`place`, a spleef's points); among those still in at the end, the
 *  driest first. */
export function scoreOf(place: number, dry: number | null): number {
    return place * 1000 + Math.max(0, Math.min(ACID_MAX, dry ?? 0));
}

/** A score taken apart again, for the podium's words. */
export function scoreParts(score: number): { place: number; dry: number } {
    return { place: Math.floor(score / 1000), dry: score % 1000 };
}

/** A player out of the rain: no acid kept against them, no hearts left green. */
export function racerOutLines(name: string): string[] {
    return [
        `scoreboard players reset ${name} ${ACID_SCORE}`,
        `effect clear ${name} minecraft:poison`
    ];
}
