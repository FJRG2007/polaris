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
 * - **What the rain eats over a shelter**: random drops alone almost never
 *   find a one-block roof, so a player who walled themselves in stayed dry for
 *   the whole event. Every few beats the first block over the head of
 *   everybody under cover also goes one step. A roof has to be patched.
 *
 * **It comes in waves** (`forecast`), so there is always something to do: a
 * drizzle to build in, a surge that grows stronger each time, a calm with no
 * rain at all - a few seconds to run for the glowing supplies dropped over the
 * arena (blocks, an antidote, a rare umbrella) and rebuild - and the last
 * minute an acid downpour. Surges change the board: lightning strikes the
 * shelter of somebody hiding (visual only: it takes the shelter's blocks, never
 * the player), a hut collapses, and wind blows the rain in sideways, so a
 * shelter needs a wall on that side too. The phase is on the boss bar with its
 * countdown, each player's acid on their action bar and everybody's on the
 * side panel.
 *
 * Every function in the pack is written in commands the oldest release the
 * pack loads on (1.13) can read, since one line it cannot read drops the whole
 * function; what needs a newer one (`spreadplayers ... under`, an item's
 * `count`) is sent over RCON, where the version is known.
 *
 * Everything placed in the arena is taken out at the end: what was built by its
 * own boxes, and whatever players placed or the rain left by `sweepBoxes` -
 * the arena's inside, once for each block a shelter can be, written down
 * before the first block is handed out.
 *
 * Pure: the arena, the boxes and the lines are functions of what they are given.
 */

import { seeded } from "../trivia-bank";
import * as catalog from "../catalog";
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
/** How much a half second in the first surge adds; less in a drizzle, more
 *  later (`doseOf`). */
export const DOSE: Readonly<Record<Acidity, number>> = { mild: 2, harsh: 3 };
/** Columns of arena for each stand the rain eats with, per look. */
const COLUMNS_PER_DRIP: Readonly<Record<Acidity, number>> = { mild: 120, harsh: 60 };
/** Ruined huts to shelter in from the start. */
export const HUTS: Readonly<Record<AcidSize, number>> = { small: 3, medium: 4, large: 6 };
/** How far from the middle a hut stands at the least: never over anybody's
 *  starting spot, so nobody starts in the dry. */
const MIDDLE = 6;
/** Cobblestone handed out at "Go!", to everybody at each calm, and in each
 *  crate of supplies. */
export const START_BLOCKS = 16;
export const TOP_UP_BLOCKS = 6;
export const CRATE_BLOCKS = 12;

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
    /** What a half second in the first surge adds (`doseOf`). */
    readonly dose: number;
    /** Beats between two bites over everybody's head, in a drizzle. */
    readonly bite: number;
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
        dose: DOSE[options.acidity],
        bite: BITE_BEATS[options.acidity]
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

// ------------------------------------------------------------------ the weather

/** What the sky over the arena is doing. */
export type Sky = "drizzle" | "surge" | "calm" | "downpour";

/** Where the wind blows the rain in from: none, north, east, south or west. */
export type Wind = 0 | 1 | 2 | 3 | 4;

/** One stretch of weather, its times counted from "Go!". */
export interface Spell {
    readonly sky: Sky;
    readonly from: number;
    readonly to: number;
    /** Which surge it is, from 1 (the downpour is one more); 0 otherwise. */
    readonly level: number;
    /** Which calm it is, from 0; -1 otherwise. */
    readonly calm: number;
    readonly wind: Wind;
    /** The hut that falls in as it starts, by its place in `Acid.huts`. */
    readonly collapse: number | null;
    /** When lightning strikes in it. */
    readonly strikes: readonly number[];
}

/** The drizzle at "Go!": time to build a first roof. */
export const OPENING_MS = 20_000;
/** After it, over and over: a surge, a calm, a drizzle. */
export const SURGE_MS = 20_000;
export const CALM_MS = 12_000;
export const DRIZZLE_MS = 14_000;
/** The end: at most a minute of downpour, a third of a short event. */
export const DOWNPOUR_MS = 60_000;
/** A stretch cut shorter than this by the downpour is the downpour's. */
const SHORTEST_MS = 5_000;
/** Lightning in the downpour: the first after this long, then this often. */
const DOWNPOUR_STRIKE_MS = 15_000;

