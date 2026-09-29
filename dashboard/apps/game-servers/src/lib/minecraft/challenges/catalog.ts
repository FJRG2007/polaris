/**
 * Every challenge a Minecraft server can deal, as data: what it asks, the
 * statistics that measure it, how big it is at each difficulty, the versions
 * that have what it counts, and the rule that keeps it from being farmed.
 *
 * Everything is measured with what the game already counts - scoreboard
 * statistics, advancements, what a player holds - so nothing is installed on
 * the server and nothing of a player's is ever touched: a challenge only reads.
 *
 * The rules each template encodes (see `progress.ts`):
 * - blocks mined count net of the same blocks placed (`mined - used`), so
 *   silk-touching a block down and up again adds nothing;
 * - items picked up count net of the same items dropped, so throwing a stack
 *   and picking it back up adds nothing, and a chest's stock never counts;
 * - a craft that can be undone (ingot and block) is never counted alone - it is
 *   capped by the raw material the player picked up;
 * - whatever rose while the player stood still is not credited (AFK farms);
 * - a player caught by Anti X-Ray loses the day's mining progress.
 *
 * Pure and free of anything server-side: the screen explains every template
 * from this same list.
 */

import { ORES } from "../events/commands";

export const CATEGORIES = [
    "mining",
    "combat",
    "farming",
    "fishing",
    "exploration",
    "crafting",
    "taming",
    "nether",
    "building",
    "social",
    "collection"
] as const;
export type Category = (typeof CATEGORIES)[number];

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Where a template can be dealt: the daily three, the weekly three, the
 *  month's bingo card, and a server-wide community goal. */
export const LAYERS = ["daily", "weekly", "card", "community"] as const;
export type Layer = (typeof LAYERS)[number];

export type Language = "en" | "es";
export type Text = Readonly<Record<Language, string>>;

/** A version as numbers, `[1, 17]` for 1.17. */
export type Version = readonly number[];

/** One counted statistic and which way it counts. */
export interface Part {
    /** The scoreboard criterion, `minecraft.mined:minecraft.diamond_ore`. */
    readonly criterion: string;
    readonly sign: 1 | -1;
}

/**
 * How a template is measured.
 *
 * - `sum`: the signed statistics added up. `capBy` holds it at or under a
 *   second sum (smelted ingots under raw iron picked up); `gate` credits a rise
 *   only in a look where the gate rose too (a treasure only while fishing);
 *   `requires` must reach its own figure before the challenge can complete.
 * - `distinct`: how many groups have reached at least one (kinds of mob killed).
 * - `survive`: a live figure that death resets, and a movement requirement.
 * - `advancement`: how many of these advancements were earned since dealt.
 * - `criteria`: how many criteria of these advancements were earned since the
 *   period began, read from the player's advancements file.
 * - `advancements`: how many advancements of any kind were completed since then.
 * - `held`: how many of these items the player holds now and obtained since
 *   the period began (picked up or crafted, minus dropped).
 * - `polaris`: measured by Polaris from what it watches (positions, events,
 *   the chat).
 */
export type Check =
    | {
          readonly kind: "sum";
          readonly parts: readonly Part[];
          readonly capBy?: readonly Part[];
          readonly gate?: readonly Part[];
          readonly requires?: {
              readonly parts: readonly Part[];
              /** An absolute figure, or a share of the target. */
              readonly atLeast?: number;
              readonly share?: number;
          };
      }
    | { readonly kind: "distinct"; readonly groups: readonly (readonly Part[])[] }
    | {
          readonly kind: "survive";
          readonly parts: readonly Part[];
          readonly requires: { readonly parts: readonly Part[]; readonly atLeast: number };
      }
    | { readonly kind: "advancement"; readonly ids: readonly string[] }
    | { readonly kind: "criteria"; readonly ids: readonly string[] }
    | { readonly kind: "advancements" }
    | { readonly kind: "held"; readonly items: readonly string[] }
    | { readonly kind: "polaris"; readonly measure: Measure; readonly parts?: readonly Part[] };

export const MEASURES = [
    "nether-distance",
    "villages",
    "together",
    "community-share",
    "events-ranked",
    "events-podium",
    "chat-games",
    "welcome"
] as const;
export type Measure = (typeof MEASURES)[number];

/** A way one template can be dealt: a mob to hunt, a mount to ride. */
export interface Variant {
    readonly key: string;
    readonly label: Text;
    readonly check: Check;
    /** How often it comes up against the others, 1 by default. */
    readonly weight?: number;
    readonly minVersion?: Version;
}

export interface Template {
    /** The research code, `M1`. Stable: stored in every dealt challenge. */
    readonly id: string;
    readonly category: Category;
    /** Templates that measure the same thing: at most one of a group per pool. */
    readonly group: string;
    /** What the player reads, `%n` for the target and `%v` for the variant. */
    readonly title: Text;
    /** What counts, for the screen's explanation. */
    readonly how: Text;
    /** What would be farmed, and what stops it. */
    readonly exploit: Text;
    readonly check?: Check;
    readonly variants?: readonly Variant[];
    /** In the stat's own unit. Absent where a layer cannot deal it. */
    readonly targets?: Readonly<Partial<Record<Difficulty, number>>>;
    /** The weekly three, when not the hard target x1.5, x2 and x3. */
    readonly weekly?: readonly [number, number, number];
    /** On the bingo card. Absent: the hard target. */
    readonly card?: number;
    /** A community goal, per active player; absent where it cannot be one. */
    readonly community?: number;
    readonly layers: readonly Layer[];
    /** How a stat's unit is shown: centimetres as blocks, ticks as hours. */
    readonly unit: Unit;
    readonly minVersion?: Version;
    /** How often it comes up against others of its category, 1 by default. */
    readonly weight?: number;
    /** Most a player may be credited per minute, in the stat's unit. */
    readonly perMinute?: number;
    /** Only dealt as an easy one. */
    readonly easyOnly?: boolean;
    /** Dealt instead to a player who already has everything this one asks for. */
    readonly fallback?: string;
    /** Behaviour worth checking on a test world before trusting it. */
    readonly uncertain?: boolean;
}

export const UNITS = ["count", "blocks", "hours", "hearts", "percent"] as const;
export type Unit = (typeof UNITS)[number];

/** What one of a unit is in the stat's own figures. */
export const UNIT_DIVISOR: Readonly<Record<Unit, number>> = {
    count: 1,
    blocks: 100,
    hours: 72_000,
    hearts: 20,
    percent: 1
};

// ------------------------------------------------------------------ building blocks

const stat = (type: string, id: string, sign: 1 | -1 = 1): Part => ({
    criterion: `minecraft.${type}:minecraft.${id}`,
    sign
});
const each = (type: string, ids: readonly string[], sign: 1 | -1 = 1): Part[] =>
    ids.map((id) => stat(type, id, sign));
const mined = (ids: readonly string[]) => each("mined", ids);
const placed = (ids: readonly string[]) => each("used", ids, -1);
const used = (ids: readonly string[]) => each("used", ids);
const killed = (ids: readonly string[]) => each("killed", ids);
const crafted = (ids: readonly string[]) => each("crafted", ids);
const custom = (ids: readonly string[]) => each("custom", ids);
/** Picked up, minus dropped: what was gathered, not thrown and taken back. */
const gathered = (ids: readonly string[]) => [...each("picked_up", ids), ...each("dropped", ids, -1)];
/** Mined, minus placed: what was dug, not put down and dug again. */
const dug = (ids: readonly string[]) => [...mined(ids), ...placed(ids)];
/** Placed, minus mined: what stayed put. */
const built = (ids: readonly string[]) => [...used(ids), ...each("mined", ids, -1)];

const sum = (parts: readonly Part[]): Check => ({ kind: "sum", parts });
const t = (en: string, es: string): Text => ({ en, es });

const ALL_ORES = ORES.map(([id]) => id);
const HOSTILE = [
    "zombie",
    "husk",
    "drowned",
    "zombie_villager",
    "skeleton",
    "stray",
    "bogged",
    "spider",
    "cave_spider",
    "creeper",
    "slime",
    "magma_cube",
    "silverfish",
    "endermite",
    "zombified_piglin",
    "pillager",
    "vex",
    "enderman",
    "witch",
    "blaze",
    "phantom",
    "guardian",
    "hoglin",
    "vindicator",
    "ghast",
    "wither_skeleton",
    "zoglin",
    "shulker",
    "breeze",
    "piglin_brute",
    "evoker",
    "ravager",
    "elder_guardian",
    "warden"
];
const COLORS = [
    "white",
    "orange",
    "magenta",
    "light_blue",
    "yellow",
    "lime",
    "pink",
    "gray",
    "light_gray",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black"
];
const TOOLS = ["pickaxe", "axe", "shovel", "hoe", "sword", "helmet", "chestplate", "leggings", "boots"];
const SHERDS = [
    "angler",
    "archer",
    "arms_up",
    "blade",
    "brewer",
    "burn",
    "danger",
    "explorer",
    "friend",
    "heart",
    "heartbreak",
    "howl",
    "miner",
    "mourner",
    "plenty",
    "prize",
    "sheaf",
    "shelter",
    "skull",
    "snort",
    "flow",
    "guster",
    "scrape"
].map((name) => `${name}_pottery_sherd`);
const DISCS = [
    "13",
    "cat",
    "blocks",
    "chirp",
    "far",
    "mall",
    "mellohi",
    "stal",
    "strad",
    "ward",
    "11",
    "wait",
    "pigstep",
    "otherside",
    "5",
    "relic",
    "creator",
    "creator_music_box",
    "precipice"
].map((name) => `music_disc_${name}`);
const BUILDING = [
    "cobblestone",
    "stone",
    "stone_bricks",
    "bricks",
    "smooth_stone",
    "sandstone",
    "andesite",
    "polished_andesite",
    "oak_planks",
    "spruce_planks",
    "birch_planks",
    "jungle_planks",
    "acacia_planks",
    "dark_oak_planks",
    "cobbled_deepslate",
    "deepslate_bricks"
];
const SAPLINGS = [
    "oak_sapling",
    "spruce_sapling",
    "birch_sapling",
    "jungle_sapling",
    "acacia_sapling",
    "dark_oak_sapling",
    "cherry_sapling",
    "mangrove_propagule"
];
const WALKING = custom(["walk_one_cm", "sprint_one_cm", "crouch_one_cm"]);

