/**
 * A world boss worth fighting: drawn at random from the enabled bosses, three
 * phases by health, attacks announced a second before they land, a shield of
 * minions, health that grows with every fighter, and no way to trap it.
 *
 * Every line is vanilla Java commands over RCON, from 1.13 on, so it plays the
 * same on vanilla, Paper, Fabric and NeoForge. What keeps it from costing
 * anybody anything, one rule at a time:
 *
 * - **No block is ever changed by the fight.** Nothing here places, breaks or
 *   replaces a block: an attack is `damage` (or instant damage before 1.19.4),
 *   an effect or a `tp`, and a player is only ever moved into air. Mobs that
 *   would change a block are held off it: a ravager's leaves and crops and an
 *   evoker's sheep obey `mobGriefing`, held off for exactly the fight unless
 *   the fight is in the sky arena, where there is nothing of anybody's to
 *   touch; the Wither's skulls explode, so it fights only in the arena, with
 *   `mobGriefing` off besides. Zombies cannot break doors or call for help.
 * - **The sky arena** (`arenaBoxes`) is a closed box of glass built only into
 *   air proved empty, 30 blocks over open ground, and taken down block kind by
 *   block kind - the same stage parkour and spleef stand on (`stage.ts`).
 *   Players go up through a beam of light and play in adventure mode, so they
 *   can neither break nor place anything there; each is put back at the beam
 *   at the end, after a restart, or when they next log in.
 * - **Nothing of anybody's is lost.** `keepInventory` is on for the fight, put
 *   back after even a restart; every creature near the boss that is not a
 *   player or one of the fight's own mobs - a dog, a horse, a villager - takes
 *   no damage while it lasts.
 * - **Everything summoned is tagged** (`BOSS_TAG`, `FIGHT_TAG`), drops nothing
 *   (`minecraft:empty` loot, no gear), and is sent into the void and killed at
 *   the end, on a cancel and after a restart (`bossCleanup`).
 *
 * Pure: every line is a function of what it is given, asserted in tests.
 */

import { z } from "zod";
import * as stage from "./stage";
import * as catalog from "../catalog";
import { BAR, BOSS_FIGHT_REACH, BOSS_TAG, SUM, asciiJson, text } from "../commands";

type Options = catalog.EventOptions<"world-boss">;
type BossKind = catalog.BossKind;
type BossDifficulty = catalog.BossDifficulty;
type Point = { readonly x: number; readonly y: number; readonly z: number };

/** Every other creature of the fight: minions, vexes, fangs and their marks. */
export const FIGHT_TAG = "pe_bmob";
/** The minions of the second phase, whose shield holds while any of them lives. */
export const SHIELD_TAG = "pe_bshield";
/** Only while a group is being summoned, to arm it and give it its effects. */
const NEW_TAG = "pe_bnew";
/** Where fangs will rise, marked a second before. */
const FANG_TAG = "pe_bfang";

const BOSS = `@e[tag=${BOSS_TAG},limit=1]`;
const AT_BOSS = `execute as ${BOSS} at @s`;
const WORLD = "execute in minecraft:overworld run";

// ------------------------------------------------------------------ the bosses

export interface BossProfile {
    /** The mob, without its namespace. */
    readonly entity: string;
    /** What it holds, when a summoned one is not handed it otherwise: only what
     *  it needs to fight at all - a weapon would add its own damage on top of
     *  the difficulty's. */
    readonly hand: string | null;
    /** What it wears on its head. */
    readonly head: string | null;
    /** The minions of its second phase: never its own kind, so a minion's
     *  death is never taken for the boss's. */
    readonly minion: string;
    /** Minions at its side from the start, besides the second phase's. */
    readonly guard: number;
    /** It fights from a distance, standing still to cast or shoot: never taken
     *  for trapped for that. */
    readonly ranged?: boolean;
    /** What it drops on its death whatever its loot table says - the Wither's
     *  star - taken off the floor and back from whoever picked it up. */
    readonly drops?: string;
}

export const BOSSES: Readonly<Record<BossKind, BossProfile>> = {
    "wither-skeleton": {
        entity: "wither_skeleton",
        hand: null,
        head: null,
        minion: "skeleton",
        guard: 0
    },
    ravager: { entity: "ravager", hand: null, head: null, minion: "vindicator", guard: 0 },
    vindicator: {
        entity: "vindicator",
        hand: null,
        head: null,
        minion: "pillager",
        guard: 0
    },
    husk: { entity: "husk", hand: null, head: null, minion: "zombie", guard: 0 },
    // Its sheep: an evoker turns a blue one red when `mobGriefing` is on.
    evoker: { entity: "evoker", hand: null, head: null, minion: "vindicator", guard: 0, ranged: true },
    // Never a patrol leader: killing one would hand its killer Bad Omen, and a
    // raid would follow them home.
    captain: {
        entity: "pillager",
        hand: "minecraft:crossbow",
        head: "minecraft:black_banner",
        minion: "vindicator",
        guard: 2,
        ranged: true
    },
    wither: {
        entity: "wither",
        hand: null,
        head: null,
        minion: "wither_skeleton",
        guard: 0,
        ranged: true,
        drops: "minecraft:nether_star"
    }
};

/** Minions that fight with something they must be handed. */
const MINION_HANDS: Readonly<Record<string, string>> = {
    skeleton: "minecraft:bow",
    pillager: "minecraft:crossbow",
    vindicator: "minecraft:iron_axe"
};

/** Kinds that call for reinforcements when hurt, which would come untagged. */
const CALLS_FOR_HELP = ["husk", "zombie"];

export const holdsGriefing = catalog.holdsGriefing;

/** The rule held off, under every name it has had. */
export const MOB_GRIEFING = ["mobGriefing", "mob_griefing"] as const;
/** The rule held on, under every name it has had. */
export const KEEP_INVENTORY = ["keepInventory", "keep_inventory"] as const;

