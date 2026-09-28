/**
 * A gathering: one material announced at the start, and whoever gathers the
 * most of it wins.
 *
 * Nothing is ever taken from anybody. What a player holds is counted with
 * `clear <player> <item> 0`, which removes nothing and answers how many there
 * are. Their score is what they hold now minus what they held when they were
 * first seen during it - so a stack they brought along is not counted - and never
 * more than what the game's own statistics say they picked up (or, for iron,
 * smelted) since it began, less what they dropped: a stack taken out of their
 * own chest, or thrown down and picked up again, gathers nothing.
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
    /** Whether it is made rather than found - smelted - so crafting it counts. */
    readonly crafted?: boolean;
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
    iron_ingot: { held: "minecraft:iron_ingot", ids: ["iron_ingot"], crafted: true },
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
const BASE = "pe_base";
const SEEN = "pe_seen";
const CAP = "pe_cap";
/** What each player has gathered so far, zero included, for their action bar. */
export const PROGRESS = "pe_prog";

/** The material for one run: the one chosen, or one drawn from the list. */
export function drawMaterial(
    options: EventOptions<"gathering">,
    random: () => number
): GatherMaterial {
    if (options.material !== "random") return options.material;
    return GATHER_MATERIALS[Math.floor(random() * GATHER_MATERIALS.length)] ?? "wheat";
}

/** The material a stored run is for, whatever was written. */
export function materialOf(stored: string | null, options: EventOptions<"gathering">): GatherMaterial {
    const known = GATHER_MATERIALS.find((one) => one === stored);
    if (known) return known;
    return options.material === "random" ? "wheat" : options.material;
}

/** Each statistic the ceiling is added up from, and whether it adds or takes away. */
function statistics(material: GatherMaterial): { objective: string; criterion: string; sign: 1 | -1 }[] {
    const { ids, crafted } = MATERIALS[material];
    return ids.flatMap((id, index) => [
        { objective: `pe_gp${index}`, criterion: `minecraft.picked_up:minecraft.${id}`, sign: 1 as const },
        { objective: `pe_gd${index}`, criterion: `minecraft.dropped:minecraft.${id}`, sign: -1 as const },
        ...(crafted
            ? [{ objective: `pe_gc${index}`, criterion: `minecraft.crafted:minecraft.${id}`, sign: 1 as const }]
            : [])
    ]);
}

/** The objectives it counts with. The statistics count from this moment on. */
export function gatheringSetup(material: GatherMaterial): string[] {
    const lines: string[] = [];
    for (const one of statistics(material)) {
        lines.push(
            `scoreboard objectives remove ${one.objective}`,
            `scoreboard objectives add ${one.objective} ${one.criterion}`
        );
    }
    for (const objective of [HAVE, BASE, SEEN, CAP, PROGRESS]) {
        lines.push(`scoreboard objectives remove ${objective}`, `scoreboard objectives add ${objective} dummy`);
    }
    return lines;
}

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
    for (const one of statistics(material)) {
        lines.push(
            `scoreboard players add @a ${one.objective} 0`,
            `execute as @a run scoreboard players operation @s ${CAP} ${one.sign === 1 ? "+=" : "-="} @s ${one.objective}`
        );
    }
    lines.push(
        `execute as @a run scoreboard players operation @s ${PROGRESS} = @s ${HAVE}`,
        `execute as @a run scoreboard players operation @s ${PROGRESS} -= @s ${BASE}`,
        `execute as @a run scoreboard players operation @s ${PROGRESS} < @s ${CAP}`,
        `scoreboard players set @a[scores={${PROGRESS}=..-1}] ${PROGRESS} 0`,
        `execute as @a[scores={${PROGRESS}=1..}] run scoreboard players operation @s pe_score = @s ${PROGRESS}`,
        // Somebody on the panel whose count fell back to nothing shows nothing.
        `execute as @a[scores={pe_score=1..,${PROGRESS}=0}] run ${setScore("@s", 0)}`
    );
    return lines;
}

/** Everybody's count, for their action bars. */
export const READ_PROGRESS = `execute as @a run scoreboard players get @s ${PROGRESS}`;

/** Every objective any gathering makes, taken back out. Fails harmlessly for
 *  the ones this one did not make. */
export function gatheringCleanup(): string[] {
    const every = new Set<string>([HAVE, BASE, SEEN, CAP, PROGRESS]);
    for (const material of GATHER_MATERIALS) {
        for (const one of statistics(material)) every.add(one.objective);
    }
    return [...every].map((objective) => `scoreboard objectives remove ${objective}`);
}
