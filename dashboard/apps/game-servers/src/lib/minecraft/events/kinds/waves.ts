/**
 * Horde defense: a point marked on open ground, and waves of monsters summoned
 * around it, each bigger and better armored than the last.
 *
 * Pure, like the rest of the commands. What keeps it from costing anybody
 * anything is here too:
 *
 * - Only monsters that cannot change a block come: no creeper, enderman,
 *   ravager, silverfish, blaze or slime. Zombies are summoned unable to break
 *   doors and unable to call for help (a zombie's reinforcements would be
 *   untagged, and so outlive the event), and nothing picks up loot.
 * - Everything summoned carries `MOB_TAG` - a jockey's mount too - and is kept
 *   on a leash round the point, inside chunks held loaded, so the `kill` at the
 *   end reaches every one. Nothing drops the gear it was handed.
 * - `keepInventory` is on for exactly the event (`KEEP_INVENTORY`), put back by
 *   the same record of game rules a blood moon uses.
 */

import * as hits from "./hits";
import type { EventOptions } from "../catalog";
import {
    DROPS_NOTHING,
    MOB_TAG,
    SCORE,
    armLines,
    equipLines,
    hillTick,
    readTest
} from "../commands";

export type WaveMix = EventOptions<"waves">["mix"];
/** What a wave is made of: a mix by name, or the monsters themselves - a
 *  villager defense sends only ones that go for a villager
 *  (`village-defense.villageMobs`). */
export type WaveKinds = WaveMix | readonly string[];

type Point = { readonly x: number; readonly y: number; readonly z: number };

/** Radius of the marked ring; the monsters are spread inside it, and the
 *  ground under all of it is checked to be the world's own. */
export const DEFENSE_RADIUS = 12;
/** Within this of the point a player counts as defending it. */
export const AREA = 24;
/** A monster that wanders further than this is brought back to the point. */
export const LEASH = 24;
/** Kills and hits within this of the point are the event's. */
export const REACH = 40;
/** How far each way the chunks round the point are held loaded, past the
 *  leash, so no monster is ever in ground the server let go of. */
export const LOAD_REACH = 32;
/** How far from anybody's bed the point may be: twice the usual, since what
 *  comes is a horde. */
export const CLEARANCE = 96;
/** The most monsters one wave may bring, however many defend. */
export const WAVE_CAP = 60;
/** The most defenders a wave grows for. */
export const CROWD_CAP = 5;

/** Only for as long as a wave is being summoned. */
const NEW_TAG = "pe_wnew";
/** What a jockey rides when it is not one of the wave itself - a chicken, a
 *  horse: never counted as left to kill, taken away when the wave is over. */
export const MOUNT_TAG = "pe_wmount";
/** A jockey and what it rides, left out of the spread: moved one by one, the
 *  rider would be put down beside its mount. */
const RIDING_TAG = "pe_wride";
/** A rider, for as long as it lives: left out of the leash, which brings back
 *  what it rides instead. */
const RIDER_TAG = "pe_wrider";
/** Kills near the point, and hits near it - the one who only wounds takes part too. */
export const KILLS = "pe_wkill";
export const HITS = "pe_whit";
const RAW_HITS = "pe_wraw";
/** Damage dealt near the point in health points, when that decides it. */
const DAMAGE = "pe_wdmg";
/** Where the ten the damage is divided by is kept, under `#ten`. */
const TEN = "pe_wten";

/** The monsters each mix sends, none of which can change a block. */
export const MIX_MOBS: Readonly<Record<WaveMix, readonly string[]>> = {
    classic: ["zombie", "skeleton", "spider"],
    undead: ["zombie", "husk", "skeleton", "stray"],
    mixed: ["zombie", "skeleton", "spider", "husk", "witch"]
};

/** The monsters a wave of `mix` is made of. */
export function kindsOf(mix: WaveKinds): readonly string[] {
    return typeof mix === "string" ? MIX_MOBS[mix] : mix;
}