/**
 * Which boss this one is: the chosen one, or one drawn from the pool - only
 * from the bosses that can fight where it will be fought.
 */
export function draw(options: Options, random: () => number): BossKind {
    if (options.choice === "chosen") {
        return catalog.bossesFor(options.arena, [options.boss])[0] ?? "wither-skeleton";
    }
    const pool = catalog.bossesFor(options.arena, options.pool);
    const from = pool.length > 0 ? pool : catalog.bossesFor(options.arena);
    return from[Math.min(from.length - 1, Math.floor(random() * from.length))] as BossKind;
}

// ------------------------------------------------------------------ difficulty

export interface Difficulty {
    /** The base health is multiplied by this for one fighter. */
    readonly health: number;
    /** And by this much more for each fighter past the first. */
    readonly perFighter: number;
    readonly armor: number;
    readonly toughness: number;
    readonly attack: number;
    readonly knockback: number;
    /** Every ability's wait is multiplied by this. */
    readonly cooldown: number;
    /** What a shockwave or a landing deals, in health points. */
    readonly blast: number;
    /** Minions of the second phase for one fighter. */
    readonly minions: number;
    /** Each minion's health: tough enough that a crowd does not clear the
     *  shield in a moment. */
    readonly minionHealth: number;
    /** Amplifiers in its rage. */
    readonly rage: { readonly strength: number; readonly speed: number };
    /** What the prizes are multiplied by. */
    readonly prize: number;
}

export const DIFFICULTY: Readonly<Record<BossDifficulty, Difficulty>> = {
    normal: {
        health: 1.25,
        perFighter: 0.5,
        armor: 12,
        toughness: 4,
        attack: 9,
        knockback: 0.8,
        cooldown: 1,
        blast: 6,
        minions: 3,
        minionHealth: 30,
        rage: { strength: 0, speed: 0 },
        prize: catalog.BOSS_PRIZE_TIMES.normal
    },
    hard: {
        health: 1.75,
        perFighter: 0.65,
        armor: 16,
        toughness: 6,
        attack: 11,
        knockback: 0.9,
        cooldown: 0.8,
        blast: 8,
        minions: 4,
        minionHealth: 40,
        rage: { strength: 1, speed: 0 },
        prize: catalog.BOSS_PRIZE_TIMES.hard
    },
    epic: {
        health: 2.5,
        perFighter: 0.8,
        armor: 20,
        toughness: 8,
        attack: 13,
        knockback: 1,
        cooldown: 0.65,
        blast: 10,
        minions: 5,
        minionHealth: 60,
        rage: { strength: 1, speed: 1 },
        prize: catalog.BOSS_PRIZE_TIMES.epic
    }
};

/** The most health the game lets any creature have. */
export const HEALTH_CAP = 1024;
/** Resistance takes a fifth of the damage off per level, up to four. */
const RESISTANCE_STEP = 0.2;
const RESISTANCE_MAX = 4;

/** The health it should fight with, all told, for this many fighters. */
export function effectiveHealth(base: number, difficulty: BossDifficulty, fighters: number): number {
    const level = DIFFICULTY[difficulty];
    return Math.round(base * level.health * (1 + level.perFighter * (Math.max(1, fighters) - 1)));
}

/** Bosses no effect can be given to - the game refuses every one on a Wither -
 *  whose shield is being invulnerable instead, and whose health stops at the cap. */
export const EFFECT_IMMUNE: readonly BossKind[] = ["wither"];

export function effectImmune(kind: BossKind): boolean {
    return EFFECT_IMMUNE.includes(kind);
}

/**
 * That health as the game can hold it: up to `HEALTH_CAP` as health, past that
 * in levels of Resistance, which make every point of health worth more. A boss
 * immune to effects keeps its health, up to the cap.
 */
export function splitHealth(effective: number, immune = false): { health: number; resistance: number } {
    if (immune) return { health: Math.max(1, Math.min(HEALTH_CAP, Math.ceil(effective))), resistance: 0 };
    for (let resistance = 0; resistance <= RESISTANCE_MAX; resistance += 1) {
        const health = Math.ceil(effective * (1 - RESISTANCE_STEP * resistance));
        if (health <= HEALTH_CAP) return { health: Math.max(1, health), resistance };
    }
    return { health: HEALTH_CAP, resistance: RESISTANCE_MAX };
}

/**
 * The health it has once more fighters have come: what it had lost stays lost,
 * and the new fighters' share is added on top.
 */
export function toppedUp(
    current: number,
    before: { health: number; resistance: number },
    after: { health: number; resistance: number },
    added: number
): number {
    const worth = current / (1 - RESISTANCE_STEP * before.resistance);
    const next = (worth + Math.max(0, added)) * (1 - RESISTANCE_STEP * after.resistance);
    return Math.max(1, Math.min(after.health, Math.round(next)));
}

export type Phase = 1 | 2 | 3;

/** The phase its health puts it in: the second from 66%, the third from 33%. */
export function phaseFor(health: number, max: number): Phase {
    const share = max > 0 ? health / max : 1;
    return share > 0.66 ? 1 : share > 0.33 ? 2 : 3;
}

/** How many minions the second phase brings. */
export function minionCount(difficulty: BossDifficulty, fighters: number): number {
    return Math.min(10, DIFFICULTY[difficulty].minions + Math.max(0, fighters - 1));
}

/** The prizes, multiplied for the difficulty. */
export function scaledRewards(rewards: catalog.Rewards, difficulty: BossDifficulty): catalog.Rewards {
    const by = DIFFICULTY[difficulty].prize;
    const one = (reward: catalog.Reward): catalog.Reward => ({
        items: reward.items.map((item) => ({
            id: item.id,
            count: Math.min(256, Math.max(1, Math.ceil(item.count * by)))
        })),
        levels: Math.min(100, Math.ceil(reward.levels * by))
    });
    return {
        first: one(rewards.first),
        second: one(rewards.second),
        third: one(rewards.third),
        everyone: one(rewards.everyone)
    };
}

