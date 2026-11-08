/**
 * The classic OneBlock phases, as the plugin's own levels file.
 *
 * The plugin (MrMarL/OneBlock) ships its own ladder of thirty small levels. The
 * "classic" OneBlock is the one the original map made famous: a block that walks
 * through ten themed phases - plains, underground, ice, ocean, jungle, red
 * desert, the Nether, idyll, desolate land and the End - each with its own
 * blocks, animals and monsters. This is that ladder, written in the plugin's
 * `blocks.yml` schema so the plugin plays it with nothing else installed.
 *
 * Two things about the schema shape what is written here, both read from the
 * plugin's `ConfigManager` and `PoolRegistry`:
 *
 * - The pools are cumulative. Every entry is appended to one list and a level
 *   draws from the first N of them, so a phase still turns up every block of the
 *   phases before it. Each phase's own entries are weighted so they are at least
 *   half of what it draws from - otherwise the End would mostly be grass.
 * - A file whose `MaxLevel` is a plain string, or any of whose entries is a bare
 *   string, is "legacy" and is rewritten in place on load. Every entry here is a
 *   map, and `MaxLevel` is left empty the way the plugin's own file leaves it.
 *
 * Material and mob names are the server's own enum names; the chest names are
 * the three the plugin's bundled `chests.yml` defines.
 *
 * Pure: the data and the text. Writing it onto a server is `oneblock-service.ts`.
 */

/** The plugin's levels file, inside the server's data directory. */
export const ONEBLOCK_BLOCKS_PATH = "/data/plugins/OneBlock/blocks.yml";

/** Install config key recording which phase set Polaris wrote onto the server,
 *  so it is written once and an operator's later edits are never overwritten. */
export const ONEBLOCK_PHASES_KEY = "oneblockPhases";

/** The one phase set there is. */
export const CLASSIC_PHASES = "classic";

/** First line of the file, which is how a reader can tell Polaris wrote it. */
export const PHASES_MARKER = "# Classic OneBlock phases, written by Polaris.";

type BarColor = "PINK" | "BLUE" | "RED" | "GREEN" | "YELLOW" | "PURPLE" | "WHITE";
type ChestName = "small_chest" | "medium_chest" | "high_chest";

export interface OneBlockPhase {
    readonly name: string;
    readonly color: BarColor;
    /** Blocks broken before the next phase. */
    readonly length: number;
    readonly blocks: readonly string[];
    readonly mobs: readonly string[];
    readonly chest?: ChestName;
}