const CYCLE: readonly (readonly [Sky, number])[] = [
    ["surge", SURGE_MS],
    ["calm", CALM_MS],
    ["drizzle", DRIZZLE_MS]
];

/**
 * The weather from "Go!" to the end, `total` ms later: an opening drizzle,
 * surges, calms and drizzles in turn, and the downpour last. Every second
 * surge is windy, and so is the downpour; from the second surge on, each
 * brings a hut down while one stands; lightning strikes once in the middle of
 * a surge, twice from the third, and every so often in the downpour. Fixed by
 * the run, so a restart picks the same weather back up.
 */
export function forecast(total: number, seed: string, huts: number): Spell[] {
    if (total <= 0) return [];
    const random = seeded(`acid-sky-${seed}`);
    const blow = (): Wind => (1 + Math.min(3, Math.floor(random() * 4))) as Wind;
    const downpourAt = Math.max(0, total - Math.min(DOWNPOUR_MS, Math.round(total / 3)));
    const spells: Spell[] = [];
    let at = 0;
    let level = 0;
    let calms = 0;
    for (let step = -1; at < downpourAt; step += 1) {
        const [sky, length] = step < 0 ? (["drizzle", OPENING_MS] as const) : CYCLE[step % 3]!;
        const to = Math.min(at + length, downpourAt);
        if (to - at < SHORTEST_MS) break;
        const plain = { sky, from: at, to, level: 0, calm: -1, wind: 0 as Wind, collapse: null };
        if (sky === "surge") {
            level += 1;
            const span = to - at;
            spells.push({
                ...plain,
                level,
                wind: level % 2 === 0 ? blow() : 0,
                collapse: level >= 2 && level - 2 < huts ? level - 2 : null,
                strikes:
                    level >= 3
                        ? [at + Math.round(span / 3), at + Math.round((2 * span) / 3)]
                        : [at + Math.round(span / 2)]
            });
        } else if (sky === "calm") spells.push({ ...plain, calm: calms++, strikes: [] });
        else spells.push({ ...plain, strikes: [] });
        at = to;
    }
    const strikes: number[] = [];
    for (let when = at + DOWNPOUR_STRIKE_MS; when < total; when += DOWNPOUR_STRIKE_MS)
        strikes.push(when);
    spells.push({
        sky: "downpour",
        from: at,
        to: total,
        level: level + 1,
        calm: -1,
        wind: blow(),
        collapse: level >= 1 && level - 1 < huts ? level - 1 : null,
        strikes
    });
    return spells;
}

/** The spell `since` ms after "Go!" falls in, by its place: the first before
 *  it, the last past the end, -1 when there is none. */
export function spellAt(spells: readonly Spell[], since: number): number {
    if (spells.length === 0) return -1;
    const index = spells.findIndex((one) => since >= one.from && since < one.to);
    return index >= 0 ? index : since < 0 ? 0 : spells.length - 1;
}

/** Every strike in the forecast, in order. */
export function strikesOf(spells: readonly Spell[]): number[] {
    return spells.flatMap((one) => one.strikes);
}

/** What a half second in the rain adds under a spell: a little in a drizzle,
 *  more every second surge, twice a surge's in the downpour, nothing in a calm. */
export function doseOf(acid: Pick<Acid, "dose">, spell: Pick<Spell, "sky" | "level">): number {
    switch (spell.sky) {
        case "calm":
            return 0;
        case "drizzle":
            return Math.max(1, acid.dose - 1);
        case "surge":
            return acid.dose + Math.floor((Math.max(1, spell.level) - 1) / 2);
        case "downpour":
            return acid.dose * 2;
    }
}

/** The beats between two bites at everybody's roof under a spell. */
export function biteOf(acid: Pick<Acid, "bite">, spell: Pick<Spell, "sky" | "level">): number {
    if (spell.sky === "drizzle") return acid.bite;
    if (spell.sky === "surge") return biteBeats(acid, spell.level);
    return FASTEST_BITE;
}

/** How hard it rains: how much rain is drawn, and how many times over the
 *  rain eats at the shelters on each look. */
export function rainOf(spell: Pick<Spell, "sky">): number {
    return { calm: 0, drizzle: 1, surge: 2, downpour: 3 }[spell.sky];
}