// ------------------------------------------------------------------ what is remembered

const pointSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

/** What a restart must know of the fight; the stage itself is in `run.stage`. */
export const bossStateSchema = z.object({
    kind: z.enum(catalog.BOSS_KINDS),
    difficulty: z.enum(catalog.BOSS_DIFFICULTIES),
    arena: z.boolean(),
    /** Whoever has fought it, for its health. */
    fighters: z.array(z.string()).default([]),
    /** Its max health and Resistance as last set, once it stands. */
    max: z.number().default(0),
    resistance: z.number().int().default(0),
    phase: z.number().int().min(1).max(3).default(1),
    /** The second phase's minions have been summoned; the shield holds while any lives. */
    shielded: z.boolean().default(false),
    broken: z.boolean().default(false),
    /** Where the beam up to the arena stands, on the ground. */
    lift: pointSchema.nullable().default(null),
    /** Summoned and standing. */
    standing: z.boolean().default(false),
    /** How many of what it drops (`BossProfile.drops`), unnamed, each fighter
     *  carried when they came up: what is theirs, never taken back. */
    carried: z.record(z.string(), z.number().int().min(0)).default({})
});

export type BossState = z.infer<typeof bossStateSchema>;

export function freshState(kind: BossKind, options: Options): BossState {
    return bossStateSchema.parse({ kind, difficulty: options.difficulty, arena: options.arena });
}

// ------------------------------------------------------------------ the sky arena

/** Blocks from the middle of the floor to the inside of each wall. */
export const ARENA_HALF = 12;
/** Room between the floor and the roof. */
export const ARENA_ROOM = 9;
/** How far over the ground the floor is. */
export const ARENA_HEIGHT = 30;

const FLOOR_BLOCK = "minecraft:light_blue_stained_glass";
const WALL_BLOCK = "minecraft:white_stained_glass";

/** The whole volume the arena takes up, floor to roof, walls included. */
export function arenaVolume(origin: Point): stage.Volume {
    const half = ARENA_HALF + 1;
    return {
        x1: origin.x - half,
        y1: origin.y,
        z1: origin.z - half,
        x2: origin.x + half,
        y2: origin.y + ARENA_ROOM + 1,
        z2: origin.z + half
    };
}

/**
 * The arena's boxes, in the order they go up: a glass floor (nothing spawns on
 * glass), four walls and a roof - closed all round, so no knockback, pearl or
 * Wither leaves it. All glass: breaking a pane by hand drops nothing.
 */
export function arenaBoxes(origin: Point): stage.Box[] {
    const v = arenaVolume(origin);
    const wall = { y1: v.y1 + 1, y2: v.y2 - 1, block: WALL_BLOCK } as const;
    return [
        { ...v, y2: v.y1, block: FLOOR_BLOCK },
        { x1: v.x1, z1: v.z1, x2: v.x2, z2: v.z1, ...wall },
        { x1: v.x1, z1: v.z2, x2: v.x2, z2: v.z2, ...wall },
        { x1: v.x1, z1: v.z1 + 1, x2: v.x1, z2: v.z2 - 1, ...wall },
        { x1: v.x2, z1: v.z1 + 1, x2: v.x2, z2: v.z2 - 1, ...wall },
        { ...v, y1: v.y2, block: WALL_BLOCK }
    ];
}

/** Where a player is put on the floor: round the middle, facing it. */
export function arenaSpot(origin: Point, index: number): stage.Spot {
    const angle = (index * 2 * Math.PI) / 8 + Math.PI / 8;
    const radius = 8;
    const x = origin.x + 0.5 + Math.round(Math.sin(angle) * radius);
    const z = origin.z + 0.5 - Math.round(Math.cos(angle) * radius);
    const yaw = (Math.atan2(-(origin.x + 0.5 - x), origin.z + 0.5 - z) * 180) / Math.PI;
    return { x, y: origin.y + 1, z, yaw };
}

/** Where the boss stands in the arena: the middle of the floor. */
export function arenaCentre(origin: Point): Point {
    return { x: origin.x + 0.5, y: origin.y + 1, z: origin.z + 0.5 };
}

/** How far under the floor a fall is still caught; lower, they are on the ground. */
const CATCH_DEPTH = 20;

/** Whether somebody inside has fallen under the floor, and is still falling. */
export function underArena(origin: Point, at: Point): boolean {
    return at.y < origin.y && at.y >= origin.y - CATCH_DEPTH;
}

/**
 * Whether somebody inside has gone: another world, far off, or down on the
 * ground - back at their bed after a death, or a `/home`.
 */
export function leftArena(origin: Point, at: Point, dimension: string | undefined): boolean {
    if (dimension !== undefined && dimension !== "minecraft:overworld") return true;
    const far = ARENA_HALF + 16;
    return (
        Math.abs(at.x - (origin.x + 0.5)) > far ||
        Math.abs(at.z - (origin.z + 0.5)) > far ||
        at.y > origin.y + ARENA_ROOM + 16 ||
        at.y < origin.y - CATCH_DEPTH
    );
}

/** Whether the boss is still inside the arena. */
export function insideArena(origin: Point, at: Point): boolean {
    return (
        Math.abs(at.x - (origin.x + 0.5)) <= ARENA_HALF + 1 &&
        Math.abs(at.z - (origin.z + 0.5)) <= ARENA_HALF + 1 &&
        at.y >= origin.y &&
        at.y <= origin.y + ARENA_ROOM + 1
    );
}

/** The beam up to the arena, and who is standing in it and not up yet. */
export function liftBeam(lift: Point): string {
    return `${WORLD} particle minecraft:end_rod ${lift.x + 0.5} ${lift.y + 15} ${lift.z + 0.5} 0.2 15 0.2 0.01 80 force`;
}

export function inLift(lift: Point): string {
    return `execute in minecraft:overworld positioned ${lift.x + 0.5} ${lift.y + 0.5} ${lift.z + 0.5} as @a[distance=..2.5,tag=!${stage.IN_ARENA},gamemode=!creative,gamemode=!spectator] run data get entity @s Pos`;
}