export const CLASSIC_PHASE_LIST: readonly OneBlockPhase[] = [
    {
        name: "Plains",
        color: "GREEN",
        length: 100,
        blocks: ["GRASS_BLOCK", "DIRT", "OAK_LOG", "BIRCH_LOG", "OAK_LEAVES", "PUMPKIN"],
        mobs: ["COW", "PIG", "SHEEP", "CHICKEN"],
        chest: "small_chest"
    },
    {
        name: "Underground",
        color: "WHITE",
        length: 150,
        blocks: ["STONE", "COBBLESTONE", "COAL_ORE", "IRON_ORE", "COPPER_ORE", "GRAVEL", "ANDESITE", "DIORITE", "GRANITE"],
        mobs: ["ZOMBIE", "SKELETON", "SPIDER"],
        chest: "small_chest"
    },
    {
        name: "Icy",
        color: "BLUE",
        length: 200,
        blocks: ["SNOW_BLOCK", "ICE", "PACKED_ICE", "SPRUCE_LOG", "SPRUCE_LEAVES"],
        mobs: ["POLAR_BEAR", "STRAY", "WOLF"]
    },
    {
        name: "Ocean",
        color: "BLUE",
        length: 250,
        blocks: ["SAND", "CLAY", "PRISMARINE", "DARK_PRISMARINE", "SEA_LANTERN", "SPONGE"],
        mobs: ["DROWNED", "TURTLE"],
        chest: "medium_chest"
    },
    {
        name: "Jungle",
        color: "GREEN",
        length: 300,
        blocks: ["JUNGLE_LOG", "JUNGLE_LEAVES", "MOSS_BLOCK", "MELON", "BAMBOO_BLOCK"],
        mobs: ["OCELOT", "PARROT", "PANDA"]
    },
    {
        name: "Red Desert",
        color: "RED",
        length: 350,
        blocks: ["RED_SAND", "RED_SANDSTONE", "TERRACOTTA", "ORANGE_TERRACOTTA", "GOLD_ORE"],
        mobs: ["HUSK", "RABBIT"],
        chest: "medium_chest"
    },
    {
        name: "The Nether",
        color: "RED",
        length: 400,
        blocks: [
            "NETHERRACK",
            "SOUL_SAND",
            "NETHER_QUARTZ_ORE",
            "NETHER_GOLD_ORE",
            "GLOWSTONE",
            "MAGMA_BLOCK",
            "BLACKSTONE",
            "CRIMSON_STEM",
            "WARPED_STEM"
        ],
        mobs: ["BLAZE", "MAGMA_CUBE", "PIGLIN", "WITHER_SKELETON"],
        chest: "high_chest"
    },
    {
        name: "Idyll",
        color: "PINK",
        length: 450,
        blocks: ["GRASS_BLOCK", "CHERRY_LOG", "CHERRY_LEAVES", "FLOWERING_AZALEA_LEAVES", "MOSS_BLOCK"],
        mobs: ["BEE", "FOX", "RABBIT", "HORSE"]
    },
    {
        name: "Desolate Land",
        color: "YELLOW",
        length: 500,
        blocks: ["COARSE_DIRT", "PODZOL", "MYCELIUM", "DEEPSLATE", "OBSIDIAN", "DIAMOND_ORE", "EMERALD_ORE"],
        mobs: ["WITCH", "CREEPER", "PILLAGER"],
        chest: "high_chest"
    },
    {
        name: "The End",
        color: "PURPLE",
        length: 600,
        blocks: ["END_STONE", "END_STONE_BRICKS", "PURPUR_BLOCK", "PURPUR_PILLAR", "OBSIDIAN"],
        mobs: ["ENDERMAN", "SHULKER"],
        chest: "high_chest"
    }
];

/** The weight each of a phase's own entries needs to be at least half of a pool
 *  that already holds `prior` weight from the phases before it. */
export function ownWeight(prior: number, count: number): number {
    return count === 0 ? 1 : Math.max(1, Math.ceil(prior / count));
}

/** The plugin's `blocks.yml` for these phases. */
export function phasesFile(phases: readonly OneBlockPhase[] = CLASSIC_PHASE_LIST): string {
    const lines = [PHASES_MARKER, "# Edit freely: Polaris writes this once and never again.", ""];
    let blockPool = 0;
    let mobPool = 0;
    phases.forEach((phase, index) => {
        const blockWeight = ownWeight(blockPool, phase.blocks.length);
        const mobWeight = ownWeight(mobPool, phase.mobs.length);
        // A chest is a draw from the block pool, kept rare against the phase's own blocks.
        const chestWeight = Math.max(1, Math.round(blockWeight / 4));
        lines.push(`'${index}':`, `- 'Level: ${index} - ${phase.name}'`, `- ${phase.color}`, `- ${phase.length}`);
        for (const block of phase.blocks) lines.push(`- block: ${block}`, `  weight: ${blockWeight}`);
        if (phase.chest) lines.push(`- chest: ${phase.chest}`, `  weight: ${chestWeight}`);
        for (const mob of phase.mobs) lines.push(`- mob: ${mob}`, `  weight: ${mobWeight}`);
        blockPool += blockWeight * phase.blocks.length + (phase.chest ? chestWeight : 0);
        mobPool += mobWeight * phase.mobs.length;
    });
    lines.push("MaxLevel:", "");
    return lines.join("\n");
}
