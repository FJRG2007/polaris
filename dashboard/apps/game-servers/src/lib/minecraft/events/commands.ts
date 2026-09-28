/**
 * The commands an event is played with, and how the server's answers are read.
 *
 * Pure, so every line a server is sent can be asserted without one. Everything
 * here is vanilla Java command syntax from 1.13 on: the scoreboard does the
 * counting (a statistic objective counts from the moment it is created, so there
 * is no "before" to subtract), a boss bar shows the clock, and a few invisible
 * markers find the surface where something has to stand.
 *
 * Every name Polaris adds to a world starts with `pe_` - objectives, tags - so
 * cleaning up after an event can never touch anything a player or another plugin
 * made.
 */

import { stripFormatting } from "../parse";
import { javaComponent } from "../announcement";
import type { EventKind, EventOptions, EventPreset } from "./catalog";

export const SCORE = "pe_score";
const SUM = "pe_sum";
const TMP = "pe_tmp";
const CONST = "pe_const";
const DEATHS = "pe_death";
const KILLS = "pe_kill";
const RAW_DAMAGE = "pe_raw";
const DAMAGE = "pe_acc";
export const BAR = "polaris:event";

export const MOB_TAG = "pe_mob";
const NEW_TAG = "pe_new";
export const BOSS_TAG = "pe_boss";
export const MARK_TAG = "pe_mark";

/** A counted statistic and what one of it is worth. */
export interface Component {
    readonly objective: string;
    readonly criterion: string;
    readonly weight: number;
}

const ORES: readonly (readonly [string, number])[] = [
    ["coal_ore", 1],
    ["deepslate_coal_ore", 1],
    ["copper_ore", 1],
    ["deepslate_copper_ore", 1],
    ["iron_ore", 2],
    ["deepslate_iron_ore", 2],
    ["gold_ore", 3],
    ["deepslate_gold_ore", 3],
    ["nether_gold_ore", 1],
    ["redstone_ore", 1],
    ["deepslate_redstone_ore", 1],
    ["lapis_ore", 2],
    ["deepslate_lapis_ore", 2],
    ["nether_quartz_ore", 1],
    ["emerald_ore", 6],
    ["deepslate_emerald_ore", 6],
    ["diamond_ore", 8],
    ["deepslate_diamond_ore", 8],
    ["ancient_debris", 10]
];

/** Hostile mobs and their worth: the ones that fight back hardest count most. */
const HOSTILE: readonly (readonly [string, number])[] = [
    ["zombie", 1],
    ["husk", 1],
    ["drowned", 1],
    ["zombie_villager", 1],
    ["skeleton", 1],
    ["stray", 1],
    ["bogged", 1],
    ["spider", 1],
    ["cave_spider", 1],
    ["creeper", 1],
    ["slime", 1],
    ["magma_cube", 1],
    ["silverfish", 1],
    ["endermite", 1],
    ["zombified_piglin", 1],
    ["pillager", 1],
    ["vex", 1],
    ["enderman", 2],
    ["witch", 2],
    ["blaze", 2],
    ["phantom", 2],
    ["guardian", 2],
    ["hoglin", 2],
    ["vindicator", 2],
    ["ghast", 3],
    ["wither_skeleton", 3],
    ["zoglin", 3],
    ["shulker", 3],
    ["breeze", 3],
    ["piglin_brute", 5],
    ["evoker", 5],
    ["ravager", 10],
    ["elder_guardian", 20],
    ["warden", 50]
];

/** Every way of getting about that is travelling rather than standing, in cm. */
const TRAVEL = [
    "walk_one_cm",
    "sprint_one_cm",
    "crouch_one_cm",
    "swim_one_cm",
    "walk_on_water_one_cm",
    "walk_under_water_one_cm",
    "horse_one_cm",
    "boat_one_cm",
    "pig_one_cm",
    "strider_one_cm",
    "aviate_one_cm"
];

const WAVE_MOBS = ["zombie", "skeleton", "spider"];

const numbered = (index: number) => `pe_c${index}`;

