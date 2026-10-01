/**
 * A gathering: a few short rounds, each for one material announced as it
 * starts, and whoever has the most points over all of them wins. What one item
 * is worth depends on the material (`WORTH`), so a round of logs and a round of
 * iron count alike.
 *
 * Nothing is ever taken from anybody. What a player holds is counted with
 * `clear <player> <item> 0`, which removes nothing and answers how many there
 * are. Their score is what they hold now minus what they held when they were
 * first seen during it - so a stack they brought along is not counted - and never
 * more than what the game's own statistics say they picked up (or, for iron,
 * smelted) since it began, less what they dropped: a stack taken out of their
 * own chest, or thrown down and picked up again, gathers nothing.
 *
 * Iron made at a table or a furnace counts only as far as raw iron (or iron ore)
 * picked up since the start could have made it: the game counts ingots crafted
 * out of a block of iron the same as ingots smelted, so a block taken out of a
 * player's own chest and crafted into nine gathered nine.
 *
 * Everything is kept on the server's scoreboard, under `pe_`, so a Polaris
 * restart finds it where it was.
 */

import { setScore } from "../commands";
import { GATHER_MATERIALS, type EventOptions, type GatherMaterial } from "../catalog";

interface Material {
    /** What is counted in the inventory: an item, or a tag of them. */
    readonly held: string;
    /** The item ids the statistics count it by. */
    readonly ids: readonly string[];
    /** What it is smelted from, for what is made rather than found: making it
     *  counts, but never for more than of these was picked up. */
    readonly smeltedFrom?: readonly string[];
}

const MATERIALS: Readonly<Record<GatherMaterial, Material>> = {
    wheat: { held: "minecraft:wheat", ids: ["wheat"] },
    logs: {
        held: "#minecraft:logs",
        // A kind this version does not have is an objective the game refuses,
        // which is nothing counted rather than anything broken.
        ids: [
            "oak_log",
            "spruce_log",
            "birch_log",
            "jungle_log",
            "acacia_log",
            "dark_oak_log",
            "mangrove_log",
            "cherry_log",
            "pale_oak_log",
            "crimson_stem",
            "warped_stem"
        ]
    },
    cobblestone: { held: "minecraft:cobblestone", ids: ["cobblestone"] },
    iron_ingot: {
        held: "minecraft:iron_ingot",
        ids: ["iron_ingot"],
        // Raw iron from 1.17; the ore itself before that, and with silk touch.
        smeltedFrom: ["raw_iron", "iron_ore", "deepslate_iron_ore"]
    },
    coal: { held: "minecraft:coal", ids: ["coal"] },
    kelp: { held: "minecraft:kelp", ids: ["kelp"] },
    bamboo: { held: "minecraft:bamboo", ids: ["bamboo"] },
    sugar_cane: { held: "minecraft:sugar_cane", ids: ["sugar_cane"] },
    potato: { held: "minecraft:potato", ids: ["potato"] },
    carrot: { held: "minecraft:carrot", ids: ["carrot"] },
    sand: { held: "minecraft:sand", ids: ["sand"] },
    pumpkin: { held: "minecraft:pumpkin", ids: ["pumpkin"] }
};

const HAVE = "pe_have";
/** What of the material was made, and what it could have been made from. */
const MADE = "pe_gmade";
const RAW = "pe_graw";
const BASE = "pe_base";
const SEEN = "pe_seen";
const CAP = "pe_cap";
/** What each player has gathered so far, zero included, for their action bar. */
export const PROGRESS = "pe_prog";
/** The points of the rounds already over. */
const BANKED = "pe_gtot";
/** This round's points: what was gathered, times what one is worth. */
const POINTS = "pe_gpts";
/** Both together, what the side panel shows. */
const TOTAL = "pe_gsum";
/** Where what one item of this round is worth is kept, under `#worth`. */
const WORTH_HOLDER = "pe_gk";

/**
 * Points for one item of each material: about what a player gathers of it in a
 * minute, turned round, so a minute of any of them is worth about the same -
 * a stack of cobblestone is a minute's work, an iron ingot mined and smelted a
 * good part of one.
 */