/** Up into the arena: tagged as inside first, then moved, then in adventure
 *  mode, where nothing can be broken or placed. */
export function admitLines(name: string, spot: stage.Spot): string[] {
    return [
        `tag ${name} add ${stage.IN_ARENA}`,
        `effect give ${name} minecraft:slow_falling 3 0 true`,
        stage.moveLine(name, spot),
        `gamemode adventure ${name}`
    ];
}

/** Caught under the arena and put back on its floor, floating. */
export function catchLines(name: string, spot: stage.Spot): string[] {
    return [`effect give ${name} minecraft:slow_falling 5 0 true`, stage.moveLine(name, spot)];
}

/** Somebody who left it on their own - a death, a `/home` - let go where they
 *  are: their game mode back, the tag off. */
export function letGoLines(saved: stage.Saved, note: string): string[] {
    return [
        `gamemode ${saved.mode} ${saved.name}`,
        `tag ${saved.name} remove ${stage.IN_ARENA}`,
        `tellraw ${saved.name} ${text(note)}`
    ];
}

// ------------------------------------------------------------------ the boss itself

/** Mob data that keeps a summoned creature from taking or leaving anything. */
const KEEPS_NOTHING = [
    'PersistenceRequired:1b,CanPickUpLoot:0b,CanBreakDoors:0b,DeathLootTable:"minecraft:empty"',
    "CanJoinRaid:0b,PatrolLeader:0b,Patrolling:0b",
    "HandDropChances:[0.0f,0.0f],ArmorDropChances:[0.0f,0.0f,0.0f,0.0f]",
    "drop_chances:{mainhand:0.0f,offhand:0.0f,head:0.0f,chest:0.0f,legs:0.0f,feet:0.0f}"
].join(",");

/** Its attributes by the names 1.13 to 1.15 use, in its own data. */
function legacyAttributes(health: number, level: Difficulty): string {
    return [
        ["generic.maxHealth", Math.min(health, HEALTH_CAP)],
        ["generic.knockbackResistance", level.knockback],
        ["generic.armor", level.armor],
        ["generic.armorToughness", level.toughness],
        ["generic.attackDamage", level.attack],
        ["generic.followRange", 48]
    ]
        .map(([name, base]) => `{Name:"${name}",Base:${base}d}`)
        .join(",");
}

/** The boss, standing at `at`: tagged, never despawning, dropping nothing. */
export function summonLines(kind: BossKind, difficulty: BossDifficulty, health: number, at: Point): string[] {
    const profile = BOSSES[kind];
    const level = DIFFICULTY[difficulty];
    const attributes = legacyAttributes(health, level);
    const data = `{Tags:["${BOSS_TAG}"],Glowing:1b,CustomNameVisible:1b,${KEEPS_NOTHING},Attributes:[${attributes}],Health:${Math.min(health, HEALTH_CAP)}f}`;
    return [
        `kill ${`@e[tag=${BOSS_TAG}]`}`,
        `${WORLD} summon minecraft:${profile.entity} ${at.x} ${at.y} ${at.z} ${data}`
    ];
}

/** Its attributes, newest spelling first; `other` is the spelling to try on a refusal. */
export function attributeLines(
    kind: BossKind,
    difficulty: BossDifficulty,
    health: number,
    modernIds: boolean
): string[] {
    const level = DIFFICULTY[difficulty];
    const id = (name: string) => (modernIds ? `minecraft:${name}` : `minecraft:generic.${name}`);
    const lines = [
        `attribute ${BOSS} ${id("max_health")} base set ${health}`,
        `attribute ${BOSS} ${id("knockback_resistance")} base set ${level.knockback}`,
        `attribute ${BOSS} ${id("armor")} base set ${level.armor}`,
        `attribute ${BOSS} ${id("armor_toughness")} base set ${level.toughness}`,
        `attribute ${BOSS} ${id("attack_damage")} base set ${level.attack}`,
        `attribute ${BOSS} ${id("follow_range")} base set 48`,
        // No fall damage (1.20.5 on).
        `attribute ${BOSS} ${id("safe_fall_distance")} base set 1024`
    ];
    if (CALLS_FOR_HELP.includes(BOSSES[kind].entity)) {
        lines.push(
            `attribute ${BOSS} ${modernIds ? "minecraft:spawn_reinforcements" : "minecraft:zombie.spawn_reinforcements"} base set 0`
        );
    }
    return lines;
}

/** Its max health alone, when more fighters raise it. */
export function maxHealthLine(health: number, modernIds: boolean): string {
    return `attribute ${BOSS} ${modernIds ? "minecraft:max_health" : "minecraft:generic.max_health"} base set ${health}`;
}

/** What it holds and wears: a summoned mob with data is handed nothing. `item
 *  replace` from 1.17, `replaceitem` before; the other fails and changes nothing. */
export function equipLines(selector: string, slot: "weapon.mainhand" | "armor.head", item: string): string[] {
    return [`item replace entity ${selector} ${slot} with ${item}`, `replaceitem entity ${selector} ${slot} ${item}`];
}

export function bossEquipLines(kind: BossKind): string[] {
    const profile = BOSSES[kind];
    return [
        ...(profile.hand ? equipLines(BOSS, "weapon.mainhand", profile.hand) : []),
        ...(profile.head ? equipLines(BOSS, "armor.head", profile.head) : [])
    ];
}

/**
 * What it is given every tick, lasting a little past the next: fire and
 * drowning cannot hurt it, it is off anything it was made to ride, it has
 * never fallen, Resistance for its health (`splitHealth`) or the shield, and
 * its rage. Given again each tick rather than for good, so all of it wears off
 * on its own if Polaris stops.
 */