/** What each sky sounds like as it starts, and the colour of its boss bar. */
export const SKY_SOUNDS: Readonly<Record<Sky, string>> = {
    drizzle: "minecraft:weather.rain",
    surge: "minecraft:entity.lightning_bolt.thunder",
    calm: "minecraft:block.note_block.chime",
    downpour: "minecraft:event.raid.horn"
};
export const SKY_COLORS: Readonly<Record<Sky, "green" | "red" | "blue" | "purple">> = {
    drizzle: "green",
    surge: "red",
    calm: "blue",
    downpour: "purple"
};

// ------------------------------------------------------------------ in the game

/** Each player's acid, and the pack's own switch and clock. */
export const ACID_SCORE = "pe_acid";
/** What each player picked up from the supplies, as the pack counts it
 *  (`gotOf`), and how many beats of umbrella they have left. */
export const GOT_SCORE = "pe_acidg";
export const UMBRELLA_SCORE = "pe_acids";
export const OBJECTIVE = "polaris_acid";
const SKY_TAG = "polaris_acid_sky";
const DRIP_TAG = "polaris_acid_drip";
const WET_TAG = "pe_wet";
/** Whoever was under cover on the last look: what lightning goes for. */
const DRY_TAG = "pe_dry";
const TAKER_TAG = "pe_taker";
/** A half second between two looks at who is in the rain. */
const BEAT_TICKS = 10;
const BITE_TAG = "pe_bite";
/** Beats between two bites at the block over everybody's head, in a drizzle. */
export const BITE_BEATS: Readonly<Record<Acidity, number>> = { mild: 16, harsh: 10 };
/** The fewest beats between two bites, however hard it rains. */
export const FASTEST_BITE = 2;
/** The sizes whose rain the pack knows how to draw: its spread can only be
 *  written in the function itself. */
const SIZES = Object.values(HALF);

/** Acid an antidote takes away, and beats an umbrella keeps the rain off. */
export const CURE = 35;
export const UMBRELLA_BEATS = 20;

/** What a supply can be. */
export type Crate = "blocks" | "antidote" | "umbrella";

/** Each supply: the tag it carries, the item it looks like, what one adds to
 *  `GOT_SCORE`, and the sparkle over it. */
export const CRATES: Readonly<
    Record<Crate, { tag: string; item: string; worth: number; particle: string }>
> = {
    blocks: {
        tag: "pe_crate_b",
        item: "minecraft:chest",
        worth: 1,
        particle: "minecraft:happy_villager"
    },
    antidote: {
        tag: "pe_crate_c",
        item: "minecraft:milk_bucket",
        worth: 10,
        particle: "minecraft:heart"
    },
    umbrella: {
        tag: "pe_crate_s",
        item: "minecraft:shield",
        worth: 100,
        particle: "minecraft:totem_of_undying"
    }
};
const CRATE_TAG = "polaris_acid_crate";
const NEW_CRATE_TAG = "pe_crate_new";
/** As close as a player has to come to pick a supply up. */
const REACH = 1.6;

export const SCORES_ADDED = [ACID_SCORE, GOT_SCORE, UMBRELLA_SCORE, OBJECTIVE].map(
    (name) => `scoreboard objectives add ${name} dummy`
);
export const SCORES_REMOVED = [ACID_SCORE, GOT_SCORE, UMBRELLA_SCORE].map(
    (name) => `scoreboard objectives remove ${name}`
);

function score(name: string): string {
    return `#${name} ${OBJECTIVE}`;
}

/** A relative coordinate: `~` for none. */
function rel(by: number): string {
    return by === 0 ? "~" : `~${by}`;
}

/** A player coming in: no acid, nothing picked up, no umbrella. */
export function racerScores(name: string): string[] {
    return [ACID_SCORE, GOT_SCORE, UMBRELLA_SCORE].map(
        (objective) => `scoreboard players set ${name} ${objective} 0`
    );
}

/** Over the cover a player can be under: from two over their feet to past the roof. */
const LOOK_UP = Array.from({ length: ROOF }, (_, index) => index + 2);

/** Which way each wind comes from, as a step on the ground: north is -z. */
const WINDS: readonly (readonly [Wind, number, number])[] = [
    [1, 0, -1],
    [2, 1, 0],
    [3, 0, 1],
    [4, -1, 0]
];

const IN_RAIN = `tag=pe_in,scores={${ACID_SCORE}=0..}`;