export const WORTH: Readonly<Record<GatherMaterial, number>> = {
    wheat: 2,
    logs: 4,
    cobblestone: 1,
    iron_ingot: 12,
    coal: 5,
    kelp: 1,
    bamboo: 1,
    sugar_cane: 2,
    potato: 3,
    carrot: 3,
    sand: 1,
    pumpkin: 8
};

/**
 * The material for a round: the one chosen, or one drawn from the list - none
 * of the rounds before it (`used`) while any is left.
 */
export function drawMaterial(
    options: Pick<EventOptions<"gathering">, "material">,
    random: () => number,
    used: readonly string[] = []
): GatherMaterial {
    if (options.material !== "random") return options.material;
    const fresh = GATHER_MATERIALS.filter((one) => !used.includes(one));
    const from = fresh.length > 0 ? fresh : GATHER_MATERIALS;
    return from[Math.floor(random() * from.length)] ?? "wheat";
}

/** The material a stored run is for, whatever was written. */
export function materialOf(
    stored: string | null,
    options: Pick<EventOptions<"gathering">, "material">
): GatherMaterial {
    const known = GATHER_MATERIALS.find((one) => one === stored);
    if (known) return known;
    return options.material === "random" ? "wheat" : options.material;
}

/** Each statistic the ceiling is added up from, and whether it adds or takes away. */
function statistics(
    material: GatherMaterial
): { objective: string; criterion: string; sign: 1 | -1 }[] {
    return MATERIALS[material].ids.flatMap((id, index) => [
        {
            objective: `pe_gp${index}`,
            criterion: `minecraft.picked_up:minecraft.${id}`,
            sign: 1 as const
        },
        {
            objective: `pe_gd${index}`,
            criterion: `minecraft.dropped:minecraft.${id}`,
            sign: -1 as const
        }
    ]);
}

/** For what is made: how many were made, and what they could have been made from. */
function making(material: GatherMaterial): {
    made: { objective: string; criterion: string };
    from: { objective: string; criterion: string; sign: 1 | -1 }[];
} | null {
    const { ids, smeltedFrom } = MATERIALS[material];
    if (!smeltedFrom) return null;
    return {
        made: { objective: "pe_gc0", criterion: `minecraft.crafted:minecraft.${ids[0]}` },
        from: smeltedFrom.flatMap((id, index) => [
            {
                objective: `pe_gr${index}`,
                criterion: `minecraft.picked_up:minecraft.${id}`,
                sign: 1 as const
            },
            {
                objective: `pe_gq${index}`,
                criterion: `minecraft.dropped:minecraft.${id}`,
                sign: -1 as const
            }
        ])
    };
}

/**
 * The objectives a round counts with, made afresh - the statistics count from
 * this moment on - and what one of its material is worth. The first round also
 * makes the points kept across rounds.
 */
export function gatheringSetup(material: GatherMaterial, first = true): string[] {
    const lines: string[] = [];
    if (first) {
        for (const objective of [BANKED, WORTH_HOLDER]) {
            lines.push(
                `scoreboard objectives remove ${objective}`,
                `scoreboard objectives add ${objective} dummy`
            );
        }
    }
    const made = making(material);
    for (const one of [...statistics(material), ...(made ? [made.made, ...made.from] : [])]) {
        lines.push(
            `scoreboard objectives remove ${one.objective}`,
            `scoreboard objectives add ${one.objective} ${one.criterion}`
        );
    }
    for (const objective of [
        HAVE,
        BASE,
        SEEN,
        CAP,
        PROGRESS,
        POINTS,
        TOTAL,
        ...(made ? [MADE, RAW] : [])
    ]) {
        lines.push(
            `scoreboard objectives remove ${objective}`,
            `scoreboard objectives add ${objective} dummy`
        );
    }
    lines.push(`scoreboard players set #worth ${WORTH_HOLDER} ${WORTH[material]}`);
    return lines;
}

/** The round that is over added to everybody's points - after its last tick,
 *  before the next round's setup empties its counts. */