/** The ones that can break a door and call for help. */
const ZOMBIES = ["zombie", "husk", "zombie_villager"];
/** The ones that fight with a bow. */
const ARCHERS = ["skeleton", "stray"];
/** The ones that wear armor. */
const WEARERS = [...ZOMBIES, ...ARCHERS];

/**
 * What every monster is summoned with: tagged, never despawning (a wave that
 * vanishes when players step away is not cleared), never picking anything up,
 * never breaking a door, and dropping none of the gear it was handed
 * (`DROPS_NOTHING`, both ways the game has written it).
 */
const MOB_DATA = `PersistenceRequired:1b,CanPickUpLoot:0b,CanBreakDoors:0b,${DROPS_NOTHING}`;
const SUMMON_DATA = `{Tags:["${MOB_TAG}","${NEW_TAG}"],${MOB_DATA}}`;

/**
 * The raw kill counters: with the events data pack on (`byPack`), the one its
 * advancement adds to for a monster the event summoned (`hits.WAVE_KILLS`);
 * otherwise one per kind of monster in the mix, the game's own `killed`
 * statistics - which count the night's own zombies just the same.
 */
function killObjectives(
    mix: WaveKinds,
    byPack = false
): { objective: string; criterion: string }[] {
    if (byPack) return [{ objective: hits.WAVE_KILLS, criterion: "dummy" }];
    return kindsOf(mix).map((id, index) => ({
        objective: `pe_wk${index}`,
        criterion: `minecraft.killed:minecraft.${id}`
    }));
}

// ------------------------------------------------------------------ how big and how strong

/**
 * How many monsters a wave brings: the base, half as many again for each wave
 * before it, and half as many again for each defender past the first (up to
 * `CROWD_CAP`), never past `WAVE_CAP`.
 */
export function waveSize(base: number, number: number, defenders: number): number {
    const perDefender = base + Math.round(base * 0.5 * Math.max(0, number));
    const crowd = 1 + 0.5 * (Math.min(CROWD_CAP, Math.max(1, defenders)) - 1);
    return Math.max(1, Math.min(WAVE_CAP, Math.round(perDefender * crowd)));
}

/** Health a monster gets for each defender past the first, as Absorption. */
export const CROWD_HEALTH = 4;

/**
 * What a wave is made stronger with: Strength from the third wave (a level
 * more from the fifth), Resistance from the fifth, Speed from the seventh - and
 * for the defenders at the point, past the first, `CROWD_HEALTH` more health
 * each (up to `CROWD_CAP` defenders) and a level of Strength more from three.
 */
export function waveEffects(number: number, defenders = 1): { effect: string; level: number }[] {
    const wave = number + 1;
    const extra = Math.min(CROWD_CAP, Math.max(1, defenders)) - 1;
    const effects: { effect: string; level: number }[] = [];
    const strength = (wave >= 5 ? 1 : wave >= 3 ? 0 : -1) + (extra >= 2 ? 1 : 0);
    if (strength >= 0) effects.push({ effect: "strength", level: strength });
    if (wave >= 5) effects.push({ effect: "resistance", level: 0 });
    if (wave >= 7) effects.push({ effect: "speed", level: 0 });
    if (extra > 0) effects.push({ effect: "absorption", level: extra - 1 });
    return effects;
}

// ------------------------------------------------------------------ what a wave wears

/** What each wave wears, from none on the first to diamond on the last. */
export const ARMOR_TIERS = ["none", "leather", "chainmail", "iron", "diamond"] as const;
export type ArmorTier = (typeof ARMOR_TIERS)[number];

/** The tier of wave `number` (from 0) of `waves`. */
export function armorTier(number: number, waves: number): ArmorTier {
    const last = ARMOR_TIERS.length - 1;
    const at = waves <= 1 ? last : Math.round((Math.max(0, number) * last) / (waves - 1));
    return ARMOR_TIERS[Math.min(last, at)] as ArmorTier;
}