/** What an event counts, for the ones the scoreboard can count by itself. */
export function components(preset: EventPreset): Component[] {
    const list = (pairs: readonly (readonly [string, number])[], prefix: string) =>
        pairs.map(([id, weight], index) => ({
            objective: numbered(index),
            criterion: `${prefix}:minecraft.${id}`,
            weight
        }));
    switch (preset.kind) {
        case "mining-rush": {
            const target = (preset.options as EventOptions<"mining-rush">).target;
            const ores =
                target === "diamond"
                    ? ORES.filter(([id]) => id.includes("diamond")).map(([id]) => [id, 1] as const)
                    : target === "debris"
                      ? ([["ancient_debris", 1]] as const)
                      : ORES;
            return list(ores, "minecraft.mined");
        }
        case "mob-hunt": {
            const target = (preset.options as EventOptions<"mob-hunt">).target;
            return list(
                target === "hostile" ? HOSTILE : [[target, 1] as const],
                "minecraft.killed"
            );
        }
        case "blood-moon": {
            const creepers = (preset.options as EventOptions<"blood-moon">).creepers;
            return list(
                [...WAVE_MOBS, ...(creepers ? ["creeper"] : [])].map((id) => [id, 1] as const),
                "minecraft.killed"
            );
        }
        case "fishing":
            return [
                {
                    objective: numbered(0),
                    criterion: "minecraft.custom:minecraft.fish_caught",
                    weight: 1
                }
            ];
        case "explorer":
            return (preset.options as EventOptions<"explorer">).mode === "distance"
                ? TRAVEL.map((id, index) => ({
                      objective: numbered(index),
                      criterion: `minecraft.custom:minecraft.${id}`,
                      weight: 1
                  }))
                : [];
        default:
            return [];
    }
}

/** Distance is counted in centimetres and shown in metres. */
export function divisorFor(preset: EventPreset): number {
    return preset.kind === "explorer" ? 100 : 1;
}

/** Whether the event has a scoreboard on the side of the screen. */
export function hasScoreboard(preset: EventPreset): boolean {
    if (preset.kind === "happy-hour" || preset.kind === "supply-drop") return false;
    if (preset.kind === "explorer")
        return (preset.options as EventOptions<"explorer">).mode === "distance";
    return true;
}

// ------------------------------------------------------------------ text

/**
 * Formatted text as the game's JSON, with every character past ASCII written as
 * an escape: the line travels through a console and RCON, and an escape is
 * something none of them can mistake for another encoding.
 */
export function text(line: string): string {
    return asciiJson(javaComponent(line, false));
}