/**
 * The functions, by name under `polaris:acid/`. Every tick the rain is drawn
 * over the arena as hard as the spell says, and the supplies sparkle and are
 * picked up; every half second everybody inside with nothing over their head
 * - or, in a wind, nothing on its side - takes the dose. `corrode` is run by
 * the quick look at each stand it scatters over the arena, `strike` by the
 * lightning.
 */
export const FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
    tick: [`execute if score ${score("on")} matches 1 run function polaris:acid/step`],
    step: [
        `scoreboard players add ${score("t")} 1`,
        `execute if score ${score("t")} matches ${BEAT_TICKS}.. run function polaris:acid/beat`,
        ...SIZES.flatMap((half) =>
            [1, 2, 3].map(
                (rain) =>
                    `execute if score ${score("half")} matches ${half} if score ${score("rain")} matches ${rain === 3 ? "3.." : rain} as @e[type=minecraft:armor_stand,tag=${SKY_TAG}] at @s run particle minecraft:item_slime ~ ~ ~ ${half / 2} 0 ${half / 2} 0 ${half * 2 * rain} normal`
            )
        ),
        `execute as @e[type=minecraft:item,tag=${CRATE_TAG}] at @s run function polaris:acid/crate`
    ],
    beat: [
        `scoreboard players set ${score("t")} 0`,
        `scoreboard players remove @a[tag=pe_in,scores={${UMBRELLA_SCORE}=1..}] ${UMBRELLA_SCORE} 1`,
        `execute if score ${score("dose")} matches 1.. in minecraft:overworld as @a[tag=pe_in,scores={${ACID_SCORE}=0..,${UMBRELLA_SCORE}=..0}] at @s run function polaris:acid/expose`,
        `execute in minecraft:overworld as @a[tag=pe_in,scores={${UMBRELLA_SCORE}=1..}] at @s run particle minecraft:totem_of_undying ~ ~2.3 ~ 0.3 0.1 0.3 0 4 normal`,
        `scoreboard players add ${score("b")} 1`,
        `execute if score ${score("dose")} matches 1.. if score ${score("b")} >= ${score("bite")} run function polaris:acid/bites`
    ],
    bites: [
        `scoreboard players set ${score("b")} 0`,
        `execute in minecraft:overworld as @a[${IN_RAIN}] at @s run function polaris:acid/bite`
    ],
    // The first block over the head, whatever is above it: a roof is eaten
    // from below, the side the player can see and patch.
    bite: [
        `tag @s add ${BITE_TAG}`,
        ...LOOK_UP.map(
            (up) =>
                `execute if entity @s[tag=${BITE_TAG}] unless block ~ ~${up} ~ minecraft:air unless block ~ ~${up} ~ ${ROOF_BLOCK} positioned ~ ~${up + 1} ~ run function polaris:acid/gnaw`
        ),
        `tag @s remove ${BITE_TAG}`
    ],
    gnaw: [
        "function polaris:acid/corrode",
        `tag @s remove ${BITE_TAG}`,
        "playsound minecraft:block.fire.extinguish master @s ~ ~-1 ~ 0.6 1.2"
    ],
    expose: [
        `tag @s add ${WET_TAG}`,
        ...LOOK_UP.map(
            (up) =>
                `execute unless block ~ ~${up} ~ minecraft:air unless block ~ ~${up} ~ ${ROOF_BLOCK} run tag @s remove ${WET_TAG}`
        ),
        `execute if score ${score("wind")} matches 1.. if entity @s[tag=!${WET_TAG}] run function polaris:acid/gust`,
        `scoreboard players operation @s[tag=${WET_TAG}] ${ACID_SCORE} += ${score("dose")}`,
        `effect give @s[tag=${WET_TAG}] minecraft:poison 1 0 true`,
        `execute if entity @s[tag=${WET_TAG}] run playsound minecraft:block.fire.extinguish master @s ~ ~ ~ 0.4 1.6`,
        `tag @s[tag=${WET_TAG}] remove ${DRY_TAG}`,
        `tag @s[tag=!${WET_TAG}] add ${DRY_TAG}`,
        `tag @s remove ${WET_TAG}`
    ],
    // Rain blown in sideways: a roof alone is not enough, it takes a block on
    // the wind's side too, at the feet or the head.
    gust: [
        `tag @s add ${WET_TAG}`,
        ...WINDS.flatMap(([wind, dx, dz]) =>
            [0, 1].map(
                (up) =>
                    `execute if score ${score("wind")} matches ${wind} unless block ${rel(dx)} ${rel(up)} ${rel(dz)} minecraft:air run tag @s remove ${WET_TAG}`
            )
        )
    ],
    // One step at a time, the last step first, so a block goes one step a drop.
    corrode: [
        `execute if block ~ ~-1 ~ ${SHELTER[2]} run setblock ~ ~-1 ~ minecraft:air`,
        `execute if block ~ ~-1 ~ ${SHELTER[1]} run setblock ~ ~-1 ~ ${SHELTER[2]}`,
        `execute if block ~ ~-1 ~ ${SHELTER[0]} run setblock ~ ~-1 ~ ${SHELTER[1]}`,
        "particle minecraft:item_slime ~ ~0.2 ~ 0.3 0.1 0.3 0 6 normal"
    ],
    // A supply, every tick: its sparkle, and picked up by whoever reaches it.
    crate: [
        ...Object.values(CRATES).map(
            (one) =>
                `execute if entity @s[tag=${one.tag}] run particle ${one.particle} ~ ~0.7 ~ 0.2 0.3 0.2 0 1 force`
        ),
        `execute if entity @a[${IN_RAIN},distance=..${REACH}] run function polaris:acid/take`
    ],
    // The antidote and the umbrella work at once; the blocks are handed out
    // over RCON, which knows how this version writes an item.
    take: [
        `tag @p[${IN_RAIN},distance=..${REACH}] add ${TAKER_TAG}`,
        ...Object.values(CRATES).map(
            (one) =>
                `execute if entity @s[tag=${one.tag}] run scoreboard players add @a[tag=${TAKER_TAG}] ${GOT_SCORE} ${one.worth}`
        ),
        `execute if entity @s[tag=${CRATES.antidote.tag}] run scoreboard players remove @a[tag=${TAKER_TAG}] ${ACID_SCORE} ${CURE}`,
        `scoreboard players set @a[tag=${TAKER_TAG},scores={${ACID_SCORE}=..-1}] ${ACID_SCORE} 0`,
        `execute if entity @s[tag=${CRATES.umbrella.tag}] run scoreboard players set @a[tag=${TAKER_TAG}] ${UMBRELLA_SCORE} ${UMBRELLA_BEATS}`,
        `execute as @a[tag=${TAKER_TAG}] at @s run playsound minecraft:entity.player.levelup master @s ~ ~ ~ 0.8 1.6`,
        `tag @a[tag=${TAKER_TAG}] remove ${TAKER_TAG}`,
        `kill @s[type=minecraft:item,tag=${CRATE_TAG}]`
    ],
    // Lightning, from the floor under somebody hiding: what shelters them is
    // gone, three by three, as high as the roof. The floor, the walls and the
    // roof are never touched, and neither is the player.
    strike: [
        ...SHELTER.map(
            (block) => `fill ~-1 ~ ~-1 ~1 ~${ROOF - 2} ~1 minecraft:air replace ${block}`
        ),
        `particle minecraft:end_rod ~ ~${ROOF / 2} ~ 0.05 ${ROOF / 2} 0.05 0 80 force`,
        `particle minecraft:explosion ~ ~${ROOF - 2} ~ 1 0.5 1 0 3 force`,
        "playsound minecraft:entity.lightning_bolt.thunder master @a[tag=pe_in] ~ ~ ~ 1 1.2 0.6",
        "playsound minecraft:entity.lightning_bolt.impact master @a[tag=pe_in] ~ ~ ~ 1 1 0.6"
    ]
};