const PIECES = [
    ["armor.head", "helmet"],
    ["armor.chest", "chestplate"],
    ["armor.legs", "leggings"],
    ["armor.feet", "boots"]
] as const;

/**
 * An enchanted item the three ways the game has written one: `enchantments`
 * with `levels` from 1.20.5, as a plain map from 1.21.5, an `Enchantments` tag
 * before 1.20.5. A version refuses the spellings it does not read.
 */
export function enchanted(item: string, enchantment: string, level: number): string[] {
    const id = `minecraft:${enchantment}`;
    return [
        `${item}[minecraft:enchantments={levels:{"${id}":${level}}}]`,
        `${item}[minecraft:enchantments={"${id}":${level}}]`,
        `${item}{Enchantments:[{id:"${id}",lvl:${level}s}]}`
    ];
}

/**
 * The wave just summoned armed and dressed: every monster's own weapon
 * (`armLines`), the tier's armor on those that wear it, and on the last two
 * tiers a sword for the zombies and Power on the bows - Sharpness on the swords
 * too on the last. The plain weapon goes first, so a monster is armed whatever
 * spelling of the enchanted one a version refuses.
 */
export function gearLines(tier: ArmorTier, kinds: readonly string[]): string[] {
    const fresh = (kind: string) => `@e[tag=${NEW_TAG},type=minecraft:${kind}]`;
    const lines = armLines(`tag=${NEW_TAG}`, kinds);
    if (tier !== "none") {
        for (const wearer of WEARERS.filter((one) => kinds.includes(one)))
            for (const [slot, piece] of PIECES)
                lines.push(...equipLines(fresh(wearer), slot, `minecraft:${tier}_${piece}`));
    }
    const rank = ARMOR_TIERS.indexOf(tier);
    if (rank >= 3) {
        for (const archer of ARCHERS.filter((one) => kinds.includes(one)))
            for (const bow of enchanted("minecraft:bow", "power", rank - 2))
                lines.push(...equipLines(fresh(archer), "weapon.mainhand", bow));
        for (const zombie of ZOMBIES.filter((one) => kinds.includes(one))) {
            lines.push(...equipLines(fresh(zombie), "weapon.mainhand", "minecraft:iron_sword"));
            if (rank >= 4)
                for (const sword of enchanted("minecraft:iron_sword", "sharpness", 1))
                    lines.push(...equipLines(fresh(zombie), "weapon.mainhand", sword));
        }
    }
    return lines;
}

// ------------------------------------------------------------------ jockeys

export const JOCKEYS = ["spider", "chicken", "skeleton-horse", "zombie-horse"] as const;
export type Jockey = (typeof JOCKEYS)[number];

/**
 * Which jockeys wave `number` (from 0) of `waves` may bring, as far as its mix
 * has their riders: spider jockeys from 40% of the way through, chicken jockeys
 * from 60%, skeleton and zombie horsemen from 80%. None rides a mount that can
 * change a block.
 */
export function jockeysFor(number: number, waves: number, mix: WaveKinds): Jockey[] {
    const share = waves <= 1 ? 1 : Math.max(0, number) / (waves - 1);
    const has = (id: string) => kindsOf(mix).includes(id);
    const out: Jockey[] = [];
    if (share >= 0.4 && has("spider") && has("skeleton")) out.push("spider");
    if (share >= 0.6 && has("zombie")) out.push("chicken");
    if (share >= 0.8 && has("skeleton")) out.push("skeleton-horse");
    if (share >= 0.8 && has("zombie")) out.push("zombie-horse");
    return out;
}

/** How many of a wave come riding: one in four, once jockeys come at all. */
export function jockeyCount(count: number, jockeys: readonly Jockey[]): number {
    return jockeys.length === 0 ? 0 : Math.floor(count / 4);
}