export function asciiJson(json: string): string {
    return json.replace(
        /[\u0080-￿]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
}

export function say(line: string): string {
    return `tellraw @a ${text(line)}`;
}

export function titleCommands(title: string, subtitle: string): string[] {
    return [
        "title @a times 10 70 20",
        `title @a subtitle ${text(subtitle)}`,
        `title @a title ${text(title)}`
    ];
}

export function sound(id: string): string {
    return `execute as @a at @s run playsound ${id} master @s ~ ~ ~ 1 1`;
}

export const SOUNDS = {
    tick: "minecraft:block.note_block.pling",
    start: "minecraft:block.bell.use",
    win: "minecraft:ui.toast.challenge_complete",
    horn: "minecraft:event.raid.horn",
    boss: "minecraft:entity.wither.spawn"
} as const;

// ------------------------------------------------------------------ boss bar

export type BarColour = "yellow" | "red" | "purple" | "green" | "blue";

export function barColour(kind: EventKind): BarColour {
    if (kind === "blood-moon" || kind === "world-boss") return "red";
    if (kind === "happy-hour") return "green";
    if (kind === "trivia") return "blue";
    return "yellow";
}

export function barCreate(name: string, colour: BarColour): string[] {
    return [
        `bossbar remove ${BAR}`,
        `bossbar add ${BAR} ${text(name)}`,
        `bossbar set ${BAR} color ${colour}`,
        `bossbar set ${BAR} style notched_10`,
        `bossbar set ${BAR} players @a`
    ];
}

/** The clock's bar: its name, and how full it is out of `max`. Also takes in
 *  whoever joined since the last one. */
export function barUpdate(name: string, value: number, max: number): string[] {
    return [
        `bossbar set ${BAR} name ${text(name)}`,
        `bossbar set ${BAR} max ${Math.max(1, Math.round(max))}`,
        `bossbar set ${BAR} value ${Math.max(0, Math.min(Math.round(max), Math.round(value)))}`,
        `bossbar set ${BAR} players @a`
    ];
}

// ------------------------------------------------------------------ scoreboard

/** The objectives an event counts with, and the side panel showing them. */
export function setupScoreboard(preset: EventPreset, title: string): string[] {
    const lines: string[] = [];
    for (const one of components(preset)) {
        lines.push(`scoreboard objectives remove ${one.objective}`);
        lines.push(`scoreboard objectives add ${one.objective} ${one.criterion}`);
    }
    if (!hasScoreboard(preset)) return lines;
    lines.push(
        `scoreboard objectives remove ${SCORE}`,
        `scoreboard objectives add ${SCORE} dummy ${text(title)}`,
        `scoreboard objectives setdisplay sidebar ${SCORE}`
    );
    if (components(preset).length > 0) {
        lines.push(
            `scoreboard objectives remove ${SUM}`,
            `scoreboard objectives add ${SUM} dummy`,
            `scoreboard objectives remove ${TMP}`,
            `scoreboard objectives add ${TMP} dummy`,
            `scoreboard objectives remove ${CONST}`,
            `scoreboard objectives add ${CONST} dummy`
        );
        const weights = new Set(components(preset).map((one) => one.weight));
        weights.add(divisorFor(preset));
        for (const weight of weights)
            lines.push(`scoreboard players set #w${weight} ${CONST} ${weight}`);
    }
    if (preset.kind === "blood-moon") {
        lines.push(
            `scoreboard objectives remove ${DEATHS}`,
            `scoreboard objectives add ${DEATHS} deathCount`
        );
    }
    return lines;
}

/**
 * The side panel brought up to date: every counted statistic, weighted and
 * added up, divided where the unit asks for it, and shown only once somebody
 * has scored - a column of zeroes is not a leaderboard.
 *
 * `add @a <objective> 0` first gives a player who has not counted anything yet
 * a zero, because an operation on a score nobody has set does nothing at all -
 * and the running total would carry the previous statistic's value over.
 */
export function scoreTick(preset: EventPreset): string[] {
    const counted = components(preset);
    if (counted.length === 0 || !hasScoreboard(preset)) return [];
    const lines: string[] = [];
    for (const one of counted) lines.push(`scoreboard players add @a ${one.objective} 0`);
    lines.push(`scoreboard players set @a ${SUM} 0`);
    for (const one of counted) {
        lines.push(
            `execute as @a run scoreboard players operation @s ${TMP} = @s ${one.objective}`
        );
        if (one.weight !== 1) {
            lines.push(
                `execute as @a run scoreboard players operation @s ${TMP} *= #w${one.weight} ${CONST}`
            );
        }
        lines.push(`execute as @a run scoreboard players operation @s ${SUM} += @s ${TMP}`);
    }
    const divisor = divisorFor(preset);
    if (divisor !== 1) {
        lines.push(
            `execute as @a run scoreboard players operation @s ${SUM} /= #w${divisor} ${CONST}`
        );
    }
    lines.push(
        `execute as @a[scores={${SUM}=1..}] run scoreboard players operation @s ${SCORE} = @s ${SUM}`
    );
    return lines;
}

/** One player's score set on the side panel - trivia's rounds, the hill's seconds. */
export function setScore(name: string, value: number): string {
    return `scoreboard players set ${name} ${SCORE} ${Math.round(value)}`;
}

/** Everybody's score on the panel, online or not: the answer lists everybody. */
export const READ_SCORES = `execute as @a run scoreboard players get @s ${SCORE}`;

/** One player's, for somebody who has gone offline since. */
export function readScoreCommand(name: string): string {
    return `scoreboard players get ${name} ${SCORE}`;
}

/** `Alice has 12 [pe_score]`, once per player. */
export function readScores(output: string, objective = SCORE): Map<string, number> {
    const found = new Map<string, number>();
    const pattern = new RegExp(`([A-Za-z0-9_]{1,16}) has (-?\\d+) \\[${objective}\\]`, "g");
    for (const match of stripFormatting(output).matchAll(pattern)) {
        found.set(match[1] as string, Number(match[2]));
    }
    return found;
}

// ------------------------------------------------------------------ who is where

/** Where everybody is: `Alice has the following entity data: [x, y, z]`. */
export const WHERE = "execute as @a run data get entity @s Pos";
/** Which way everybody is looking - a player who only turns around is not idle. */
export const FACING = "execute as @a run data get entity @s Rotation";
/** Everybody who is in the Overworld, by the same answer. */
export const IN_OVERWORLD =
    "execute in minecraft:overworld as @a[distance=0..] run data get entity @s Pos";

/** Which world everybody is in: `Alice has the following entity data: "minecraft:the_nether"`. */
export const DIMENSIONS = "execute as @a run data get entity @s Dimension";

export function readDimensions(output: string): Map<string, string> {
    const found = new Map<string, string>();
    const pattern = /([A-Za-z0-9_]{1,16}) has the following entity data: "([a-z0-9_:./-]+)"/g;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        found.set(match[1] as string, match[2] as string);
    }
    return found;
}