export function upkeepLines(
    state: BossState,
    options: { rides: boolean; shield: boolean; seconds?: number }
): string[] {
    const seconds = options.seconds ?? 6;
    const level = DIFFICULTY[state.difficulty];
    const lines = [`data merge entity ${BOSS} {FallDistance:0.0f}`];
    if (options.rides) lines.push(`ride ${BOSS} dismount`);
    // Fire and water cannot hurt a Wither, which takes no effect at all: its
    // shield is being invulnerable while it holds.
    if (effectImmune(state.kind)) {
        if (options.shield) lines.push(`data merge entity ${BOSS} {Invulnerable:1b}`);
        return lines;
    }
    lines.unshift(
        `effect give ${BOSS} minecraft:fire_resistance ${seconds} 0 true`,
        `effect give ${BOSS} minecraft:water_breathing ${seconds} 0 true`
    );
    if (options.shield) lines.push(`effect give ${BOSS} minecraft:resistance ${seconds} 4 true`);
    else if (state.resistance > 0)
        lines.push(`effect give ${BOSS} minecraft:resistance ${seconds} ${state.resistance - 1} true`);
    if (state.phase === 3) {
        lines.push(
            `effect give ${BOSS} minecraft:strength ${seconds} ${level.rage.strength} true`,
            `effect give ${BOSS} minecraft:speed ${seconds} ${level.rage.speed} true`
        );
    }
    return lines;
}

/** A Wither's rage, which no effect can give: faster, by its attributes, both spellings. */
export function immuneRageLines(): string[] {
    return ["movement_speed", "flying_speed"].flatMap((name) => [
        `attribute ${BOSS} minecraft:${name} base set 0.9`,
        `attribute ${BOSS} minecraft:generic.${name} base set 0.9`
    ]);
}

/** Monsters of the world, from 1.13 on, which the fight does not protect: an
 *  unknown name would refuse the whole selector on an older version. */
const MONSTERS = [
    "zombie",
    "zombie_villager",
    "husk",
    "drowned",
    "skeleton",
    "stray",
    "wither_skeleton",
    "creeper",
    "spider",
    "cave_spider",
    "enderman",
    "witch",
    "slime",
    "magma_cube",
    "phantom",
    "blaze",
    "silverfish",
    "endermite",
    "vex",
    "vindicator",
    "evoker"
] as const;

/**
 * Every creature near the fight that is neither a player, one of its own nor a
 * monster - a dog that followed its owner, a horse, a villager, a farm's
 * animals - takes no damage while it lasts.
 */
export function spareBystanders(seconds = 6): string {
    const monsters = MONSTERS.map((type) => `type=!minecraft:${type}`).join(",");
    return `${AT_BOSS} run effect give @e[distance=..48,type=!minecraft:player,tag=!${BOSS_TAG},tag=!${FIGHT_TAG},${monsters}] minecraft:resistance ${seconds} 4 true`;
}

/** An evoker's own vexes and fangs counted as the fight's, so the end takes them too. */
export const ADOPT_SUMMONED = ["vex", "evoker_fangs"].map(
    (type) => `${AT_BOSS} run tag @e[type=minecraft:${type},distance=..48,tag=!${FIGHT_TAG}] add ${FIGHT_TAG}`
);

/** The fight's own mobs never go far: brought back to the boss past 24 blocks. */
export const LEASH_MOBS = `${AT_BOSS} run tp @e[tag=${FIGHT_TAG},type=!minecraft:evoker_fangs,type=!minecraft:armor_stand,type=!minecraft:marker,distance=24..] @s`;

/** Back into the arena, to its middle, from wherever it got to. */
export function homeLine(at: Point): string {
    return `${WORLD} tp ${BOSS} ${at.x} ${at.y} ${at.z}`;
}

/** Beside a fighter who is out of its reach, or who trapped it. */
export function besideLine(name: string): string {
    return `execute at ${name} run tp ${BOSS} ~ ~ ~`;
}

/** Healing a little, while nobody fights it. */
export function healLine(health: number): string {
    return `data merge entity ${BOSS} {Health:${Math.round(health)}f}`;
}

/**
 * Closed in on every side where it stands - a box built round it: passes only
 * when none of the four blocks beside the one its feet are in is air.
 */
export const ENCLOSED = `execute at ${BOSS} align xz positioned ~0.5 ~ ~0.5 ${["~1 ~ ~", "~-1 ~ ~", "~ ~ ~1", "~ ~ ~-1"]
    .flatMap((beside) => ["air", "cave_air"].map((air) => `unless block ${beside} minecraft:${air}`))
    .join(" ")}`;

/** In water: where it could drown or turn into something else. */
export const IN_WATER = `execute at ${BOSS} if block ~ ~ ~ minecraft:water`;

// ------------------------------------------------------------------ who is fighting

/**
 * The fighters as a selector, from the boss: the ones up in the arena, or
 * everybody playing within reach of it on the land. `within` narrows the
 * distance from it; `extra` adds to the selector.
 */
export function fighters(arena: boolean, within: string | null = null, extra = ""): string {
    const distance = within ?? (arena ? null : `..${BOSS_FIGHT_REACH}`);
    const parts = [
        arena ? `tag=${stage.IN_ARENA}` : null,
        distance ? `distance=${distance}` : null,
        "gamemode=!creative",
        "gamemode=!spectator",
        extra || null
    ].filter(Boolean);
    return `@a[${parts.join(",")}]`;
}

/** Where every fighter is. */
export function fightersWhere(arena: boolean): string {
    return `${AT_BOSS} as ${fighters(arena)} run data get entity @s Pos`;
}

// ------------------------------------------------------------------ phases

export type BarColour = "yellow" | "purple" | "red";

export function phaseColour(phase: Phase): BarColour {
    return phase === 1 ? "yellow" : phase === 2 ? "purple" : "red";
}

export function barColourLine(phase: Phase): string {
    return `bossbar set ${BAR} color ${phaseColour(phase)}`;
}