/**
 * A jockey summoned at `at`, its mount and its rider in one line, so they are
 * never apart. A spider is one of the wave - it fights, and counts; a chicken
 * or a horse is only a mount (`MOUNT_TAG`), which lays nothing and drops nothing.
 */
export function jockeyLine(jockey: Jockey, at: string): string {
    const riding = (id: string, extra = "") =>
        `{id:"minecraft:${id}",Tags:["${MOB_TAG}","${NEW_TAG}","${RIDING_TAG}","${RIDER_TAG}"],${MOB_DATA}${extra}}`;
    const summon = (id: string, tags: readonly string[], data: string, rider: string) =>
        `execute in minecraft:overworld run summon minecraft:${id} ${at} {Tags:[${tags.map((tag) => `"${tag}"`).join(",")}],${data},Passengers:[${rider}]}`;
    const mount = [MOB_TAG, NEW_TAG, MOUNT_TAG, RIDING_TAG];
    const keeps = 'PersistenceRequired:1b,DeathLootTable:"minecraft:empty"';
    switch (jockey) {
        case "spider":
            return summon("spider", [MOB_TAG, NEW_TAG, RIDING_TAG], MOB_DATA, riding("skeleton"));
        case "chicken":
            return summon(
                "chicken",
                mount,
                `${keeps},EggLayTime:1000000`,
                riding("zombie", ",IsBaby:1b")
            );
        case "skeleton-horse":
            return summon(
                "skeleton_horse",
                mount,
                `${keeps},SkeletonTrap:0b,Tame:0b`,
                riding("skeleton")
            );
        case "zombie-horse":
            return summon("zombie_horse", mount, `${keeps},Tame:0b`, riding("zombie"));
    }
}

/** Round the middle of the point, where the jockeys come down. */
const JOCKEY_SPOTS = [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
    [2, 2],
    [-2, -2],
    [2, -2],
    [-2, 2]
] as const;

/**
 * Where a jockey comes down: two blocks from the middle of the point, a block
 * up - ground the place was judged on, level with the point. Not spread like
 * the rest: `spreadplayers` moves a rider on its own, off its mount.
 */
function jockeySpot(point: Point, index: number): string {
    const [dx, dz] = JOCKEY_SPOTS[index % JOCKEY_SPOTS.length]!;
    return `${point.x + 0.5 + dx} ${point.y + 1} ${point.z + 0.5 + dz}`;
}

/** The objectives the kills and hits are counted with. */
export function wavesSetup(mix: WaveKinds, byPack = false): string[] {
    const lines: string[] = [];
    for (const one of killObjectives(mix, byPack)) {
        lines.push(
            `scoreboard objectives remove ${one.objective}`,
            `scoreboard objectives add ${one.objective} ${one.criterion}`
        );
    }
    lines.push(
        `scoreboard objectives remove ${KILLS}`,
        `scoreboard objectives add ${KILLS} dummy`,
        `scoreboard objectives remove ${RAW_HITS}`,
        `scoreboard objectives add ${RAW_HITS} minecraft.custom:minecraft.damage_dealt`,
        `scoreboard objectives remove ${HITS}`,
        `scoreboard objectives add ${HITS} dummy`,
        `scoreboard objectives remove ${DAMAGE}`,
        `scoreboard objectives add ${DAMAGE} dummy`,
        `scoreboard objectives remove ${TEN}`,
        `scoreboard objectives add ${TEN} dummy`,
        `scoreboard players set #ten ${TEN} 10`
    );
    return lines;
}

/** What a wave is set up with besides its size: how many waves there are, and
 *  how many defend the point as it comes. */
export interface WaveShape {
    readonly waves: number;
    readonly defenders: number;
}