/**
 * The two running counts that tell a fight from outside the game: damage taken
 * and damage dealt. Kept on the server for good, under the same `pe_` prefix,
 * so the next look can see whether either went up.
 */
export const HURT = "pe_hurt";
export const HIT = "pe_hit";
export const COMBAT_OBJECTIVES = [
    `scoreboard objectives add ${HURT} minecraft.custom:minecraft.damage_taken`,
    `scoreboard objectives add ${HIT} minecraft.custom:minecraft.damage_dealt`
];
export const READ_HURT = `execute as @a run scoreboard players get @s ${HURT}`;
export const READ_HIT = `execute as @a run scoreboard players get @s ${HIT}`;

/** Positions out of a `WHERE` answer. */
export function readWhere(output: string): { name: string; x: number; y: number; z: number }[] {
    const found: { name: string; x: number; y: number; z: number }[] = [];
    const pattern =
        /([A-Za-z0-9_]{1,16}) has the following entity data: \[(-?[\d.E-]+)d, (-?[\d.E-]+)d, (-?[\d.E-]+)d\]/g;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        const [x, y, z] = [match[2], match[3], match[4]].map(Number) as [number, number, number];
        if ([x, y, z].every(Number.isFinite)) found.push({ name: match[1] as string, x, y, z });
    }
    return found;
}

/** Facings out of a `FACING` answer: `[yaw, pitch]` in floats. */
export function readFacing(output: string): Map<string, { yaw: number; pitch: number }> {
    const found = new Map<string, { yaw: number; pitch: number }>();
    const pattern =
        /([A-Za-z0-9_]{1,16}) has the following entity data: \[(-?[\d.E-]+)f, (-?[\d.E-]+)f\]/g;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        const yaw = Number(match[2]);
        const pitch = Number(match[3]);
        if (Number.isFinite(yaw) && Number.isFinite(pitch))
            found.set(match[1] as string, { yaw, pitch });
    }
    return found;
}

/** A single entity's position, for a marker: `... has the following entity data: [..]`. */
export function readPoint(output: string): { x: number; y: number; z: number } | null {
    const match =
        /has the following entity data: \[(-?[\d.E-]+)d, (-?[\d.E-]+)d, (-?[\d.E-]+)d\]/.exec(
            stripFormatting(output)
        );
    if (!match) return null;
    const [x, y, z] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
    return [x, y, z].every(Number.isFinite)
        ? { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }
        : null;
}

/** `Test passed` / `Test failed` - or neither, when the game could not say. */
export function readTest(output: string): "passed" | "failed" | "unloaded" | "unknown" {
    if (/not loaded|unloaded/i.test(output)) return "unloaded";
    if (/test passed/i.test(output)) return "passed";
    if (/test failed/i.test(output)) return "failed";
    return "unknown";
}

// ------------------------------------------------------------------ finding a place

/**
 * Keep the chunk around a point loaded - so a chest nobody is near yet stays
 * where it is, and a marker can be put there - and the matching release.
 */
export function forceload(x: number, z: number): string {
    return `execute in minecraft:overworld run forceload add ${x} ${z}`;
}

export function forceloadRemove(x: number, z: number): string {
    return `execute in minecraft:overworld run forceload remove ${x} ${z}`;
}

/**
 * Put an invisible marker at a point and let the game drop it on the surface.
 *
 * `spreadplayers` is the one vanilla command that finds the top of the ground
 * at a column, and it refuses water and lava - which is exactly the refusal
 * wanted: a chest at the bottom of an ocean is a chest nobody reaches.
 */