/** A title to the fighters only. */
export function titleToFighters(arena: boolean, title: string, subtitle: string): string[] {
    const who = fighters(arena);
    return [
        `${AT_BOSS} run title ${who} times 5 50 15`,
        `${AT_BOSS} run title ${who} subtitle ${text(subtitle)}`,
        `${AT_BOSS} run title ${who} title ${text(title)}`
    ];
}

/** A line in the fighters' action bar. */
export function actionbarToFighters(arena: boolean, line: string): string {
    return `${AT_BOSS} run title ${fighters(arena)} actionbar ${text(line)}`;
}

/** A line in the fighters' chat. */
export function tellFighters(arena: boolean, line: string): string {
    return `${AT_BOSS} run tellraw ${fighters(arena)} ${text(line)}`;
}

/** A sound everybody near it hears. */
export function soundAt(id: string, pitch = 1): string {
    return `${AT_BOSS} run playsound ${id} hostile @a[distance=..48] ~ ~ ~ 2 ${pitch}`;
}

/**
 * The minions of the second phase, at the boss, each onto open air round it
 * where there is some: tagged for the shield, dropping nothing, never
 * despawning, armed, and kept from burning in the sun.
 */
export function minionLines(
    kind: BossKind,
    count: number,
    shield: boolean,
    difficulty: BossDifficulty = "normal"
): string[] {
    const minion = BOSSES[kind].minion;
    const tags = shield ? `"${FIGHT_TAG}","${SHIELD_TAG}","${NEW_TAG}"` : `"${FIGHT_TAG}","${NEW_TAG}"`;
    const data = `{Tags:[${tags}],Glowing:1b,${KEEPS_NOTHING}}`;
    const offsets = [
        [2, 0],
        [-2, 0],
        [0, 2],
        [0, -2],
        [2, 2],
        [-2, -2],
        [2, -2],
        [-2, 2],
        [3, 0],
        [-3, 0]
    ] as const;
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
        const [dx, dz] = offsets[index % offsets.length]!;
        lines.push(
            `${AT_BOSS} positioned ~${dx} ~ ~${dz} if block ~ ~ ~ minecraft:air if block ~ ~1 ~ minecraft:air run summon minecraft:${minion} ~ ~ ~ ${data}`
        );
    }
    // Nowhere open round it: at its feet, so the phase is never without them.
    if (count > 0)
        lines.push(`${AT_BOSS} unless entity @e[tag=${NEW_TAG}] run summon minecraft:${minion} ~ ~ ~ ${data}`);
    const fresh = `@e[tag=${NEW_TAG}]`;
    const hand = MINION_HANDS[minion];
    if (hand) lines.push(...equipLines(fresh, "weapon.mainhand", hand));
    if (CALLS_FOR_HELP.includes(minion)) {
        for (const id of ["minecraft:spawn_reinforcements", "minecraft:zombie.spawn_reinforcements"])
            lines.push(`execute as ${fresh} run attribute @s ${id} base set 0`);
    }
    const health = DIFFICULTY[difficulty].minionHealth;
    for (const id of ["minecraft:max_health", "minecraft:generic.max_health"])
        lines.push(`execute as ${fresh} run attribute @s ${id} base set ${health}`);
    lines.push(
        `execute as ${fresh} run data merge entity @s {Health:${health}f}`,
        `effect give ${fresh} minecraft:fire_resistance 1000000 0 true`,
        `tag ${fresh} remove ${NEW_TAG}`
    );
    return lines;
}

/** How many of the shield's minions are left: `Test passed, count: 3`. */
export const SHIELD_LEFT = `execute if entity @e[tag=${SHIELD_TAG}]`;

/** The shield shown round it while it holds. */
export const SHIELD_SHOWN = `${AT_BOSS} run particle minecraft:enchant ~ ~1.2 ~ 1 1.2 1 0.5 60 force`;

/** The shield taken off at once when its last minion falls. */
export const SHIELD_DOWN = [`effect clear ${BOSS} minecraft:resistance`, `data merge entity ${BOSS} {Invulnerable:0b}`];

// ------------------------------------------------------------------ abilities

export const ABILITIES = ["shockwave", "leap", "pull", "burst"] as const;
export type Ability = (typeof ABILITIES)[number];

/** How long each waits between uses on Normal in its first phase, in seconds. */
const BASE_COOLDOWN: Readonly<Record<Ability, number>> = {
    shockwave: 12,
    leap: 15,
    pull: 18,
    burst: 16
};

/** The least time between any two of its abilities, on Normal. */
export const ABILITY_GAP_S = 5;

/** How much sooner everything comes round in each phase. */
const PHASE_PACE: Readonly<Record<Phase, number>> = { 1: 1, 2: 0.85, 3: 0.6 };

export function cooldownMs(ability: Ability, difficulty: BossDifficulty, phase: Phase): number {
    return Math.round(BASE_COOLDOWN[ability] * DIFFICULTY[difficulty].cooldown * PHASE_PACE[phase] * 1000);
}

export function gapMs(difficulty: BossDifficulty, phase: Phase): number {
    return Math.round(ABILITY_GAP_S * DIFFICULTY[difficulty].cooldown * PHASE_PACE[phase] * 1000);
}

/** Radius of a shockwave, and of the blow where it lands from a leap. */
export const SHOCK_RADIUS = 6;
export const LANDING_RADIUS = 3;
/** A leap is only for somebody at least this far off. */
export const LEAP_FROM = 7;
/** How far one step of a pull or a push moves somebody. */
const STEP = 3;

/**
 * Which ability comes next, if one may: the one ready the longest, or none
 * while the last is too recent. A leap needs somebody far enough off.
 */
export function nextAbility(
    last: Partial<Record<Ability, number>>,
    lastAny: number,
    now: number,
    difficulty: BossDifficulty,
    phase: Phase,
    farthest: number
): Ability | null {
    if (now - lastAny < gapMs(difficulty, phase)) return null;
    let best: { ability: Ability; waited: number } | null = null;
    for (const ability of ABILITIES) {
        if (ability === "leap" && farthest < LEAP_FROM) continue;
        const since = now - (last[ability] ?? now - 10 * 60_000);
        const waited = since - cooldownMs(ability, difficulty, phase);
        if (waited < 0) continue;
        if (!best || waited > best.waited) best = { ability, waited };
    }
    return best?.ability ?? null;
}