export const BANK_ROUND = [
    `scoreboard players add @a ${BANKED} 0`,
    `execute as @a run scoreboard players operation @s ${BANKED} += @s ${POINTS}`
];

/**
 * Everybody's count brought up to date: what they hold now, against what they
 * held when first seen, no more than they gathered - into the side panel once
 * it is anything at all.
 */
export function gatheringTick(material: GatherMaterial): string[] {
    const { held } = MATERIALS[material];
    const lines = [
        // Somebody seen for the first time: what they hold now is where they start.
        `execute as @a unless score @s ${SEEN} matches 1 store result score @s ${BASE} run clear @s ${held} 0`,
        `scoreboard players set @a ${SEEN} 1`,
        `execute as @a store result score @s ${HAVE} run clear @s ${held} 0`,
        `scoreboard players set @a ${CAP} 0`
    ];
    const add = (target: string, one: { objective: string; sign: 1 | -1 }) => [
        `scoreboard players add @a ${one.objective} 0`,
        `execute as @a run scoreboard players operation @s ${target} ${one.sign === 1 ? "+=" : "-="} @s ${one.objective}`
    ];
    for (const one of statistics(material)) lines.push(...add(CAP, one));
    const made = making(material);
    if (made) {
        // What was made, no more than the raw material picked up could make.
        lines.push(`scoreboard players set @a ${RAW} 0`);
        for (const one of made.from) lines.push(...add(RAW, one));
        lines.push(
            `scoreboard players set @a[scores={${RAW}=..-1}] ${RAW} 0`,
            `scoreboard players set @a ${MADE} 0`,
            ...add(MADE, { objective: made.made.objective, sign: 1 }),
            `execute as @a run scoreboard players operation @s ${MADE} < @s ${RAW}`,
            `execute as @a run scoreboard players operation @s ${CAP} += @s ${MADE}`
        );
    }
    lines.push(
        `execute as @a run scoreboard players operation @s ${PROGRESS} = @s ${HAVE}`,
        `execute as @a run scoreboard players operation @s ${PROGRESS} -= @s ${BASE}`,
        `execute as @a run scoreboard players operation @s ${PROGRESS} < @s ${CAP}`,
        `scoreboard players set @a[scores={${PROGRESS}=..-1}] ${PROGRESS} 0`,
        // Points: this round's count times its worth, on top of the rounds before.
        `scoreboard players add @a ${BANKED} 0`,
        `execute as @a run scoreboard players operation @s ${POINTS} = @s ${PROGRESS}`,
        `execute as @a run scoreboard players operation @s ${POINTS} *= #worth ${WORTH_HOLDER}`,
        `execute as @a run scoreboard players operation @s ${TOTAL} = @s ${BANKED}`,
        `execute as @a run scoreboard players operation @s ${TOTAL} += @s ${POINTS}`,
        `execute as @a[scores={${TOTAL}=1..}] run scoreboard players operation @s pe_score = @s ${TOTAL}`,
        // Somebody on the panel whose count fell back to nothing shows nothing.
        `execute as @a[scores={pe_score=1..,${TOTAL}=0}] run ${setScore("@s", 0)}`
    );
    return lines;
}

/** Everybody's count, for their action bars. */
export const READ_PROGRESS = `execute as @a run scoreboard players get @s ${PROGRESS}`;

/** Every objective any gathering makes, taken back out. Fails harmlessly for
 *  the ones this one did not make. */
export function gatheringCleanup(): string[] {
    const every = new Set<string>([
        HAVE,
        BASE,
        SEEN,
        CAP,
        PROGRESS,
        MADE,
        RAW,
        BANKED,
        POINTS,
        TOTAL,
        WORTH_HOLDER
    ]);
    for (const material of GATHER_MATERIALS) {
        for (const one of statistics(material)) every.add(one.objective);
        const made = making(material);
        for (const one of made ? [made.made, ...made.from] : []) every.add(one.objective);
    }
    return [...every].map((objective) => `scoreboard objectives remove ${objective}`);
}