export function markSurface(x: number, z: number): string[] {
    return [
        `kill @e[tag=${MARK_TAG}]`,
        `execute in minecraft:overworld run summon minecraft:armor_stand ${x} 200 ${z} {Tags:["${MARK_TAG}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b}`,
        `execute in minecraft:overworld run spreadplayers ${x} ${z} 0 1 false @e[tag=${MARK_TAG}]`
    ];
}

export const READ_MARK = `data get entity @e[tag=${MARK_TAG},limit=1] Pos`;
export const CLEAR_MARK = `kill @e[tag=${MARK_TAG}]`;

/** Whether the game managed to put the marker down. */
export function spreadWorked(output: string): boolean {
    return /spread 1 (entity|player)/i.test(output) && !/could not spread/i.test(output);
}

/** A point `distance` away from a centre, at a random bearing, whole blocks. */
export function pointAway(
    centre: { x: number; z: number },
    distance: number,
    random: () => number
): { x: number; z: number } {
    const angle = random() * Math.PI * 2;
    const reach = distance * (0.7 + random() * 0.3);
    return {
        x: Math.round(centre.x + Math.cos(angle) * reach),
        z: Math.round(centre.z + Math.sin(angle) * reach)
    };
}

// ------------------------------------------------------------------ supply drop

const LOOT: Readonly<Record<EventOptions<"supply-drop">["loot"], string>> = {
    treasure: "minecraft:chests/buried_treasure",
    dungeon: "minecraft:chests/simple_dungeon",
    bastion: "minecraft:chests/bastion_treasure",
    "end-city": "minecraft:chests/end_city_treasure",
    "ancient-city": "minecraft:chests/ancient_city"
};

export function placeChest(
    point: { x: number; y: number; z: number },
    loot: EventOptions<"supply-drop">["loot"]
): string {
    return `execute in minecraft:overworld run setblock ${point.x} ${point.y} ${point.z} minecraft:chest{LootTable:"${LOOT[loot]}"} replace`;
}

/** Still unopened: a chest keeps its loot table until the first time it is opened. */
export function chestUnopened(point: { x: number; y: number; z: number }): string {
    return `execute in minecraft:overworld if data block ${point.x} ${point.y} ${point.z} LootTable`;
}

/** Whoever is at the chest when it is found open. */
export function nearest(point: { x: number; y: number; z: number }, within: number): string {
    return `execute in minecraft:overworld positioned ${point.x} ${point.y} ${point.z} as @a[distance=..${within},sort=nearest,limit=1] run data get entity @s Pos`;
}

/** The chest taken away, only while nobody has opened it: once found, what is inside is the finder's. */
export function removeChest(point: { x: number; y: number; z: number }): string {
    const at = `${point.x} ${point.y} ${point.z}`;
    return `execute in minecraft:overworld if block ${at} minecraft:chest if data block ${at} LootTable run setblock ${at} minecraft:air replace`;
}

/** A column of light over a point, seen from far off. */
export function beam(point: { x: number; y: number; z: number }): string {
    return `execute in minecraft:overworld run particle minecraft:end_rod ${point.x + 0.5} ${point.y + 8} ${point.z + 0.5} 0 8 0 0.01 60 force`;
}

/** How precisely each step tells where the chest is. */
export const REVEAL_STEPS = [200, 50, 0] as const;

/** The told position: rounded to the step, so it narrows down the search. */
export function roughly(value: number, step: number): number {
    return step === 0 ? value : Math.round(value / step) * step;
}

// ------------------------------------------------------------------ blood moon

export function nightfall(seconds: number): string[] {
    return ["time set 13000", `weather thunder ${Math.max(60, Math.round(seconds))}`];
}

/**
 * The game rules a blood moon holds still while it lasts: the clock, so the
 * night neither runs out before the event does (a Minecraft night is about eight
 * minutes) nor is slept through in a bed, and the weather, so the storm stays.
 * Put back to whatever the server had when it ends.
 */
export const FROZEN_RULES = ["doDaylightCycle", "doWeatherCycle"] as const;

export function readRule(name: string): string {
    return `gamerule ${name}`;
}

/** `Gamerule doDaylightCycle is currently set to: true`, or null when the game
 *  does not know the rule (a version that renamed it) or did not answer. */
export function readRuleValue(output: string): "true" | "false" | null {
    const match = /currently set to:?\s*(true|false)/i.exec(output);
    return match ? (match[1]!.toLowerCase() as "true" | "false") : null;
}