/** Damage to one fighter from the boss: `damage` from 1.19.4, instant damage before. */
function hurt(selector: string, amount: number, modern: boolean): string {
    return modern
        ? `execute as ${selector} run damage @s ${amount} minecraft:mob_attack by ${BOSS}`
        : `effect give ${selector} minecraft:instant_damage 1 ${amount >= 10 ? 1 : 0} true`;
}

/** Moved `STEP` blocks along the way they face, only into two blocks of air. */
function stepLine(selector: string, facing: string, towards: boolean): string {
    const distance = towards ? STEP : -STEP;
    return `execute as ${selector} at @s ${facing} positioned ^ ^ ^${distance} if block ~ ~ ~ minecraft:air if block ~ ~1 ~ minecraft:air run tp @s ~ ~ ~`;
}

export interface AbilityLines {
    /** Sent a second before: what warns of it. */
    readonly warn: string[];
    /** Sent when it lands. */
    readonly act: string[];
}

export interface AbilityContext {
    readonly arena: boolean;
    readonly difficulty: BossDifficulty;
    /** Whether `damage` exists (1.19.4 on). */
    readonly damage: boolean;
    /** Who a leap is at: the fighter farthest off. */
    readonly target: string | null;
    /** The warning in the fighters' action bar. */
    readonly warning: string;
    /** Whether markers for the fangs are `marker` entities (1.17 on) or armour stands. */
    readonly markers: boolean;
}

export function abilityLines(ability: Ability, ctx: AbilityContext): AbilityLines {
    const blast = DIFFICULTY[ctx.difficulty].blast;
    const around = (radius: number) => fighters(ctx.arena, `..${radius}`);
    const warnBar = actionbarToFighters(ctx.arena, ctx.warning);
    switch (ability) {
        case "shockwave": {
            const near = around(SHOCK_RADIUS);
            return {
                warn: [
                    `${AT_BOSS} run particle minecraft:crit ~ ~0.2 ~ ${SHOCK_RADIUS / 2} 0 ${SHOCK_RADIUS / 2} 0.1 120 force`,
                    soundAt("minecraft:entity.evoker.prepare_attack", 0.6),
                    warnBar
                ],
                act: [
                    `${AT_BOSS} run particle minecraft:explosion ~ ~0.5 ~ ${SHOCK_RADIUS / 2} 0.3 ${SHOCK_RADIUS / 2} 0 16 force`,
                    soundAt("minecraft:entity.generic.explode", 0.8),
                    `${AT_BOSS} run ${hurt(near, blast, ctx.damage)}`,
                    `${AT_BOSS} run ${stepLine(near, `facing entity ${BOSS} feet`, false)}`
                ]
            };
        }
        case "leap": {
            const target = ctx.target && catalog.PLAYER_NAME.test(ctx.target) ? ctx.target : null;
            if (!target) return { warn: [], act: [] };
            const landing = around(LANDING_RADIUS);
            return {
                warn: [
                    `execute at ${target} run particle minecraft:flame ~ ~0.1 ~ 1 0 1 0.02 60 force`,
                    `${AT_BOSS} run particle minecraft:large_smoke ~ ~1 ~ 0.5 0.5 0.5 0.02 30 force`,
                    soundAt("minecraft:entity.ravager.roar", 1.2),
                    `title ${target} actionbar ${text(ctx.warning)}`
                ],
                act: [
                    besideLine(target),
                    `${AT_BOSS} run particle minecraft:explosion ~ ~0.5 ~ 1 0.3 1 0 6 force`,
                    soundAt("minecraft:entity.generic.explode", 1.1),
                    `${AT_BOSS} run ${hurt(landing, blast, ctx.damage)}`
                ]
            };
        }
        case "pull": {
            const far = fighters(ctx.arena, ctx.arena ? "4.." : `4..${BOSS_FIGHT_REACH}`);
            const facing = `facing entity ${BOSS} feet`;
            return {
                warn: [
                    `${AT_BOSS} run particle minecraft:portal ~ ~1 ~ 4 1 4 0.5 150 force`,
                    soundAt("minecraft:entity.evoker.prepare_summon", 0.8),
                    warnBar
                ],
                act: [
                    `${AT_BOSS} run ${stepLine(far, facing, true)}`,
                    `${AT_BOSS} run ${stepLine(far, facing, true)}`,
                    `${AT_BOSS} run effect give ${fighters(ctx.arena, "..12")} minecraft:slowness 2 1 true`,
                    soundAt("minecraft:entity.enderman.teleport", 0.6)
                ]
            };
        }
        case "burst": {
            // Fangs where every fighter stood when warned, in the arena; on the
            // land, vexes - which go for players and nothing else.
            if (ctx.arena) {
                const mark = ctx.markers
                    ? `minecraft:marker ~ ~ ~ {Tags:["${FIGHT_TAG}","${FANG_TAG}"]}`
                    : `minecraft:armor_stand ~ ~ ~ {Tags:["${FIGHT_TAG}","${FANG_TAG}"],Marker:1b,Invisible:1b,NoGravity:1b,Invulnerable:1b}`;
                const fangs = `{Tags:["${FIGHT_TAG}"],Warmup:0}`;
                return {
                    warn: [
                        `${AT_BOSS} run execute at ${fighters(ctx.arena)} run summon ${mark}`,
                        `execute at @e[tag=${FANG_TAG}] run particle minecraft:witch ~ ~0.3 ~ 0.7 0 0.7 0 30 force`,
                        soundAt("minecraft:entity.evoker.prepare_attack", 1.2),
                        warnBar
                    ],
                    act: [
                        ...[
                            [0, 0],
                            [1, 0],
                            [-1, 0],
                            [0, 1],
                            [0, -1]
                        ].map(
                            ([dx, dz]) =>
                                // Only while it stands: felled during the warning, nothing bites the winners.
                                `execute if entity ${BOSS} at @e[tag=${FANG_TAG}] positioned ~${dx} ~ ~${dz} run summon minecraft:evoker_fangs ~ ~ ~ ${fangs}`
                        ),
                        `kill @e[tag=${FANG_TAG}]`,
                        soundAt("minecraft:entity.evoker_fangs.attack", 1)
                    ]
                };
            }
            const count = ctx.difficulty === "epic" ? 3 : 2;
            const vex = `{Tags:["${FIGHT_TAG}"],LifeTicks:400,${KEEPS_NOTHING}}`;
            return {
                warn: [
                    `${AT_BOSS} run particle minecraft:witch ~ ~1.5 ~ 1 1 1 0 40 force`,
                    soundAt("minecraft:entity.evoker.prepare_summon", 1.2),
                    warnBar
                ],
                act: [
                    ...Array.from({ length: count }, () => `${AT_BOSS} run summon minecraft:vex ~ ~1.5 ~ ${vex}`),
                    soundAt("minecraft:entity.evoker.cast_spell", 1)
                ]
            };
        }
    }
}