/**
 * Switched on for one arena, at "Go!": its size, a stand over its middle for
 * the rain to fall from, the stands the rain eats with, the weather it starts
 * with (`skyLines`) and the switch last.
 */
export function armLines(acid: Acid, spell: Spell): string[] {
    const set = (name: string, value: number) => `scoreboard players set ${score(name)} ${value}`;
    const { x, z } = acid.center;
    const stand = (tag: string, y: number) =>
        `execute in minecraft:overworld run summon minecraft:armor_stand ${x + 0.5} ${y} ${z + 0.5} {Tags:["${tag}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b}`;
    return [
        ...SCORES_ADDED,
        set("on", 0),
        set("t", 0),
        set("half", acid.half),
        set("x", x),
        set("z", z),
        `kill @e[type=minecraft:armor_stand,tag=${SKY_TAG}]`,
        `kill @e[type=minecraft:armor_stand,tag=${DRIP_TAG}]`,
        `kill @e[type=minecraft:item,tag=${CRATE_TAG}]`,
        `tag @a remove ${DRY_TAG}`,
        stand(SKY_TAG, acid.floor + ROOF - 0.5),
        ...Array.from({ length: acid.drips }, () => stand(DRIP_TAG, acid.floor + 1)),
        ...skyLines(acid, spell),
        set("on", 1)
    ];
}