export function setRule(name: string, value: string): string {
    return `gamerule ${name} ${value}`;
}

export function daybreak(): string[] {
    return ["time set 23500", "weather clear", `kill @e[tag=${MOB_TAG}]`];
}

export const WAVE_EVERY_MS = 40_000;

const WAVE_SIZE: Readonly<Record<EventOptions<"blood-moon">["intensity"], number>> = {
    low: 2,
    medium: 3,
    high: 5
};

/**
 * One wave: mobs summoned on every player in survival in the Overworld, then
 * spread onto the surface a few blocks around them, so they come at the player
 * rather than inside them.
 */
export function wave(options: EventOptions<"blood-moon">, number: number): string[] {
    const kinds = [...WAVE_MOBS, ...(options.creepers ? ["creeper"] : [])];
    const players = "@a[gamemode=survival,distance=0..]";
    const lines: string[] = [];
    for (let index = 0; index < WAVE_SIZE[options.intensity]; index += 1) {
        const kind = kinds[(number + index) % kinds.length] as string;
        lines.push(
            `execute in minecraft:overworld as ${players} at @s run summon minecraft:${kind} ~ ~ ~ {Tags:["${MOB_TAG}","${NEW_TAG}"]}`
        );
    }
    lines.push(
        `execute in minecraft:overworld as ${players} at @s run spreadplayers ~ ~ 4 16 false @e[tag=${NEW_TAG},distance=..1]`,
        `tag @e[tag=${NEW_TAG}] remove ${NEW_TAG}`
    );
    return lines;
}

/** Who died during the night - their deaths counted from when it fell. */
export const READ_DEATHS = `execute as @a run scoreboard players get @s ${DEATHS}`;
export function readDeaths(output: string): Map<string, number> {
    return readScores(output, DEATHS);
}

// ------------------------------------------------------------------ world boss

const BOSS_ENTITY: Readonly<Record<EventOptions<"world-boss">["boss"], string>> = {
    "wither-skeleton": "wither_skeleton",
    ravager: "ravager",
    vindicator: "vindicator",
    husk: "husk"
};

export function bossEntity(boss: EventOptions<"world-boss">["boss"]): string {
    return BOSS_ENTITY[boss];
}

/**
 * The boss, on the marker.
 *
 * Named separately (`bossNameCommand`) because how a name is written into an
 * entity changed in 1.21.5, and the attributes separately too, because their
 * ids lost the `generic.` in 1.21.2 - both are tried in the order that fails
 * cleanly on the other versions.
 */
export function summonBoss(boss: EventOptions<"world-boss">["boss"]): string[] {
    return [
        `kill @e[tag=${BOSS_TAG}]`,
        `execute at @e[tag=${MARK_TAG},limit=1] run summon minecraft:${BOSS_ENTITY[boss]} ~ ~ ~ {Tags:["${BOSS_TAG}"],PersistenceRequired:1b,Glowing:1b,CustomNameVisible:1b}`
    ];
}

/** The name over the boss's head, written the way this version reads it. */
export function bossNameCommand(name: string, modernText: boolean): string {
    const component = text(`&c&l${name}`);
    const value = modernText ? componentAsSnbt(name) : `'${component.replace(/'/g, "\\'")}'`;
    return `data merge entity @e[tag=${BOSS_TAG},limit=1] {CustomName:${value}}`;
}

/** A plain red, bold name as an SNBT text component (1.21.5 and later). */
function componentAsSnbt(name: string): string {
    const escaped = asciiJson(JSON.stringify(name));
    return `{text:${escaped},color:"red",bold:1b}`;
}

/** Attributes to try, newest spelling first. */
export function bossAttributes(health: number, modernIds: boolean): string[] {
    const id = (name: string) => (modernIds ? `minecraft:${name}` : `minecraft:generic.${name}`);
    return [
        `attribute @e[tag=${BOSS_TAG},limit=1] ${id("max_health")} base set ${health}`,
        `attribute @e[tag=${BOSS_TAG},limit=1] ${id("knockback_resistance")} base set 0.8`,
        `attribute @e[tag=${BOSS_TAG},limit=1] ${id("armor")} base set 10`,
        `attribute @e[tag=${BOSS_TAG},limit=1] ${id("attack_damage")} base set 12`,
        `attribute @e[tag=${BOSS_TAG},limit=1] ${id("follow_range")} base set 48`
    ];
}