/**
 * One wave, summoned on the point and spread onto the surface inside the ring,
 * then armed, dressed for its tier and made as strong as its number and its
 * defenders say. The jockeys come down round the ring's edge instead, whole.
 * Lasts as long as the event may still run, so no effect runs out mid-wave.
 */
export function summonWave(
    point: Point,
    mix: WaveKinds,
    count: number,
    number: number,
    seconds: number,
    shape: WaveShape = { waves: 5, defenders: 1 }
): string[] {
    const kinds = kindsOf(mix);
    const at = `${point.x + 0.5} ${point.y} ${point.z + 0.5}`;
    const time = Math.max(60, Math.min(1_000_000, Math.ceil(seconds)));
    const jockeys = jockeysFor(number, shape.waves, mix);
    const riding = jockeyCount(count, jockeys);
    const lines: string[] = [];
    for (let index = 0; index < count - riding; index += 1) {
        const kind = kinds[(number + index) % kinds.length] as string;
        lines.push(
            `execute in minecraft:overworld run summon minecraft:${kind} ${at} ${SUMMON_DATA}`
        );
    }
    const fresh = `@e[tag=${NEW_TAG}]`;
    lines.push(
        `execute in minecraft:overworld run spreadplayers ${point.x} ${point.z} 2 ${DEFENSE_RADIUS} false @e[tag=${NEW_TAG},tag=!${RIDING_TAG}]`
    );
    for (let index = 0; index < riding; index += 1) {
        const jockey = jockeys[index % jockeys.length] as Jockey;
        lines.push(jockeyLine(jockey, jockeySpot(point, index)));
    }
    // Every rider is of a kind the mix already sends (`jockeysFor`).
    lines.push(...gearLines(armorTier(number, shape.waves), kinds));
    for (const zombie of ZOMBIES.filter((id) => kinds.includes(id))) {
        // No calls for help: a reinforcement is a zombie nobody tagged. The
        // attribute lost its `zombie.` in 1.21.2; both are tried.
        for (const id of [
            "minecraft:spawn_reinforcements",
            "minecraft:zombie.spawn_reinforcements"
        ]) {
            lines.push(
                `execute as @e[tag=${NEW_TAG},type=minecraft:${zombie}] run attribute @s ${id} base set 0`
            );
        }
    }
    // The fighters only - never a mount: glowing, to find the last one; fire
    // resistance, so a wave in daylight is not burnt away by the sun before
    // anybody fights it.
    const fighters = `@e[tag=${NEW_TAG},tag=!${MOUNT_TAG}]`;
    lines.push(
        `effect give ${fighters} minecraft:glowing ${time} 0 true`,
        `effect give ${fresh} minecraft:fire_resistance ${time} 0 true`
    );
    for (const { effect, level } of waveEffects(number, shape.defenders)) {
        lines.push(`effect give ${fighters} minecraft:${effect} ${time} ${level} true`);
    }
    lines.push(`tag ${fresh} remove ${RIDING_TAG}`, `tag ${fresh} remove ${NEW_TAG}`);
    return lines;
}

/** How many of the wave's monsters are still about - never a mount: `Test
 *  passed, count: 7`. */
export const WAVE_ALIVE = `execute if entity @e[tag=${MOB_TAG},tag=!${MOUNT_TAG}]`;

/** The mounts of a wave that is over, taken away with it. */
export const MOUNTS_GONE = `kill @e[tag=${MOUNT_TAG}]`;

/** The count out of a `WAVE_ALIVE` answer: 0 when none is left, null when the
 *  server could not say. */
export function readAlive(output: string): number | null {
    const answer = readTest(output);
    if (answer === "failed") return 0;
    if (answer !== "passed") return null;
    const match = /count:\s*(\d+)/i.exec(output);
    return match ? Number(match[1]) : 1;
}

/** Everybody defending the point now, as a `WHERE`-style answer. */
export function defenders(point: Point): string {
    return `execute in minecraft:overworld positioned ${point.x + 0.5} ${point.y} ${point.z + 0.5} as @a[distance=..${AREA},gamemode=!spectator,gamemode=!creative] run data get entity @s Pos`;
}