/** The pack told what a spell is: its dose, its bites, how hard it rains and
 *  where the wind is from. */
export function skyLines(acid: Pick<Acid, "dose" | "bite">, spell: Spell): string[] {
    const set = (name: string, value: number) => `scoreboard players set ${score(name)} ${value}`;
    return [
        set("dose", doseOf(acid, spell)),
        set("bite", biteOf(acid, spell)),
        set("b", 0),
        set("rain", rainOf(spell)),
        set("wind", spell.wind)
    ];
}

/** Everybody's acid on the side panel, under `title` (the game's JSON). */
export function sidebarLines(title: string): string[] {
    return [
        `scoreboard objectives modify ${ACID_SCORE} displayname ${title}`,
        `scoreboard objectives setdisplay sidebar ${ACID_SCORE}`
    ];
}

/** Switched off, its stands and supplies taken away - only while the switch
 *  is still this arena's, so ending an old one never stops a newer one. */
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
        `execute ${ours} run kill @e[type=minecraft:item,tag=${CRATE_TAG}]`,
        `execute ${ours} run tag @a remove ${DRY_TAG}`,
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

/** The beats between two bites in the `times`th surge: half as many each one. */
export function biteBeats(acid: Pick<Acid, "bite">, times: number): number {
    return Math.max(FASTEST_BITE, Math.round(acid.bite / 2 ** Math.max(0, times)));
}

// ------------------------------------------------------------------ moments

/** The supplies dropped at a calm: blocks for about every other player still
 *  in, an antidote, and an umbrella every second calm. */
export function cratesFor(calm: number, standing: number): Crate[] {
    const blocks = Math.max(1, Math.min(4, Math.ceil(standing / 2)));
    return [
        ...Array.from({ length: blocks }, (): Crate => "blocks"),
        "antidote",
        ...(calm % 2 === 1 ? (["umbrella"] as const) : [])
    ];
}

/**
 * Supplies dropped over the arena: whatever was left of the last ones taken
 * away, and each new one a glowing item nobody can pick up the usual way,
 * scattered onto the highest block under the roof (`spreadplayers ... under`,
 * 1.17). The pack picks them up (`take`). An item's count is written as this
 * version writes it.
 */
export function dropLines(acid: Acid, crates: readonly Crate[], items: Flavour["items"]): string[] {
    const { x, z } = acid.center;
    const count = items === "components" ? "count:1" : "Count:1b";
    return [
        `kill @e[type=minecraft:item,tag=${CRATE_TAG}]`,
        ...crates.map(
            (kind) =>
                `execute in minecraft:overworld run summon minecraft:item ${x + 0.5} ${acid.floor + ROOF - 1} ${z + 0.5} {Item:{id:"${CRATES[kind].item}",${count}},PickupDelay:32767,Age:-32768,Glowing:1b,Tags:["${CRATE_TAG}","${CRATES[kind].tag}","${NEW_CRATE_TAG}"]}`
        ),
        `execute in minecraft:overworld run spreadplayers ${x + 0.5} ${z + 0.5} 1 ${acid.half} under ${acid.floor + ROOF - 1} false @e[type=minecraft:item,tag=${NEW_CRATE_TAG}]`,
        `tag @e[type=minecraft:item,tag=${NEW_CRATE_TAG}] remove ${NEW_CRATE_TAG}`
    ];
}

/** Whoever picked supplies up since the last look, with what they picked. */
export const READ_GOT = `execute as @a[tag=pe_in,scores={${GOT_SCORE}=1..}] run scoreboard players get @s ${GOT_SCORE}`;
/** Whoever holds an umbrella, with the beats it has left. */
export const READ_UMBRELLA = `execute as @a[tag=pe_in,scores={${UMBRELLA_SCORE}=1..}] run scoreboard players get @s ${UMBRELLA_SCORE}`;