export function attributeWorked(output: string): boolean {
    return /base value/i.test(output) && !/unknown|invalid|incorrect|expected/i.test(output);
}

export function bossHeal(health: number): string {
    return `data merge entity @e[tag=${BOSS_TAG},limit=1] {Health:${health}f}`;
}

/** The boss bar follows the boss's health. */
export function bossBarHealth(): string {
    return `execute store result bossbar ${BAR} value run data get entity @e[tag=${BOSS_TAG},limit=1] Health`;
}

/** Whether the boss is still in the world (loaded, anyway). */
export const BOSS_ALIVE = `execute if entity @e[tag=${BOSS_TAG}]`;

/**
 * Damage dealt near the boss, counted into the panel: the game counts every hit
 * a player lands anywhere, so the raw count is emptied every tick and only what
 * was dealt within `reach` of the boss is kept. Shown in hearts (the statistic
 * is tenths of one).
 */
export function bossDamageTick(reach = 40): string[] {
    return [
        `scoreboard players add @a ${RAW_DAMAGE} 0`,
        `scoreboard players add @a ${DAMAGE} 0`,
        `execute as @e[tag=${BOSS_TAG},limit=1] at @s as @a[distance=..${reach}] run scoreboard players operation @s ${DAMAGE} += @s ${RAW_DAMAGE}`,
        `scoreboard players set @a ${RAW_DAMAGE} 0`,
        `execute as @a run scoreboard players operation @s ${SUM} = @s ${DAMAGE}`,
        `execute as @a run scoreboard players operation @s ${SUM} /= #w10 ${CONST}`,
        `execute as @a[scores={${SUM}=1..}] run scoreboard players operation @s ${SCORE} = @s ${SUM}`
    ];
}

export function bossScoreboard(boss: EventOptions<"world-boss">["boss"]): string[] {
    return [
        `scoreboard objectives remove ${RAW_DAMAGE}`,
        `scoreboard objectives add ${RAW_DAMAGE} minecraft.custom:minecraft.damage_dealt`,
        `scoreboard objectives remove ${DAMAGE}`,
        `scoreboard objectives add ${DAMAGE} dummy`,
        `scoreboard objectives remove ${SUM}`,
        `scoreboard objectives add ${SUM} dummy`,
        `scoreboard objectives remove ${CONST}`,
        `scoreboard objectives add ${CONST} dummy`,
        `scoreboard players set #w10 ${CONST} 10`,
        `scoreboard objectives remove ${KILLS}`,
        `scoreboard objectives add ${KILLS} minecraft.killed:minecraft.${BOSS_ENTITY[boss]}`
    ];
}

/** Where the boss is, while it is loaded. */
export const BOSS_WHERE = `data get entity @e[tag=${BOSS_TAG},limit=1] Pos`;

/**
 * Kills of the boss's kind counted from now, only while the boss still stands:
 * one command, so a kill is either before it (and the boss is gone) or after.
 */
export const BOSS_KILLS_RESET = `execute if entity @e[tag=${BOSS_TAG}] run scoreboard players set @a ${KILLS} 0`;

/** Whoever killed a mob of the boss's kind since it was last seen standing. */
export const BOSS_KILLERS = `execute as @a[scores={${KILLS}=1..}] run data get entity @s Pos`;

/** How far from where the boss was last seen its killer can be. */
export const BOSS_REACH = 48;

/** Out of the world, without a drop: an escaped boss leaves nothing behind. */
export const BOSS_BANISH = `execute as @e[tag=${BOSS_TAG}] at @s run tp @s ~ -1000 ~`;

// ------------------------------------------------------------------ explorer and the hill

/** Who has reached a column: a box twelve blocks wide from bedrock to the sky. */
export function arrived(x: number, z: number): string {
    return `execute in minecraft:overworld as @a[x=${x - 6},y=-64,z=${z - 6},dx=12,dy=384,dz=12] run data get entity @s Pos`;
}