/** Any monster that strayed too far brought back onto the point, which is open
 *  air: a leash, so none walks off into ground nobody has loaded. A rider goes
 *  with what it rides, which is brought back instead. */
export function leash(point: Point): string {
    const at = `${point.x + 0.5} ${point.y} ${point.z + 0.5}`;
    return `execute in minecraft:overworld positioned ${at} as @e[tag=${MOB_TAG},tag=!${RIDER_TAG},distance=${LEASH}..] run tp @s ${at}`;
}

/** The ring and the column of light, from the hill's - without its counting. */
export function wavesMarks(point: Point): string[] {
    return hillTick(point, DEFENSE_RADIUS, 0).filter((line) => !line.includes("scoreboard"));
}

/**
 * The kills and hits made near the point since the last tick added to each
 * player's, and the side panel brought up to date - with the kills, or with
 * the damage dealt when that decides it (`byDamage`). Anything done elsewhere,
 * or while no wave is on (`open` false), is let go: the raw counts are emptied
 * every tick either way. The game counts the damage in tenths of a health
 * point, and only what is dealt by hand.
 */
export function wavesTick(
    point: Point,
    mix: WaveKinds,
    open: boolean,
    byDamage = false,
    byPack = false
): string[] {
    const near = `execute in minecraft:overworld positioned ${point.x + 0.5} ${point.y} ${point.z + 0.5} as @a[distance=..${REACH}] run scoreboard players operation @s`;
    const raw = [...killObjectives(mix, byPack).map((one) => one.objective), RAW_HITS];
    const lines: string[] = [];
    for (const objective of [...raw, KILLS, HITS])
        lines.push(`scoreboard players add @a ${objective} 0`);
    if (open) {
        for (const one of killObjectives(mix, byPack))
            lines.push(`${near} ${KILLS} += @s ${one.objective}`);
        lines.push(`${near} ${HITS} += @s ${RAW_HITS}`);
    }
    for (const objective of raw) lines.push(`scoreboard players set @a ${objective} 0`);
    if (byDamage) {
        lines.push(
            `execute as @a run scoreboard players operation @s ${DAMAGE} = @s ${HITS}`,
            `execute as @a run scoreboard players operation @s ${DAMAGE} /= #ten ${TEN}`,
            `execute as @a[scores={${DAMAGE}=1..}] run scoreboard players operation @s ${SCORE} = @s ${DAMAGE}`
        );
        return lines;
    }
    lines.push(
        `execute as @a[scores={${KILLS}=1..}] run scoreboard players operation @s ${SCORE} = @s ${KILLS}`
    );
    return lines;
}

/** Everybody's hits near the point, online: `Ana has 40 [pe_whit]`. */
export const READ_HITS = `execute as @a run scoreboard players get @s ${HITS}`;

/** The game rule held on while it runs, under every name it has had. */
export const KEEP_INVENTORY = ["keepInventory", "keep_inventory"] as const;

/**
 * What a horde defense leaves, taken out: every monster it summoned and every
 * mount - while the chunks they are in are still held, so it goes before any
 * chunk is let go - then its objectives. Safe to send again and again.
 */
export function wavesCleanup(mix: WaveKinds): string[] {
    const lines = [`kill @e[tag=${MOB_TAG}]`];
    for (const one of [...killObjectives(mix), ...killObjectives(mix, true)])
        lines.push(`scoreboard objectives remove ${one.objective}`);
    lines.push(
        `scoreboard objectives remove ${KILLS}`,
        `scoreboard objectives remove ${RAW_HITS}`,
        `scoreboard objectives remove ${HITS}`,
        `scoreboard objectives remove ${DAMAGE}`,
        `scoreboard objectives remove ${TEN}`
    );
    return lines;
}