/** What a `GOT_SCORE` holds, one supply a digit. */
export function gotOf(got: number): Record<Crate, number> {
    const value = Math.max(0, Math.floor(got));
    return {
        blocks: value % 10,
        antidote: Math.floor(value / 10) % 10,
        umbrella: Math.floor(value / 100) % 10
    };
}

/** What was read taken off again: anything picked up since stays counted. */
export function gotTakenLines(name: string, got: number): string[] {
    return [`scoreboard players remove ${name} ${GOT_SCORE} ${Math.max(0, Math.floor(got))}`];
}

/**
 * Lightning at somebody under cover, chosen at random among those whose
 * shelter it can take without reaching past a wall: from the floor under
 * them (`strike`). Nobody under cover, no strike.
 */
export function strikeLine(acid: Acid): string {
    const { x, z } = acid.center;
    const edge = acid.half - 1;
    return `execute in minecraft:overworld as @r[tag=${DRY_TAG},scores={${ACID_SCORE}=0..},x=${x - edge},y=${acid.floor},z=${z - edge},dx=${2 * edge},dy=${ROOF},dz=${2 * edge}] at @s positioned ~ ${acid.floor + 1} ~ run function polaris:acid/strike`;
}

/** A ruined hut falling in: whatever of it, or built onto it, is shelter. */
export function collapseLines(acid: Acid, index: number): string[] {
    const hut = acid.huts[index];
    if (!hut) return [];
    const hx = acid.center.x + hut.x;
    const hz = acid.center.z + hut.z;
    const y = acid.floor;
    return [
        ...SHELTER.map(
            (block) =>
                `execute in minecraft:overworld run fill ${hx - 1} ${y + 1} ${hz - 1} ${hx + 1} ${y + 4} ${hz + 1} minecraft:air replace ${block}`
        ),
        `execute in minecraft:overworld run particle minecraft:cloud ${hx + 0.5} ${y + 2} ${hz + 0.5} 1 1.5 1 0.02 40 force`,
        `execute in minecraft:overworld run playsound minecraft:entity.zombie.break_wooden_door master @a[tag=pe_in] ${hx + 0.5} ${y + 2} ${hz + 0.5} 1 0.7 0.4`
    ];
}

// ------------------------------------------------------------------ reading it

/** Everybody's acid, as the game has it. */
export const READ_ACID = `execute as @a[tag=pe_in,scores={${ACID_SCORE}=0..}] run scoreboard players get @s ${ACID_SCORE}`;

/** Where a player stands with the rain, from two looks at their acid. */
export type Cover = "wet" | "dry" | "umbrella";

export function coverOf(before: number | undefined, now: number, umbrella: number): Cover {
    if (umbrella > 0) return "umbrella";
    return before !== undefined && now > before ? "wet" : "dry";
}

/** A player's acid as a bar of ten: green, yellow from 40, red from 70. */
export function gauge(acid: number): string {
    const full = Math.max(0, Math.min(10, Math.round((acid / ACID_MAX) * 10)));
    const colour = acid >= 70 ? "&c" : acid >= 40 ? "&e" : "&a";
    return `${colour}${"|".repeat(full)}&8${"|".repeat(10 - full)}`;
}

/** How dry a player stayed, out of the whole bar: what ranks those still in. */
export function dryOf(acid: number): number {
    return Math.max(0, ACID_MAX - Math.max(0, acid));
}

/** A score for the podium: whoever lasted longer above whoever went out before
 *  them (`place`, a spleef's points); among those still in at the end, the
 *  driest first. */
export function scoreOf(place: number, dry: number | null): number {
    return place * catalog.ACID_PLACE + Math.max(0, Math.min(ACID_MAX, dry ?? 0));
}

/** A score taken apart again, for the podium's words. */
export const scoreParts = catalog.acidParts;

/** A player out of the rain: no acid, supplies or umbrella kept against them,
 *  no hearts left green, not a target for lightning. */
export function racerOutLines(name: string): string[] {
    return [
        ...[ACID_SCORE, GOT_SCORE, UMBRELLA_SCORE].map(
            (objective) => `scoreboard players reset ${name} ${objective}`
        ),
        `effect clear ${name} minecraft:poison`,
        `tag ${name} remove ${DRY_TAG}`
    ];
}