/** The fighter farthest from the boss, and how far: `Ana has the following entity data: [..]`. */
export function farthestLine(arena: boolean): string {
    return `${AT_BOSS} as ${fighters(arena, null, "sort=furthest,limit=1")} run data get entity @s Pos`;
}

// ------------------------------------------------------------------ what it drops anyway

/**
 * Its own drop lying in the arena, taken: an item a creature drops on its death
 * is born with a long life, its age below zero, where a stack a player throws
 * starts at zero - so only the boss's goes. The age is read into a score first,
 * since a selector cannot compare it.
 */
export function looseDropLines(id: string, volume: stage.Volume): [string, string] {
    const box = `x=${volume.x1},y=${volume.y1},z=${volume.z1},dx=${volume.x2 - volume.x1},dy=${volume.y2 - volume.y1},dz=${volume.z2 - volume.z1}`;
    return [
        `execute in minecraft:overworld as @e[type=minecraft:item,${box},nbt={Item:{id:"${id}"}}] store result score @s ${SUM} run data get entity @s Age`,
        `${WORLD} kill @e[type=minecraft:item,${box},scores={${SUM}=..-1}]`
    ];
}

/** How many of it somebody carries without a name of its own (item components,
 *  1.20.5 on): a trophy has one, the drop has none. */
export function plainCountLine(name: string, id: string): string {
    return `clear ${name} ${id}[!minecraft:custom_name] 0`;
}

/** What somebody picked up of its drop, beyond what they carried, taken back. */
export function takeBackLine(name: string, id: string, count: number): string {
    return `clear ${name} ${id}[!minecraft:custom_name] ${count}`;
}

// ------------------------------------------------------------------ the trophy

/**
 * The final blow's trophy: a named nether star, written the three ways item
 * names have been - an SNBT text component from 1.21.5 (`text`), JSON in a
 * string from 1.20.5 (`json`), a `display` tag before (`tag`). The version's own
 * spelling first, so nothing is sent that it would refuse; the other component
 * spelling after it, for a version read wrong. A spelling a version does not
 * read is refused, and nothing given.
 */
export const TROPHY_ITEM = "minecraft:nether_star";

/** How a version writes an item's name. */
export type NameSpelling = "text" | "json" | "tag";

export function trophyArguments(name: string, lore: string, spelling: NameSpelling): string[] {
    const json = (value: string, colour: string) =>
        asciiJson(JSON.stringify({ text: value, color: colour, italic: false }));
    const snbt = (value: string, colour: string) =>
        `{text:${asciiJson(JSON.stringify(value))},color:"${colour}",italic:0b}`;
    const quoted = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    if (spelling !== "tag") {
        const asText = `${TROPHY_ITEM}[minecraft:custom_name=${snbt(name, "gold")},minecraft:lore=[${snbt(lore, "gray")}],minecraft:enchantment_glint_override=true]`;
        const asJson = `${TROPHY_ITEM}[minecraft:custom_name=${quoted(json(name, "gold"))},minecraft:lore=[${quoted(json(lore, "gray"))}],minecraft:enchantment_glint_override=true]`;
        return spelling === "text" ? [asText, asJson] : [asJson, asText];
    }
    return [`${TROPHY_ITEM}{display:{Name:${quoted(json(name, "gold"))},Lore:[${quoted(json(lore, "gray"))}]}}`];
}

// ------------------------------------------------------------------ the end

/**
 * Everything the fight summoned, out of the world: into the void first, where
 * whatever it would drop is lost, then killed - the minions, vexes and fangs
 * here, the boss by `commands.cleanup`. Safe to send again and again.
 */
export function bossCleanup(): string[] {
    return [
        `execute as @e[tag=${FIGHT_TAG}] at @s run tp @s ~ -1000 ~`,
        `kill @e[tag=${FIGHT_TAG}]`,
        `execute as @e[tag=${BOSS_TAG}] at @s run tp @s ~ -1000 ~`,
        `kill @e[tag=${BOSS_TAG}]`
    ];
}

/** The rules the fight holds, as the run writes them down: each list's names,
 *  and the value the fight wants. */
export function heldRules(kind: BossKind, arena: boolean): { names: readonly string[]; value: "true" | "false" }[] {
    const rules: { names: readonly string[]; value: "true" | "false" }[] = [
        { names: KEEP_INVENTORY, value: "true" }
    ];
    if (holdsGriefing(kind, arena)) rules.push({ names: MOB_GRIEFING, value: "false" });
    return rules;
}

/** Whether a name is one the game allows, before it goes into a command. */
export function isPlayer(name: string): boolean {
    return catalog.PLAYER_NAME.test(name);
}

export const BOSS_SELECTOR = BOSS;