/** The circle drawn in the air, and everybody inside it given the time. */
export function hillTick(
    point: { x: number; y: number; z: number },
    radius: number,
    seconds: number
): string[] {
    return [
        `execute in minecraft:overworld run particle minecraft:happy_villager ${point.x + 0.5} ${point.y + 1} ${point.z + 0.5} ${radius / 2} 0.2 ${radius / 2} 0 ${Math.min(80, radius * 8)} force`,
        `execute in minecraft:overworld positioned ${point.x + 0.5} ${point.y} ${point.z + 0.5} as @a[distance=..${radius},gamemode=!spectator] run scoreboard players add @s ${SCORE} ${seconds}`
    ];
}

// ------------------------------------------------------------------ happy hour

/** Each effect the hour can give, and its amplifier. */
const HAPPY_EFFECTS = [
    ["haste", 1],
    ["luck", 0],
    ["speed", 0],
    ["regeneration", 0]
] as const;

function happyChosen(options: EventOptions<"happy-hour">) {
    return HAPPY_EFFECTS.filter(([effect]) => options[effect]);
}

export function happyEffects(options: EventOptions<"happy-hour">, seconds: number): string[] {
    const time = Math.max(1, Math.ceil(seconds));
    return happyChosen(options).map(
        ([effect, level]) => `effect give @a minecraft:${effect} ${time} ${level} true`
    );
}

/** The hour's effects taken off again. */
export function happyEffectsClear(options: EventOptions<"happy-hour">): string[] {
    return happyChosen(options).map(([effect]) => `effect clear @a minecraft:${effect}`);
}

// ------------------------------------------------------------------ rewards

/** A prize for one player, as commands. The name is checked before it gets here. */
export function rewardCommands(
    name: string,
    reward: { items: readonly { id: string; count: number }[]; levels: number }
): string[] {
    const lines = reward.items.map((item) => `give ${name} ${item.id} ${item.count}`);
    if (reward.levels > 0) lines.push(`xp add ${name} ${reward.levels} levels`);
    return lines;
}

/** Whether a `give` reached somebody, rather than a server saying nobody is called that. */
export function gaveIt(output: string): boolean {
    return !/no player|not found|unknown|incorrect|expected|invalid|error/i.test(output);
}

// ------------------------------------------------------------------ the end

/** The chunks kept loaded for a place and the column tried for it, let go of. */
export function release(
    place: { x: number; z: number } | null,
    target: { x: number; z: number } | null
): string[] {
    const chunks = new Map<string, { x: number; z: number }>();
    for (const point of [target, place]) {
        if (point) chunks.set(`${point.x >> 4},${point.z >> 4}`, point);
    }
    return [...chunks.values()].map((point) => forceloadRemove(point.x, point.z));
}

/**
 * Everything an event leaves in the world taken out again: its objectives, the
 * bar, the markers, anything it summoned that is still about, the chunk it kept
 * loaded. Each line fails harmlessly when there is nothing to remove. A chest
 * somebody opened stays: what is inside is theirs.
 */
export function cleanup(
    preset: EventPreset,
    place: { x: number; y: number; z: number } | null,
    target: { x: number; z: number } | null = null,
    /** Game rules the event changed, and what they were before. */
    rules: Readonly<Record<string, string>> = {}
): string[] {
    const lines = [
        ...Object.entries(rules)
            .filter(([name, value]) => /^[A-Za-z:_]+$/.test(name) && (value === "true" || value === "false"))
            .map(([name, value]) => setRule(name, value)),
        `bossbar remove ${BAR}`,
        `scoreboard objectives remove ${SCORE}`,
        `scoreboard objectives remove ${SUM}`,
        `scoreboard objectives remove ${TMP}`,
        `scoreboard objectives remove ${CONST}`,
        `scoreboard objectives remove ${DEATHS}`,
        `scoreboard objectives remove ${KILLS}`,
        `scoreboard objectives remove ${RAW_DAMAGE}`,
        `scoreboard objectives remove ${DAMAGE}`,
        CLEAR_MARK
    ];
    for (const one of components(preset))
        lines.push(`scoreboard objectives remove ${one.objective}`);
    if (preset.kind === "world-boss") lines.push(BOSS_BANISH);
    if (preset.kind === "blood-moon") lines.push(...daybreak());
    if (preset.kind === "happy-hour")
        lines.push(...happyEffectsClear(preset.options as EventOptions<"happy-hour">));
    if (preset.kind === "supply-drop" && place) lines.push(removeChest(place));
    lines.push(...release(preset.kind === "explorer" ? null : place, target));
    return lines;
}