/** Sprinting flat out for a minute, with a little to spare: more than this in a
 *  minute on foot is a machine, not a player. */
const ON_FOOT_PER_MINUTE = 36_000;

// ------------------------------------------------------------------ the templates

export const TEMPLATES: readonly Template[] = [
    // ---------------------------------------------------------------- mining
    {
        id: "M1",
        category: "mining",
        group: "ores",
        title: t("Mine %n ore blocks", "Pica %n bloques de mena"),
        how: t(
            "Every ore block mined, of any kind, minus every ore block placed.",
            "Cada bloque de mena picado, de cualquier tipo, menos cada bloque de mena colocado."
        ),
        exploit: t(
            "Silk-touching an ore down and mining it again nets zero: placed ore is taken off. Anti X-Ray catches void the day's mining.",
            "Colocar una mena con toque de seda y volver a picarla suma cero: la mena colocada se resta. Quien caiga en el Anti X-Ray pierde la minería del día."
        ),
        check: sum(dug(ALL_ORES)),
        targets: { easy: 32, medium: 96, hard: 256 },
        community: 200,
        layers: ["daily", "weekly", "card", "community"],
        unit: "count"
    },
    {
        id: "M2",
        category: "mining",
        group: "ores",
        title: t("Mine %n diamond ore", "Pica %n menas de diamante"),
        how: t(
            "Diamond ore and deepslate diamond ore mined, minus placed.",
            "Mena de diamante y de diamante de pizarra profunda picadas, menos las colocadas."
        ),
        exploit: t(
            "Placed diamond ore is taken off. Anti X-Ray catches void the day's mining.",
            "La mena de diamante colocada se resta. Quien caiga en el Anti X-Ray pierde la minería del día."
        ),
        check: sum(dug(["diamond_ore", "deepslate_diamond_ore"])),
        targets: { easy: 3, medium: 8, hard: 16 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "M3",
        category: "mining",
        group: "ores",
        title: t("Mine %n ancient debris", "Pica %n escombros ancestrales"),
        how: t("Ancient debris mined, minus placed.", "Escombros ancestrales picados, menos los colocados."),
        exploit: t(
            "Placed debris is taken off. Anti X-Ray catches void the day's mining.",
            "Los escombros colocados se restan. Quien caiga en el Anti X-Ray pierde la minería del día."
        ),
        check: sum(dug(["ancient_debris"])),
        targets: { easy: 2, medium: 5, hard: 12 },
        layers: ["daily", "weekly", "card"],
        unit: "count",
        minVersion: [1, 16]
    },
    {
        id: "M4",
        category: "mining",
        group: "deep",
        title: t("Tunnel through %n deepslate and tuff", "Excava %n bloques de pizarra profunda y toba"),
        how: t(
            "Deepslate and tuff mined, minus placed. Not stone or cobblestone, which generators make endlessly.",
            "Pizarra profunda y toba picadas, menos las colocadas. Ni piedra ni roca, que los generadores fabrican sin fin."
        ),
        exploit: t(
            "Deepslate and tuff cannot be generated; placed blocks are taken off.",
            "La pizarra profunda y la toba no se pueden generar; los bloques colocados se restan."
        ),
        check: sum(dug(["deepslate", "tuff"])),
        targets: { easy: 300, medium: 1000, hard: 3000 },
        community: 1500,
        layers: ["daily", "weekly", "card", "community"],
        unit: "count",
        minVersion: [1, 17]
    },
    {
        id: "M5",
        category: "mining",
        group: "ores",
        title: t("Mine %n emerald ore", "Pica %n menas de esmeralda"),
        how: t("Emerald ore of both kinds mined, minus placed.", "Mena de esmeralda de los dos tipos picada, menos la colocada."),
        exploit: t(
            "Placed emerald ore is taken off. Anti X-Ray catches void the day's mining.",
            "La mena de esmeralda colocada se resta. Quien caiga en el Anti X-Ray pierde la minería del día."
        ),
        check: sum(dug(["emerald_ore", "deepslate_emerald_ore"])),
        targets: { easy: 1, medium: 3, hard: 6 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "M6",
        category: "mining",
        group: "obsidian",
        title: t("Break %n obsidian", "Rompe %n bloques de obsidiana"),
        how: t("Obsidian mined, minus obsidian placed.", "Obsidiana picada, menos la colocada."),
        exploit: t(
            "Placed obsidian is taken off. Making obsidian from lava and water is real work and counts.",
            "La obsidiana colocada se resta. Hacer obsidiana con lava y agua es trabajo de verdad y cuenta."
        ),
        check: sum(dug(["obsidian"])),
        targets: { easy: 10, medium: 32, hard: 64 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "M7",
        category: "mining",
        group: "amethyst",
        title: t("Harvest %n amethyst clusters", "Recoge %n racimos de amatista"),
        how: t("Amethyst clusters mined, minus placed.", "Racimos de amatista picados, menos los colocados."),
        exploit: t(
            "Clusters regrow on their own, which is fair farming; placed clusters are taken off.",
            "Los racimos vuelven a crecer solos, lo que es un cultivo justo; los racimos colocados se restan."
        ),
        check: sum(dug(["amethyst_cluster"])),
        targets: { easy: 8, medium: 24, hard: 64 },
        layers: ["daily", "weekly", "card"],
        unit: "count",
        minVersion: [1, 17]
    },
    {
        id: "M8",
        category: "mining",
        group: "wear",
        title: t("Wear out %n pickaxes", "Desgasta %n picos"),
        how: t(
            "Iron, diamond and netherite pickaxes used until they broke.",
            "Picos de hierro, diamante y netherita usados hasta romperse."
        ),
        exploit: t(
            "Nothing to farm: a pickaxe has to be used up. Weekly only, since Mending keeps many from ever breaking.",
            "No hay nada que explotar: el pico tiene que gastarse. Solo semanal, porque Reparación evita que muchos se rompan."
        ),
        check: sum(each("broken", ["iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe"])),
        weekly: [1, 2, 3],
        card: 2,
        layers: ["weekly", "card"],
        unit: "count"
    },
    {
        id: "M9",
        category: "mining",
        group: "ores",
        title: t("Mine %n copper ore", "Pica %n menas de cobre"),
        how: t("Copper ore of both kinds mined, minus placed.", "Mena de cobre de los dos tipos picada, menos la colocada."),
        exploit: t(
            "Placed copper ore is taken off. Anti X-Ray catches void the day's mining.",
            "La mena de cobre colocada se resta. Quien caiga en el Anti X-Ray pierde la minería del día."
        ),
        check: sum(dug(["copper_ore", "deepslate_copper_ore"])),
        targets: { easy: 16, medium: 48, hard: 128 },
        layers: ["daily", "weekly", "card"],
        unit: "count",
        minVersion: [1, 17]
    },
    {
        id: "M10",
        category: "mining",
        group: "quartz",
        title: t("Mine %n nether quartz ore", "Pica %n menas de cuarzo del Nether"),
        how: t("Nether quartz ore mined, minus placed.", "Mena de cuarzo del Nether picada, menos la colocada."),
        exploit: t(
            "Placed quartz ore is taken off. Anti X-Ray catches void the day's mining.",
            "La mena de cuarzo colocada se resta. Quien caiga en el Anti X-Ray pierde la minería del día."
        ),
        check: sum(dug(["nether_quartz_ore"])),
        targets: { easy: 32, medium: 96, hard: 256 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },

    // ---------------------------------------------------------------- combat
    {
        id: "C1",
        category: "combat",
        group: "kills",
        title: t("Slay %n hostile mobs", "Acaba con %n mobs hostiles"),
        how: t("Any hostile mob killed.", "Cualquier mob hostil eliminado."),
        exploit: t(
            "Kills while standing still at a mob farm are not credited, and at most 20 a minute count.",
            "Las muertes sin moverse en una granja de mobs no cuentan, y como mucho cuentan 20 por minuto."
        ),
        check: sum(killed(HOSTILE)),
        targets: { easy: 30, medium: 100, hard: 300 },
        community: 150,
        perMinute: 20,
        layers: ["daily", "weekly", "card", "community"],
        unit: "count"
    },
    {
        id: "C2",
        category: "combat",
        group: "kills",
        title: t("Hunt %n %v", "Caza %n %v"),
        how: t("One kind of mob killed, drawn each time.", "Un tipo de mob eliminado, sorteado cada vez."),
        exploit: t(
            "Kinds with common farms come up less often; kills while standing still are not credited.",
            "Los tipos con granjas habituales salen menos; las muertes sin moverse no cuentan."
        ),
        variants: [
            { key: "zombie", label: t("zombies", "zombis"), check: sum(killed(["zombie"])), weight: 0.5 },
            { key: "skeleton", label: t("skeletons", "esqueletos"), check: sum(killed(["skeleton"])), weight: 0.5 },
            { key: "creeper", label: t("creepers", "creepers"), check: sum(killed(["creeper"])) },
            { key: "spider", label: t("spiders", "arañas"), check: sum(killed(["spider"])) },
            { key: "enderman", label: t("endermen", "endermans"), check: sum(killed(["enderman"])), weight: 0.5 },
            { key: "drowned", label: t("drowned", "ahogados"), check: sum(killed(["drowned"])) },
            { key: "witch", label: t("witches", "brujas"), check: sum(killed(["witch"])) },
            { key: "phantom", label: t("phantoms", "phantoms"), check: sum(killed(["phantom"])) },
            { key: "slime", label: t("slimes", "slimes"), check: sum(killed(["slime"])) }
        ],
        targets: { easy: 10, medium: 25, hard: 60 },
        perMinute: 15,
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "C3",
        category: "combat",
        group: "variety",
        title: t("Kill %n different kinds of hostile mob", "Mata %n tipos distintos de mob hostil"),
        how: t(
            "How many kinds of hostile mob were killed at least once.",
            "Cuántos tipos de mob hostil se han matado al menos una vez."
        ),
        exploit: t(
            "Farm-proof by design: a farm makes one kind, and every kind counts once.",
            "A prueba de granjas: una granja da un solo tipo, y cada tipo cuenta una vez."
        ),
        check: { kind: "distinct", groups: HOSTILE.map((id) => killed([id])) },
        targets: { easy: 4, medium: 7, hard: 12 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "C4",
        category: "combat",
        group: "raid",
        title: t("Win %n raids", "Gana %n asaltos"),
        how: t("Raids won.", "Asaltos ganados."),
        exploit: t(
            "Raid farms exist, so it is weekly only and never more than two.",
            "Existen granjas de asaltos, así que es solo semanal y nunca más de dos."
        ),
        check: sum(custom(["raid_win"])),
        weekly: [1, 1, 2],
        card: 1,
        layers: ["weekly", "card"],
        unit: "count",
        minVersion: [1, 14]
    },
    {
        id: "C5",
        category: "combat",
        group: "illagers",
        title: t("Defeat %n illagers", "Derrota a %n illagers"),
        how: t("Pillagers, vindicators, evokers and ravagers killed.", "Saqueadores, vindicadores, invocadores y devastadores eliminados."),
        exploit: t(
            "Kills while standing still at a raid farm are not credited.",
            "Las muertes sin moverse en una granja de asaltos no cuentan."
        ),
        check: sum(killed(["pillager", "vindicator", "evoker", "ravager"])),
        targets: { easy: 5, medium: 15, hard: 40 },
        perMinute: 15,
        layers: ["daily", "weekly", "card"],
        unit: "count",
        minVersion: [1, 14]
    },
    {
        id: "C6",
        category: "combat",
        group: "shield",
        title: t("Block %n hearts of damage with a shield", "Bloquea %n corazones de daño con un escudo"),
        how: t("Damage blocked with a shield.", "Daño bloqueado con un escudo."),
        exploit: t(
            "Standing still next to a mob to soak hits is not credited.",
            "Quedarse quieto junto a un mob para recibir golpes no cuenta."
        ),
        check: sum(custom(["damage_blocked_by_shield"])),
        targets: { easy: 100, medium: 400, hard: 1500 },
        layers: ["daily", "weekly", "card"],
        unit: "hearts",
        minVersion: [1, 14]
    },
    {
        id: "C7",
        category: "combat",
        group: "damage",
        title: t("Deal %n hearts of damage", "Inflige %n corazones de daño"),
        how: t("Damage dealt to anything.", "Daño infligido a lo que sea."),
        exploit: t(
            "Damage dealt while standing still is not credited, and at most 150 hearts a minute count.",
            "El daño hecho sin moverse no cuenta, y como mucho cuentan 150 corazones por minuto."
        ),
        check: sum(custom(["damage_dealt"])),
        targets: { easy: 3000, medium: 10000, hard: 30000 },
        perMinute: 3000,
        layers: ["daily", "weekly", "card"],
        unit: "hearts"
    },
    {
        id: "C8",
        category: "combat",
        group: "boss",
        title: t("Defeat a boss", "Derrota a un jefe"),
        how: t("A wither, an elder guardian or a warden killed.", "Un wither, un guardián anciano o un warden eliminados."),
        exploit: t(
            "Wither farms exist, so it is on the season card only, once.",
            "Existen granjas de wither, así que solo está en el cartón de temporada, una vez."
        ),
        check: sum(killed(["wither", "elder_guardian", "warden"])),
        card: 1,
        layers: ["card"],
        unit: "count"
    },
    {
        id: "C9",
        category: "combat",
        group: "deathless",
        title: t("Play %n hours without dying", "Juega %n horas sin morir"),
        how: t(
            "Time since your last death, counting only while you play, and at least 500 blocks walked in it.",
            "Tiempo desde tu última muerte, contando solo mientras juegas, y al menos 500 bloques recorridos en él."
        ),
        exploit: t(
            "Hiding in a safe box does not count: time standing still is not credited, and the walking is required.",
            "Esconderse en una caja segura no sirve: el tiempo quieto no cuenta, y la caminata es obligatoria."
        ),
        check: {
            kind: "survive",
            parts: custom(["time_since_death"]),
            requires: { parts: WALKING, atLeast: 50_000 }
        },
        targets: { easy: 72_000, medium: 216_000, hard: 432_000 },
        layers: ["daily", "weekly", "card"],
        unit: "hours"
    },
    {
        id: "C10",
        category: "combat",
        group: "sniper",
        title: t("Earn Sniper Duel or Arbalistic", "Consigue Duelo de francotiradores o Ballestería"),
        how: t(
            "The Sniper Duel or Arbalistic advancement earned since the card was dealt.",
            "El progreso Duelo de francotiradores o Ballestería conseguido desde que se repartió el cartón."
        ),
        exploit: t("Advancements are once per world.", "Los progresos son una vez por mundo."),
        check: { kind: "advancement", ids: ["adventure/sniper_duel", "adventure/arbalistic"] },
        card: 1,
        fallback: "C7",
        layers: ["card"],
        unit: "count"
    },
    {
        id: "C11",
        category: "combat",
        group: "ender",
        title: t("Slay %n End creatures", "Acaba con %n criaturas del End"),
        how: t("Endermen, endermites and shulkers killed.", "Endermans, endermites y shulkers eliminados."),
        exploit: t(
            "Kills while standing still at an enderman farm are not credited, at most 15 a minute.",
            "Las muertes sin moverse en una granja de endermans no cuentan, como mucho 15 por minuto."
        ),
        check: sum(killed(["enderman", "endermite", "shulker"])),
        targets: { easy: 10, medium: 30, hard: 80 },
        perMinute: 15,
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },

    // ---------------------------------------------------------------- farming
    {
        id: "F1",
        category: "farming",
        group: "wheat",
        title: t("Harvest %n wheat", "Cosecha %n de trigo"),
        how: t("Wheat picked up, minus wheat dropped.", "Trigo recogido, menos el trigo tirado."),
        exploit: t(
            "A chest's stock is never picked up; throwing wheat and picking it back up nets zero.",
            "El contenido de un cofre nunca se recoge; tirar trigo y volver a cogerlo suma cero."
        ),
        check: sum(gathered(["wheat"])),
        targets: { easy: 64, medium: 192, hard: 512 },
        community: 300,
        layers: ["daily", "weekly", "card", "community"],
        unit: "count"
    },
    {
        id: "F2",
        category: "farming",
        group: "roots",
        title: t("Harvest %n root vegetables", "Cosecha %n hortalizas"),
        how: t("Carrots, potatoes and beetroots picked up, minus dropped.", "Zanahorias, patatas y remolachas recogidas, menos las tiradas."),
        exploit: t(
            "Dropping and picking up again nets zero; a chest's stock never counts.",
            "Tirar y volver a coger suma cero; el contenido de un cofre nunca cuenta."
        ),
        check: sum(gathered(["carrot", "potato", "beetroot"])),
        targets: { easy: 64, medium: 192, hard: 512 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "F3",
        category: "farming",
        group: "tall-crops",
        title: t("Gather %n %v", "Recoge %n de %v"),
        how: t("One crop picked up, minus dropped, drawn each time.", "Un cultivo recogido, menos lo tirado, sorteado cada vez."),
        exploit: t(
            "Collecting from an automatic farm while standing still is not credited, at most 64 a minute.",
            "Recoger de una granja automática sin moverse no cuenta, como mucho 64 por minuto."
        ),
        variants: [
            { key: "sugar_cane", label: t("sugar cane", "caña de azúcar"), check: sum(gathered(["sugar_cane"])) },
            { key: "bamboo", label: t("bamboo", "bambú"), check: sum(gathered(["bamboo"])), minVersion: [1, 14] },
            { key: "kelp", label: t("kelp", "algas"), check: sum(gathered(["kelp"])) }
        ],
        targets: { easy: 64, medium: 256, hard: 640 },
        perMinute: 64,
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "F4",
        category: "farming",
        group: "gourds",
        title: t("Harvest %n pumpkins and melons", "Cosecha %n calabazas y sandías"),
        how: t("Pumpkins and melons mined, minus placed.", "Calabazas y sandías rotas, menos las colocadas."),
        exploit: t(
            "Placing a pumpkin and breaking it again nets zero.",
            "Colocar una calabaza y volver a romperla suma cero."
        ),
        check: sum(dug(["pumpkin", "melon"])),
        targets: { easy: 16, medium: 48, hard: 128 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "F5",
        category: "farming",
        group: "bone-meal",
        title: t("Use %n bone meal", "Usa %n polvos de hueso"),
        how: t("Bone meal used.", "Polvo de hueso usado."),
        exploit: t("Bone meal is spent each time, so there is nothing to loop.", "El polvo de hueso se gasta cada vez, así que no hay bucle."),
        check: sum(used(["bone_meal"])),
        targets: { easy: 32, medium: 96, hard: 256 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "F6",
        category: "farming",
        group: "chef",
        title: t("Cook %n meals", "Cocina %n platos"),
        how: t(
            "Cooked meat and fish, baked potatoes and bread taken out of a furnace or crafted.",
            "Carne y pescado cocinados, patatas asadas y pan sacados del horno o fabricados."
        ),
        exploit: t("None of these can be turned back into what they were made from.", "Ninguno de ellos se puede volver a convertir en lo que era."),
        check: sum(
            crafted([
                "cooked_beef",
                "cooked_porkchop",
                "cooked_chicken",
                "cooked_mutton",
                "cooked_cod",
                "cooked_salmon",
                "baked_potato",
                "bread"
            ])
        ),
        targets: { easy: 32, medium: 96, hard: 256 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "F7",
        category: "farming",
        group: "cake",
        title: t("Eat %n slices of cake", "Come %n porciones de tarta"),
        how: t("Cake slices eaten.", "Porciones de tarta comidas."),
        exploit: t("Each slice has to be baked first.", "Cada porción hay que hornearla antes."),
        check: sum(custom(["eat_cake_slice"])),
        targets: { easy: 7, medium: 14, hard: 28 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "F8",
        category: "farming",
        group: "bees",
        title: t("Collect %n honeycomb", "Recoge %n panales"),
        how: t("Honeycomb picked up, minus dropped.", "Panal recogido, menos el tirado."),
        exploit: t("Dropping and picking up again nets zero.", "Tirar y volver a coger suma cero."),
        check: sum(gathered(["honeycomb"])),
        targets: { easy: 6, medium: 18, hard: 48 },
        layers: ["daily", "weekly", "card"],
        unit: "count",
        minVersion: [1, 15]
    },
    {
        id: "F9",
        category: "farming",
        group: "diet",
        title: t("Taste %n new foods", "Prueba %n comidas nuevas"),
        how: t(
            "Foods of A Balanced Diet eaten for the first time since the period began.",
            "Comidas de Una dieta equilibrada probadas por primera vez desde que empezó el periodo."
        ),
        exploit: t(
            "Each food counts once per world. A player who has eaten them all gets Cook instead.",
            "Cada comida cuenta una vez por mundo. Quien ya las ha probado todas recibe Cocina en su lugar."
        ),
        check: { kind: "criteria", ids: ["husbandry/balanced_diet"] },
        targets: { easy: 3, medium: 6, hard: 10 },
        weekly: [3, 6, 10],
        card: 6,
        fallback: "F6",
        layers: ["weekly", "card"],
        unit: "count"
    },
    {
        id: "F10",
        category: "farming",
        group: "pots",
        title: t("Pot %n plants", "Planta %n cosas en macetas"),
        how: t("Plants put into flower pots.", "Plantas puestas en macetas."),
        exploit: t(
            "Taking a plant out and potting it again may count each time, so it is only ever an easy one.",
            "Sacar una planta y volver a plantarla puede contar cada vez, así que solo sale como fácil."
        ),
        check: sum(custom(["pot_flower"])),
        targets: { easy: 3, medium: 8, hard: 20 },
        easyOnly: true,
        weight: 0.5,
        uncertain: true,
        layers: ["daily"],
        unit: "count"
    },

    // ---------------------------------------------------------------- fishing
    {
        id: "Fi1",
        category: "fishing",
        group: "fish",
        title: t("Catch %n fish", "Pesca %n peces"),
        how: t("Anything caught with a fishing rod.", "Cualquier cosa pescada con una caña."),
        exploit: t(
            "An auto-clicker never turns: catches while not moving or turning are not credited, at most 6 a minute.",
            "Un autoclicker nunca gira: lo pescado sin moverse ni girar no cuenta, como mucho 6 por minuto."
        ),
        check: sum(custom(["fish_caught"])),
        targets: { easy: 15, medium: 50, hard: 150 },
        community: 60,
        perMinute: 6,
        layers: ["daily", "weekly", "card", "community"],
        unit: "count"
    },
    {
        id: "Fi2",
        category: "fishing",
        group: "treasure",
        title: t("Fish up %n treasures", "Pesca %n tesoros"),
        how: t(
            "Name tags, saddles, nautilus shells and enchanted books picked up while fishing, minus dropped.",
            "Etiquetas, sillas de montar, caparazones de nautilo y libros encantados recogidos mientras pescas, menos los tirados."
        ),
        exploit: t(
            "Only counts in a moment where a catch was made too, so a treasure out of a chest does not.",
            "Solo cuenta en un momento en que también se pescó algo, así que un tesoro sacado de un cofre no vale."
        ),
        check: {
            kind: "sum",
            parts: gathered(["name_tag", "saddle", "nautilus_shell", "enchanted_book"]),
            gate: custom(["fish_caught"])
        },
        targets: { easy: 1, medium: 3, hard: 6 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "Fi3",
        category: "fishing",
        group: "tropical",
        title: t("Catch %n %v", "Pesca %n %v"),
        how: t("One kind of fish picked up, minus dropped.", "Un tipo de pez recogido, menos los tirados."),
        exploit: t("Dropping and picking up again nets zero.", "Tirar y volver a coger suma cero."),
        variants: [
            { key: "pufferfish", label: t("pufferfish", "peces globo"), check: sum(gathered(["pufferfish"])) },
            { key: "tropical_fish", label: t("tropical fish", "peces tropicales"), check: sum(gathered(["tropical_fish"])) }
        ],
        targets: { easy: 2, medium: 5, hard: 12 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "Fi4",
        category: "fishing",
        group: "salmon",
        title: t("Land %n cod and salmon", "Pesca %n bacalaos y salmones"),
        how: t(
            "Cod and salmon picked up, minus dropped, with at least half of it caught on a rod.",
            "Bacalao y salmón recogidos, menos lo tirado, con al menos la mitad pescada con caña."
        ),
        exploit: t(
            "Guardian farms drop cod, so half the target has to be real catches.",
            "Las granjas de guardianes sueltan bacalao, así que la mitad del objetivo tiene que ser pesca de verdad."
        ),
        check: {
            kind: "sum",
            parts: gathered(["cod", "salmon"]),
            requires: { parts: custom(["fish_caught"]), share: 0.5 }
        },
        targets: { easy: 10, medium: 30, hard: 80 },
        uncertain: true,
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "Fi5",
        category: "fishing",
        group: "tactical",
        title: t("Catch a fish in a bucket", "Atrapa un pez con un cubo"),
        how: t(
            "Tactical Fishing or The Cutest Predator earned since the card was dealt.",
            "Pesca táctica o El depredador más mono conseguido desde que se repartió el cartón."
        ),
        exploit: t("Advancements are once per world.", "Los progresos son una vez por mundo."),
        check: { kind: "advancement", ids: ["husbandry/tactical_fishing", "husbandry/axolotl_in_a_bucket"] },
        card: 1,
        fallback: "Fi1",
        layers: ["card"],
        unit: "count"
    },

    // ---------------------------------------------------------------- exploration
    {
        id: "E1",
        category: "exploration",
        group: "walk",
        title: t("Walk %n blocks", "Camina %n bloques"),
        how: t("Distance walked, sprinted and sneaked.", "Distancia recorrida andando, corriendo y agachado."),
        exploit: t(
            "Walking into a wall covers no distance; more than sprint speed in a minute is not credited.",
            "Andar contra una pared no recorre nada; más de la velocidad de carrera en un minuto no cuenta."
        ),
        check: sum(WALKING),
        targets: { easy: 200_000, medium: 600_000, hard: 1_500_000 },
        community: 500_000,
        perMinute: ON_FOOT_PER_MINUTE,
        layers: ["daily", "weekly", "card", "community"],
        unit: "blocks"
    },
    {
        id: "E2",
        category: "exploration",
        group: "fly",
        title: t("Glide %n blocks with an elytra", "Planea %n bloques con élitros"),
        how: t("Distance flown with an elytra.", "Distancia volada con élitros."),
        exploit: t("Rockets cost gunpowder, so flying is effort.", "Los cohetes cuestan pólvora, así que volar es esfuerzo."),
        check: sum(custom(["aviate_one_cm"])),
        targets: { easy: 300_000, medium: 1_200_000, hard: 4_000_000 },
        layers: ["daily", "weekly", "card"],
        unit: "blocks"
    },
    {
        id: "E3",
        category: "exploration",
        group: "ride",
        title: t("Travel %n blocks by %v", "Recorre %n bloques en %v"),
        how: t("Distance ridden on one kind of mount, drawn each time.", "Distancia recorrida en un tipo de montura, sorteado cada vez."),
        exploit: t(
            "Minecarts are left out (loops); at most 1,200 blocks a minute count.",
            "Las vagonetas no cuentan (circuitos); como mucho cuentan 1.200 bloques por minuto."
        ),
        variants: [
            { key: "horse", label: t("horse", "caballo"), check: sum(custom(["horse_one_cm"])) },
            { key: "boat", label: t("boat", "barca"), check: sum(custom(["boat_one_cm"])) },
            { key: "strider", label: t("strider", "strider"), check: sum(custom(["strider_one_cm"])), minVersion: [1, 16] },
            {
                key: "happy_ghast",
                label: t("happy ghast", "ghast feliz"),
                check: sum(custom(["happy_ghast_one_cm"])),
                minVersion: [1, 21, 6]
            }
        ],
        targets: { easy: 100_000, medium: 400_000, hard: 1_000_000 },
        perMinute: 120_000,
        layers: ["daily", "weekly", "card"],
        unit: "blocks"
    },
    {
        id: "E4",
        category: "exploration",
        group: "swim",
        title: t("Swim %n blocks", "Nada %n bloques"),
        how: t("Distance swum.", "Distancia nadada."),
        exploit: t("Bubble columns do not add swimming distance.", "Las columnas de burbujas no suman distancia nadada."),
        check: sum(custom(["swim_one_cm"])),
        targets: { easy: 30_000, medium: 100_000, hard: 300_000 },
        perMinute: 30_000,
        layers: ["daily", "weekly", "card"],
        unit: "blocks"
    },
    {
        id: "E5",
        category: "exploration",
        group: "biomes",
        title: t("Discover %n new biomes", "Descubre %n biomas nuevos"),
        how: t(
            "Biomes of Adventuring Time visited for the first time since the period began.",
            "Biomas de Hora de aventuras visitados por primera vez desde que empezó el periodo."
        ),
        exploit: t(
            "Each biome counts once per world. A player who has seen them all gets Walker instead.",
            "Cada bioma cuenta una vez por mundo. Quien ya los ha visto todos recibe Caminante en su lugar."
        ),
        check: { kind: "criteria", ids: ["adventure/adventuring_time"] },
        weekly: [1, 3, 6],
        card: 3,
        fallback: "E1",
        layers: ["weekly", "card"],
        unit: "count"
    },
    {
        id: "E6",
        category: "exploration",
        group: "structures",
        title: t("Find %n new structures", "Encuentra %n estructuras nuevas"),
        how: t(
            "A fortress, a bastion, a stronghold, trial chambers or an End city, each found for the first time.",
            "Una fortaleza, un bastión, una fortaleza del End, cámaras de desafío o una ciudad del End, cada una encontrada por primera vez."
        ),
        exploit: t(
            "Each is an advancement, once per world. A player who has found them all gets Walker instead.",
            "Cada una es un progreso, una vez por mundo. Quien ya las ha encontrado todas recibe Caminante en su lugar."
        ),
        check: {
            kind: "advancement",
            ids: [
                "nether/find_fortress",
                "nether/find_bastion",
                "story/follow_ender_eye",
                "adventure/minecraft_trials_edition",
                "end/find_end_city"
            ]
        },
        card: 2,
        fallback: "E1",
        layers: ["card"],
        unit: "count"
    },
    {
        id: "E7",
        category: "exploration",
        group: "sherds",
        title: t("Dig up %n pottery sherds", "Desentierra %n fragmentos de cerámica"),
        how: t("Pottery sherds picked up, minus dropped.", "Fragmentos de cerámica recogidos, menos los tirados."),
        exploit: t(
            "Brushing drops sherds to be picked up; taking them from a chest does not count.",
            "Cepillar suelta fragmentos que se recogen; sacarlos de un cofre no cuenta."
        ),
        check: sum(gathered(SHERDS)),
        targets: { easy: 1, medium: 3, hard: 6 },
        layers: ["daily", "weekly", "card"],
        unit: "count",
        minVersion: [1, 20]
    },
    {
        id: "E8",
        category: "exploration",
        group: "climb",
        title: t("Climb %n blocks", "Trepa %n bloques"),
        how: t("Distance climbed on ladders and vines.", "Distancia trepada por escaleras y enredaderas."),
        exploit: t("Climbing needs input; standing still is not credited.", "Trepar requiere pulsar teclas; quedarse quieto no cuenta."),
        check: sum(custom(["climb_one_cm"])),
        targets: { easy: 10_000, medium: 30_000, hard: 100_000 },
        perMinute: 15_000,
        layers: ["daily", "weekly", "card"],
        unit: "blocks"
    },
    {
        id: "E9",
        category: "exploration",
        group: "nether-travel",
        title: t("Travel %n blocks in the Nether", "Recorre %n bloques en el Nether"),
        how: t(
            "Ground covered in the Nether, measured by Polaris between looks at where you are.",
            "Terreno recorrido en el Nether, medido por Polaris entre una mirada y otra a dónde estás."
        ),
        exploit: t(
            "Portals and ender pearls jump too far to be walking and are ignored.",
            "Los portales y las perlas de ender saltan demasiado lejos para ser caminar y se ignoran."
        ),
        check: { kind: "polaris", measure: "nether-distance" },
        targets: { easy: 1000, medium: 3000, hard: 8000 },
        layers: ["daily", "weekly", "card"],
        unit: "count",
        minVersion: [1, 16]
    },
    {
        id: "E10",
        category: "exploration",
        group: "villages",
        title: t("Ring the bell in %n villages", "Toca la campana en %n aldeas"),
        how: t(
            "Bells rung, counting each village (a 200-block area) once.",
            "Campanas tocadas, contando cada aldea (una zona de 200 bloques) una vez."
        ),
        exploit: t("Ringing one bell over and over counts once.", "Tocar la misma campana una y otra vez cuenta una vez."),
        check: { kind: "polaris", measure: "villages", parts: custom(["bell_ring"]) },
        targets: { easy: 2, medium: 5, hard: 10 },
        layers: ["daily", "weekly", "card"],
        unit: "count",
        minVersion: [1, 14]
    },

    // ---------------------------------------------------------------- crafting
    {
        id: "Cr1",
        category: "crafting",
        group: "enchant",
        title: t("Enchant %n items", "Encanta %n objetos"),
        how: t("Items enchanted at an enchanting table.", "Objetos encantados en una mesa de encantamientos."),
        exploit: t("Each costs lapis and levels.", "Cada uno cuesta lapislázuli y niveles."),
        check: sum(custom(["enchant_item"])),
        targets: { easy: 2, medium: 6, hard: 15 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "Cr2",
        category: "crafting",
        group: "smelt",
        title: t("Smelt %n iron ingots", "Funde %n lingotes de hierro"),
        how: t(
            "Iron ingots taken from a furnace or crafted, never more than the raw iron picked up.",
            "Lingotes de hierro sacados del horno o fabricados, nunca más que el hierro en bruto recogido."
        ),
        exploit: t(
            "Breaking a block of iron into nine ingots is not smelting: ingots count only up to raw iron gathered.",
            "Deshacer un bloque de hierro en nueve lingotes no es fundir: los lingotes cuentan solo hasta el hierro en bruto recogido."
        ),
        check: {
            kind: "sum",
            parts: crafted(["iron_ingot"]),
            capBy: gathered(["raw_iron"])
        },
        targets: { easy: 16, medium: 64, hard: 192 },
        layers: ["daily", "weekly", "card"],
        unit: "count",
        minVersion: [1, 17]
    },
    {
        id: "Cr3",
        category: "crafting",
        group: "toolsmith",
        title: t("Forge %n iron or diamond tools and armour", "Forja %n herramientas o piezas de armadura de hierro o diamante"),
        how: t("Iron and diamond tools, weapons and armour crafted.", "Herramientas, armas y armaduras de hierro y diamante fabricadas."),
        exploit: t("Each costs its material; smelting it back gives far less.", "Cada una cuesta su material; fundirla devuelve mucho menos."),
        check: sum(crafted([...TOOLS.map((one) => `iron_${one}`), ...TOOLS.map((one) => `diamond_${one}`)])),
        targets: { easy: 2, medium: 5, hard: 10 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "Cr4",
        category: "crafting",
        group: "potions",
        title: t("Drink %n potions", "Bebe %n pociones"),
        how: t("Potions drunk. Water bottles count too.", "Pociones bebidas. Las botellas de agua también cuentan."),
        exploit: t(
            "There is no brewing statistic and water bottles count, so it is weekly only and rare.",
            "No hay estadística de destilar y las botellas de agua cuentan, así que es solo semanal y sale poco."
        ),
        check: sum(used(["potion"])),
        weekly: [3, 8, 20],
        weight: 0.4,
        uncertain: true,
        layers: ["weekly"],
        unit: "count"
    },
    {
        id: "Cr5",
        category: "crafting",
        group: "mason",
        title: t("Use a stonecutter %n times", "Usa un cortapiedras %n veces"),
        how: t("Times a stonecutter was opened.", "Veces que se abrió un cortapiedras."),
        exploit: t(
            "Opening counts, not cutting, so it is only ever an easy one, and rare.",
            "Cuenta abrirlo, no cortar, así que solo sale como fácil, y poco."
        ),
        check: sum(custom(["interact_with_stonecutter"])),
        targets: { easy: 5, medium: 15, hard: 40 },
        easyOnly: true,
        weight: 0.4,
        uncertain: true,
        layers: ["daily"],
        unit: "count",
        minVersion: [1, 14]
    },
    {
        id: "Cr6",
        category: "crafting",
        group: "maps",
        title: t("Fill in %n maps", "Rellena %n mapas"),
        how: t("Empty maps used, which is starting a map.", "Mapas vacíos usados, que es empezar un mapa."),
        exploit: t("Each map costs paper and a compass.", "Cada mapa cuesta papel y una brújula."),
        check: sum(used(["map"])),
        targets: { easy: 1, medium: 3, hard: 6 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "Cr7",
        category: "crafting",
        group: "trim",
        title: t("Trim a piece of armour", "Decora una pieza de armadura"),
        how: t(
            "Crafting Trims earned since the card was dealt.",
            "El progreso Decoración con estilo conseguido desde que se repartió el cartón."
        ),
        exploit: t("Advancements are once per world.", "Los progresos son una vez por mundo."),
        check: { kind: "advancement", ids: ["adventure/trim_with_any_armor_pattern"] },
        card: 1,
        fallback: "Cr3",
        layers: ["card"],
        unit: "count",
        minVersion: [1, 20]
    },
    {
        id: "Cr8",
        category: "crafting",
        group: "fireworks",
        title: t("Craft %n firework rockets", "Fabrica %n cohetes"),
        how: t("Firework rockets crafted.", "Cohetes de fuegos artificiales fabricados."),
        exploit: t("Each costs gunpowder and paper.", "Cada uno cuesta pólvora y papel."),
        check: sum(crafted(["firework_rocket"])),
        targets: { easy: 16, medium: 64, hard: 192 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "Cr9",
        category: "crafting",
        group: "books",
        title: t("Craft %n books and bookshelves", "Fabrica %n libros y librerías"),
        how: t("Books and bookshelves crafted.", "Libros y librerías fabricados."),
        exploit: t("Each costs leather or books; none can be undone.", "Cada uno cuesta cuero o libros; ninguno se puede deshacer."),
        check: sum(crafted(["book", "bookshelf"])),
        targets: { easy: 3, medium: 9, hard: 30 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "Cr10",
        category: "crafting",
        group: "crafter",
        title: t("Craft a crafter with a crafter", "Fabrica un crafter con un crafter"),
        how: t(
            "Crafters Crafting Crafters earned since the card was dealt.",
            "El progreso Crafters fabricando crafters conseguido desde que se repartió el cartón."
        ),
        exploit: t("Advancements are once per world.", "Los progresos son una vez por mundo."),
        check: { kind: "advancement", ids: ["adventure/crafters_crafting_crafters"] },
        card: 1,
        fallback: "Cr8",
        layers: ["card"],
        unit: "count",
        minVersion: [1, 21]
    },

    // ---------------------------------------------------------------- trading and taming
    {
        id: "T1",
        category: "taming",
        group: "trade",
        title: t("Trade %n times with villagers", "Comercia %n veces con aldeanos"),
        how: t("Trades made with villagers.", "Tratos hechos con aldeanos."),
        exploit: t("Each trade is a click, and at most 10 a minute count.", "Cada trato es un clic, y como mucho cuentan 10 por minuto."),
        check: sum(custom(["traded_with_villager"])),
        targets: { easy: 5, medium: 20, hard: 60 },
        perMinute: 10,
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "T2",
        category: "taming",
        group: "breed",
        title: t("Breed %n animals", "Cría %n animales"),
        how: t("Animals bred by you.", "Animales criados por ti."),
        exploit: t(
            "Dispenser breeders do not credit the player; standing still is not credited.",
            "Los criaderos con dispensador no cuentan para el jugador; quedarse quieto no cuenta."
        ),
        check: sum(custom(["animals_bred"])),
        targets: { easy: 6, medium: 20, hard: 60 },
        community: 40,
        perMinute: 20,
        layers: ["daily", "weekly", "card", "community"],
        unit: "count"
    },
    {
        id: "T3",
        category: "taming",
        group: "two-by-two",
        title: t("Breed %n new species", "Cría %n especies nuevas"),
        how: t(
            "Animals of Two by Two bred for the first time since the period began.",
            "Animales de De dos en dos criados por primera vez desde que empezó el periodo."
        ),
        exploit: t(
            "Each species counts once per world. A player who has bred them all gets Breeder instead.",
            "Cada especie cuenta una vez por mundo. Quien ya las ha criado todas recibe Criador en su lugar."
        ),
        check: { kind: "criteria", ids: ["husbandry/bred_all_animals"] },
        weekly: [1, 3, 6],
        card: 3,
        fallback: "T2",
        layers: ["weekly", "card"],
        unit: "count"
    },
    {
        id: "T4",
        category: "taming",
        group: "tame",
        title: t("Tame %n new animals", "Domestica %n animales nuevos"),
        how: t(
            "A first tamed animal, or cat variants of A Complete Catalogue, since the period began.",
            "Un primer animal domesticado, o variantes de gato de Un catálogo completo, desde que empezó el periodo."
        ),
        exploit: t(
            "Each counts once per world. A player who has them all gets Breeder instead.",
            "Cada uno cuenta una vez por mundo. Quien ya los tiene todos recibe Criador en su lugar."
        ),
        check: { kind: "criteria", ids: ["husbandry/tame_an_animal", "husbandry/complete_catalogue"] },
        weekly: [1, 2, 4],
        card: 2,
        fallback: "T2",
        layers: ["weekly", "card"],
        unit: "count"
    },
    {
        id: "T5",
        category: "taming",
        group: "raid",
        title: t("Be the hero of a village", "Sé el héroe de una aldea"),
        how: t("A raid won.", "Un asalto ganado."),
        exploit: t("Raid farms exist, so it is weekly only, once.", "Existen granjas de asaltos, así que es solo semanal, una vez."),
        check: sum(custom(["raid_win"])),
        weekly: [1, 1, 1],
        layers: ["weekly"],
        unit: "count",
        minVersion: [1, 14]
    },
    {
        id: "T6",
        category: "taming",
        group: "wool",
        title: t("Shear %n wool", "Esquila %n de lana"),
        how: t(
            "Wool of any colour picked up, minus dropped, having used shears.",
            "Lana de cualquier color recogida, menos la tirada, habiendo usado tijeras."
        ),
        exploit: t(
            "Dispenser wool farms do not credit pickups to the player; dropping and picking up nets zero.",
            "Las granjas de lana con dispensador no cuentan para el jugador; tirar y volver a coger suma cero."
        ),
        check: {
            kind: "sum",
            parts: gathered(COLORS.map((color) => `${color}_wool`)),
            requires: { parts: used(["shears"]), atLeast: 1 }
        },
        targets: { easy: 16, medium: 48, hard: 128 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "T7",
        category: "taming",
        group: "cure",
        title: t("Cure a zombie villager", "Cura a un aldeano zombi"),
        how: t(
            "Zombie Doctor earned since the card was dealt.",
            "El progreso Doctor zombi conseguido desde que se repartió el cartón."
        ),
        exploit: t("Advancements are once per world.", "Los progresos son una vez por mundo."),
        check: { kind: "advancement", ids: ["story/cure_zombie_villager"] },
        card: 1,
        fallback: "T1",
        layers: ["card"],
        unit: "count"
    },

    // ---------------------------------------------------------------- nether and end
    {
        id: "N1",
        category: "nether",
        group: "blaze",
        title: t("Slay %n blazes", "Acaba con %n blazes"),
        how: t("Blazes killed.", "Blazes eliminados."),
        exploit: t(
            "Kills while standing still at a blaze farm are not credited, at most 15 a minute.",
            "Las muertes sin moverse en una granja de blazes no cuentan, como mucho 15 por minuto."
        ),
        check: sum(killed(["blaze"])),
        targets: { easy: 5, medium: 15, hard: 40 },
        perMinute: 15,
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "N2",
        category: "nether",
        group: "skulls",
        title: t("Collect %n wither skeleton skulls", "Consigue %n cráneos de esqueleto wither"),
        how: t("Wither skeleton skulls picked up, minus dropped.", "Cráneos de esqueleto wither recogidos, menos los tirados."),
        exploit: t("A rare drop; dropping and picking up nets zero. Weekly only.", "Un botín raro; tirar y volver a coger suma cero. Solo semanal."),
        check: sum(gathered(["wither_skeleton_skull"])),
        weekly: [1, 2, 3],
        card: 1,
        layers: ["weekly", "card"],
        unit: "count"
    },
    {
        id: "N3",
        category: "nether",
        group: "strider",
        title: t("Ride a strider %n blocks", "Monta un strider %n bloques"),
        how: t("Distance ridden on a strider.", "Distancia recorrida en un strider."),
        exploit: t("Standing still is not credited.", "Quedarse quieto no cuenta."),
        check: sum(custom(["strider_one_cm"])),
        targets: { easy: 20_000, medium: 80_000, hard: 200_000 },
        perMinute: 20_000,
        layers: ["daily", "weekly", "card"],
        unit: "blocks",
        minVersion: [1, 16]
    },
    {
        id: "N4",
        category: "nether",
        group: "ghast",
        title: t("Bust %n ghasts", "Derriba %n ghasts"),
        how: t("Ghasts killed.", "Ghasts eliminados."),
        exploit: t("Ghasts are not farmed easily.", "Los ghasts no se crían con facilidad."),
        check: sum(killed(["ghast"])),
        targets: { easy: 2, medium: 5, hard: 12 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "N5",
        category: "nether",
        group: "pearls",
        title: t("Collect %n ender pearls", "Consigue %n perlas de ender"),
        how: t("Ender pearls picked up, minus dropped.", "Perlas de ender recogidas, menos las tiradas."),
        exploit: t(
            "Dropping and picking up nets zero; pearls from piglins or endermen are the same effort.",
            "Tirar y volver a coger suma cero; las perlas de piglins o endermans son el mismo esfuerzo."
        ),
        check: sum(gathered(["ender_pearl"])),
        targets: { easy: 4, medium: 12, hard: 32 },
        perMinute: 16,
        uncertain: true,
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "N6",
        category: "nether",
        group: "ender",
        title: t("Clean up %n shulkers", "Limpia %n shulkers"),
        how: t("Shulkers killed, and shulker shells picked up minus dropped.", "Shulkers eliminados, y caparazones de shulker recogidos menos los tirados."),
        exploit: t("Shulker farms: at most 10 a minute count.", "Granjas de shulkers: como mucho cuentan 10 por minuto."),
        check: sum([...killed(["shulker"]), ...gathered(["shulker_shell"])]),
        targets: { easy: 4, medium: 10, hard: 24 },
        perMinute: 10,
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "N7",
        category: "nether",
        group: "chorus",
        title: t("Harvest %n chorus", "Recoge %n de coro"),
        how: t("Chorus plants and flowers mined, minus flowers placed.", "Plantas y flores de coro rotas, menos las flores colocadas."),
        exploit: t("Placing a chorus flower and breaking it again nets zero.", "Colocar una flor de coro y volver a romperla suma cero."),
        check: sum([...mined(["chorus_flower", "chorus_plant"]), ...placed(["chorus_flower"])]),
        targets: { easy: 16, medium: 48, hard: 128 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "N8",
        category: "nether",
        group: "elytra",
        title: t("Find an elytra", "Encuentra unos élitros"),
        how: t(
            "Sky's the Limit earned since the card was dealt.",
            "El progreso El cielo es el límite conseguido desde que se repartió el cartón."
        ),
        exploit: t("Advancements are once per world.", "Los progresos son una vez por mundo."),
        check: { kind: "advancement", ids: ["end/elytra"] },
        card: 1,
        fallback: "N6",
        layers: ["card"],
        unit: "count"
    },

    // ---------------------------------------------------------------- building
    {
        id: "B1",
        category: "building",
        group: "build",
        title: t("Build with %n blocks", "Construye con %n bloques"),
        how: t(
            "Stone, brick, plank and deepslate building blocks placed, minus the same mined.",
            "Bloques de construcción de piedra, ladrillo, tablones y pizarra profunda colocados, menos los mismos picados."
        ),
        exploit: t(
            "Placing and breaking again nets zero, so a pillar of blocks taken down counts nothing. What is built is never judged.",
            "Colocar y volver a romper suma cero, así que una torre que se desmonta no cuenta. Lo construido nunca se juzga."
        ),
        check: sum(built(BUILDING)),
        targets: { easy: 64, medium: 256, hard: 1024 },
        community: 500,
        layers: ["daily", "weekly", "card", "community"],
        unit: "count"
    },
    {
        id: "B2",
        category: "building",
        group: "decorate",
        title: t("Place %n decorations", "Coloca %n decoraciones"),
        how: t(
            "Flower pots, lanterns, paintings, item frames and banners placed, minus the same broken or picked up.",
            "Macetas, faroles, cuadros, marcos y estandartes colocados, menos los mismos rotos o recogidos."
        ),
        exploit: t(
            "Putting one up and taking it down again nets zero.",
            "Colgar uno y volver a quitarlo suma cero."
        ),
        check: sum([
            ...built(["flower_pot", "lantern", ...COLORS.map((color) => `${color}_banner`)]),
            ...used(["painting", "item_frame", "glow_item_frame"]),
            ...each("picked_up", ["painting", "item_frame", "glow_item_frame"], -1)
        ]),
        targets: { easy: 5, medium: 15, hard: 40 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "B3",
        category: "building",
        group: "glass",
        title: t("Place %n glass", "Coloca %n de cristal"),
        how: t("Glass of any colour placed, minus the same broken.", "Cristal de cualquier color colocado, menos el mismo roto."),
        exploit: t("Placing and breaking again nets zero.", "Colocar y volver a romper suma cero."),
        check: sum(built(["glass", ...COLORS.map((color) => `${color}_stained_glass`)])),
        targets: { easy: 32, medium: 128, hard: 512 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "B4",
        category: "building",
        group: "saplings",
        title: t("Plant %n saplings", "Planta %n brotes"),
        how: t("Saplings planted, minus saplings broken.", "Brotes plantados, menos los brotes rotos."),
        exploit: t("Breaking a sapling gives it back; planting it again nets zero.", "Romper un brote lo devuelve; volver a plantarlo suma cero."),
        check: sum(built(SAPLINGS)),
        targets: { easy: 8, medium: 24, hard: 64 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "B5",
        category: "building",
        group: "light",
        title: t("Light up %n spots", "Ilumina %n sitios"),
        how: t("Torches and lanterns placed, minus the same broken.", "Antorchas y faroles colocados, menos los mismos rotos."),
        exploit: t(
            "A torch on a wall is broken as a wall torch, which is taken off too: placing and breaking nets zero.",
            "Una antorcha en la pared se rompe como antorcha de pared, que también se resta: colocar y romper suma cero."
        ),
        check: sum([...used(["torch", "lantern"]), ...each("mined", ["torch", "wall_torch", "lantern"], -1)]),
        targets: { easy: 16, medium: 64, hard: 192 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },

    // ---------------------------------------------------------------- social
    {
        id: "S1",
        category: "social",
        group: "community",
        title: t("Give %n% to the community goal", "Aporta el %n% al objetivo de la comunidad"),
        how: t("Your share of the community goal running now.", "Tu parte del objetivo de la comunidad en curso."),
        exploit: t(
            "The goal's own rules apply, standing still included; only dealt while a goal runs.",
            "Se aplican las reglas del propio objetivo, quedarse quieto incluido; solo sale mientras hay un objetivo."
        ),
        check: { kind: "polaris", measure: "community-share" },
        targets: { easy: 1, medium: 3, hard: 8 },
        layers: ["daily", "weekly"],
        unit: "percent"
    },
    {
        id: "S2",
        category: "social",
        group: "events",
        title: t("Take part in %n events", "Participa en %n eventos"),
        how: t(
            "Polaris events where you reached the least score to be ranked.",
            "Eventos de Polaris en los que llegaste a la puntuación mínima para clasificar."
        ),
        exploit: t(
            "Only events with at least two players count, and AFK players are never ranked.",
            "Solo cuentan eventos con al menos dos jugadores, y los jugadores AFK nunca clasifican."
        ),
        check: { kind: "polaris", measure: "events-ranked" },
        targets: { easy: 1, medium: 2, hard: 4 },
        weekly: [1, 2, 4],
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "S3",
        category: "social",
        group: "events",
        title: t("Reach the podium in %n events", "Sube al podio en %n eventos"),
        how: t("Polaris events you finished in the top three of.", "Eventos de Polaris en los que acabaste entre los tres primeros."),
        exploit: t(
            "Only events with at least two players count, so nobody wins alone.",
            "Solo cuentan eventos con al menos dos jugadores, así que nadie gana solo."
        ),
        check: { kind: "polaris", measure: "events-podium" },
        weekly: [1, 1, 2],
        card: 1,
        layers: ["weekly", "card"],
        unit: "count"
    },
    {
        id: "S4",
        category: "social",
        group: "together",
        title: t("Play %n minutes next to someone", "Juega %n minutos junto a alguien"),
        how: t(
            "Minutes you and another player were both playing within 64 blocks of each other.",
            "Minutos en que tú y otro jugador estabais jugando a menos de 64 bloques el uno del otro."
        ),
        exploit: t(
            "Both have to be moving: two idle accounts side by side count nothing.",
            "Los dos tienen que moverse: dos cuentas quietas una al lado de la otra no cuentan."
        ),
        check: { kind: "polaris", measure: "together" },
        targets: { easy: 15, medium: 45, hard: 120 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "S5",
        category: "social",
        group: "chat-games",
        title: t("Win %n trivia rounds", "Gana %n rondas de trivia"),
        how: t("Rounds of a trivia event you answered first.", "Rondas de un evento de trivia que respondiste primero."),
        exploit: t("Each round has one winner.", "Cada ronda tiene un solo ganador."),
        check: { kind: "polaris", measure: "chat-games" },
        targets: { easy: 1, medium: 3, hard: 6 },
        layers: ["daily", "weekly", "card"],
        unit: "count"
    },
    {
        id: "S6",
        category: "social",
        group: "welcome",
        title: t("Welcome a newcomer", "Da la bienvenida a alguien nuevo"),
        how: t(
            "Saying something in the chat within five minutes of somebody's first time on the server.",
            "Decir algo en el chat en los cinco minutos siguientes a la primera vez de alguien en el servidor."
        ),
        exploit: t(
            "One per newcomer, and only the first three to greet them.",
            "Uno por recién llegado, y solo los tres primeros en saludar."
        ),
        check: { kind: "polaris", measure: "welcome" },
        weekly: [1, 1, 1],
        layers: ["weekly"],
        unit: "count"
    },

    // ---------------------------------------------------------------- collection
    {
        id: "K1",
        category: "collection",
        group: "obtain",
        title: t("Obtain %v", "Consigue %v"),
        how: t(
            "Holding it, having picked it up or crafted it since the card was dealt.",
            "Tenerlo encima, habiéndolo recogido o fabricado desde que se repartió el cartón."
        ),
        exploit: t(
            "Stock taken from a chest does not count; handing one over is dropping it, which is taken off.",
            "Lo sacado de un cofre no cuenta; pasárselo a otro es tirarlo, y eso se resta."
        ),
        variants: [
            { key: "cake", label: t("a cake", "una tarta"), check: { kind: "held", items: ["cake"] } },
            { key: "compass", label: t("a compass", "una brújula"), check: { kind: "held", items: ["compass"] } },
            { key: "golden_carrot", label: t("a golden carrot", "una zanahoria dorada"), check: { kind: "held", items: ["golden_carrot"] } },
            { key: "ender_eye", label: t("an eye of ender", "un ojo de ender"), check: { kind: "held", items: ["ender_eye"] } },
            { key: "blaze_powder", label: t("blaze powder", "polvo de blaze"), check: { kind: "held", items: ["blaze_powder"] } },
            { key: "crossbow", label: t("a crossbow", "una ballesta"), check: { kind: "held", items: ["crossbow"] }, minVersion: [1, 14] },
            { key: "shield", label: t("a shield", "un escudo"), check: { kind: "held", items: ["shield"] } },
            { key: "clock", label: t("a clock", "un reloj"), check: { kind: "held", items: ["clock"] } },
            { key: "jukebox", label: t("a jukebox", "una gramola"), check: { kind: "held", items: ["jukebox"] } }
        ],
        card: 1,
        layers: ["card"],
        unit: "count"
    },
    {
        id: "K2",
        category: "collection",
        group: "dyes",
        title: t("Hold %n dye colours at once", "Ten %n colores de tinte a la vez"),
        how: t(
            "Dye colours you hold at the same time, each one picked up or crafted since the period began.",
            "Colores de tinte que tienes a la vez, cada uno recogido o fabricado desde que empezó el periodo."
        ),
        exploit: t("Dyes from a chest do not count.", "Los tintes sacados de un cofre no cuentan."),
        check: { kind: "held", items: COLORS.map((color) => `${color}_dye`) },
        weekly: [8, 12, 16],
        card: 12,
        layers: ["weekly", "card"],
        unit: "count",
        minVersion: [1, 14]
    },
    {
        id: "K3",
        category: "collection",
        group: "discs",
        title: t("Collect %n music discs", "Colecciona %n discos"),
        how: t("Different music discs picked up, minus dropped.", "Discos distintos recogidos, menos los tirados."),
        exploit: t("Each disc counts once, and a dropped one comes off.", "Cada disco cuenta una vez, y uno tirado se resta."),
        check: { kind: "distinct", groups: DISCS.map((disc) => gathered([disc])) },
        weekly: [1, 3, 6],
        card: 3,
        layers: ["weekly", "card"],
        unit: "count"
    },
    {
        id: "K4",
        category: "collection",
        group: "advancements",
        title: t("Complete %n advancements", "Completa %n progresos"),
        how: t(
            "Advancements completed since the card was dealt.",
            "Progresos completados desde que se repartió el cartón."
        ),
        exploit: t("Advancements are once per world.", "Los progresos son una vez por mundo."),
        check: { kind: "advancements" },
        card: 5,
        weekly: [2, 5, 10],
        fallback: "K1",
        layers: ["weekly", "card"],
        unit: "count"
    }
];

/** The streak and bonus rules, which ride on top of the templates. */
export const META_RULES = [
    {
        id: "X1",
        title: t("Daily streak", "Racha diaria"),
        how: t(
            "Days in a row with at least one daily done. Milestones at 3, 7, 14 and 30 days pay a bonus. A missed day uses the week's freeze if there is one; otherwise the streak falls back to its last milestone, not to zero.",
            "Días seguidos con al menos un reto diario hecho. Los hitos de 3, 7, 14 y 30 días dan un extra. Un día perdido gasta la protección de la semana si queda; si no, la racha vuelve a su último hito, no a cero."
        )
    },
    {
        id: "X2",
        title: t("Clean sweep", "Pleno diario"),
        how: t("All three dailies done in one day.", "Los tres retos diarios hechos en un día.")
    },
    {
        id: "X3",
        title: t("Weekly sweep", "Pleno semanal"),
        how: t("All three weeklies done in one week.", "Los tres retos semanales hechos en una semana.")
    },
    {
        id: "X4",
        title: t("Bingo line", "Línea de bingo"),
        how: t(
            "A row, column or diagonal of the month's card done, and more for the whole card.",
            "Una fila, columna o diagonal del cartón del mes hecha, y más por el cartón completo."
        )
    }
] as const;

export const STREAK_MILESTONES = [3, 7, 14, 30] as const;

const byId = new Map(TEMPLATES.map((template) => [template.id, template]));

export function templateOf(id: string): Template | null {
    return byId.get(id) ?? null;
}

/** The check a dealt challenge is measured by: its variant's, or the template's. */
export function checkOf(template: Template, variant: string | null): Check {
    const chosen = template.variants?.find((one) => one.key === variant) ?? template.variants?.[0];
    return chosen?.check ?? (template.check as Check);
}

/** Every statistic a check reads, with no repeats. */
export function criteriaOf(check: Check): string[] {
    const parts: Part[] = [];
    if (check.kind === "sum") {
        parts.push(...check.parts, ...(check.capBy ?? []), ...(check.gate ?? []), ...(check.requires?.parts ?? []));
    } else if (check.kind === "distinct") {
        for (const group of check.groups) parts.push(...group);
    } else if (check.kind === "survive") {
        parts.push(...check.parts, ...check.requires.parts);
    } else if (check.kind === "held") {
        parts.push(...heldParts(check.items));
    } else if (check.kind === "polaris" && check.parts) {
        parts.push(...check.parts);
    }
    return [...new Set(parts.map((part) => part.criterion))];
}

/** What says an item was obtained rather than taken out of a chest. */
export function heldParts(items: readonly string[]): Part[] {
    return items.flatMap((item) => [
        stat("picked_up", item),
        stat("crafted", item),
        stat("dropped", item, -1)
    ]);
}

/** The target of a template at a difficulty, before pace and the server's
 *  multiplier. Null where that layer cannot deal it. */
export function baseTarget(template: Template, layer: Layer, tier: Difficulty): number | null {
    if (!template.layers.includes(layer)) return null;
    const index = DIFFICULTIES.indexOf(tier);
    if (layer === "weekly") {
        if (template.weekly) return template.weekly[index] ?? null;
        const hard = template.targets?.hard;
        return hard === undefined ? null : Math.round(hard * [1.5, 2, 3][index]!);
    }
    if (layer === "card") return template.card ?? template.targets?.hard ?? null;
    if (layer === "community") return template.community ?? null;
    if (template.easyOnly && tier !== "easy") return null;
    return template.targets?.[tier] ?? null;
}

/** Whether a version is at least another. An unreadable one is taken as recent. */
export function atLeast(version: string | null, wanted: Version | undefined): boolean {
    if (!wanted) return true;
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version ?? "");
    if (!match) return true;
    const have = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    for (let index = 0; index < wanted.length; index += 1) {
        const left = have[index] ?? 0;
        const right = wanted[index] ?? 0;
        if (left !== right) return left > right;
    }
    return true;
}

/** A figure in its unit, rounded for reading. */
export function inUnit(template: Template, value: number): number {
    const divisor = UNIT_DIVISOR[template.unit];
    const shown = value / divisor;
    return divisor === 1 ? Math.floor(shown) : Math.floor(shown * 10) / 10;
}

/** A template's title with its target and variant written in. */
export function titleOf(
    template: Template,
    variant: string | null,
    target: number,
    language: Language
): string {
    const label = template.variants?.find((one) => one.key === variant)?.label[language] ?? "";
    const shown = inUnit(template, target);
    return template.title[language].replace("%n", formatNumber(shown, language)).replace("%v", label);
}

/** A template's title with the figure left open, for choosing one: `Mine x ore blocks`. */
export function shapeOf(template: Template, language: Language): string {
    const label = template.variants?.[0]?.label[language] ?? "";
    return template.title[language].replace("%n", "x").replace("%v", label);
}

export function formatNumber(value: number, language: Language): string {
    const rounded = Number.isInteger(value) ? value : Math.round(value * 10) / 10;
    const [whole, fraction] = String(rounded).split(".");
    const separator = language === "es" ? "." : ",";
    const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, separator);
    return fraction ? `${grouped}${language === "es" ? "," : "."}${fraction}` : grouped;
}

export const CATEGORY_LABELS: Readonly<Record<Category, Text>> = {
    mining: t("Mining", "Minería"),
    combat: t("Combat", "Combate"),
    farming: t("Farming", "Granja"),
    fishing: t("Fishing", "Pesca"),
    exploration: t("Exploration", "Exploración"),
    crafting: t("Crafting", "Fabricación"),
    taming: t("Trading and taming", "Comercio y animales"),
    nether: t("Nether and End", "Nether y End"),
    building: t("Building", "Construcción"),
    social: t("Social", "Social"),
    collection: t("Collection", "Colección")
};

export const DIFFICULTY_LABELS: Readonly<Record<Difficulty, Text>> = {
    easy: t("Easy", "Fácil"),
    medium: t("Medium", "Media"),
    hard: t("Hard", "Difícil")
};

/** Weekly tiers read differently: the three are harder than the dailies. */
export const WEEKLY_LABELS: Readonly<Record<Difficulty, Text>> = {
    easy: t("Medium", "Media"),
    medium: t("Hard", "Difícil"),
    hard: t("Elite", "Élite")
};
