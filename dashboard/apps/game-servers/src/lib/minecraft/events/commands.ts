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

import * as speech from "../speech";
import { stripFormatting } from "../parse";
import { duelTeardown } from "./kinds/team-duel";
import { COMMAND_BYTES_MAX, commandBytes } from "../command-size";
import {
    worldNeeds,
    type EventKind,
    type EventOptions,
    type EventPreset,
    type WorldNeeds
} from "./catalog";

export const SCORE = "pe_score";
export const SUM = "pe_sum";
const TMP = "pe_tmp";
const CONST = "pe_const";
const DEATHS = "pe_death";
const KILLS = "pe_kill";
const RAW_DAMAGE = "pe_raw";
/** Shots at the boss since the last look - a bow, a crossbow, a thrown trident -
 *  summed into the first. */
const SHOTS = ["pe_shot", "pe_shotc", "pe_shott"] as const;
const SHOT_ITEMS = ["bow", "crossbow", "trident"] as const;
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

/** Every ore block and what one is worth to a mining rush. */
export const ORES: readonly (readonly [string, number])[] = [
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
            // Minus every one of them placed during the rush: with silk touch
            // an ore block can be put down and mined again, over and over.
            const mined = list(ores, "minecraft.mined");
            const placed = ores.map(([id, weight], index) => ({
                objective: numbered(ores.length + index),
                criterion: `minecraft.used:minecraft.${id}`,
                weight: -weight
            }));
            return [...mined, ...placed];
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

/** Distance is counted in centimeters and shown in meters. */
export function divisorFor(preset: EventPreset): number {
    return preset.kind === "explorer" ? 100 : 1;
}

/** Whether the event has a scoreboard on the side of the screen. */
export function hasScoreboard(preset: EventPreset): boolean {
    if (preset.kind === "happy-hour" || preset.kind === "supply-drop") return false;
    if (preset.kind === "rare-catch" || preset.kind === "xp-boost") return false;
    // Who is left standing is on the boss bar; there is nothing to add up.
    if (preset.kind === "spleef") return false;
    if (preset.kind === "explorer")
        return (preset.options as EventOptions<"explorer">).mode === "distance";
    return true;
}

// ------------------------------------------------------------------ text

/**
 * Formatted text as the game's JSON, with every character past ASCII written as
 * an escape: the line travels through a console and RCON, and an escape is
 * something none of them can mistake for another encoding. A line written in
 * every language carries each one's JSON until it is sent (`speech.localize`).
 */
export function text(line: string): string {
    return speech.formatted(line);
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

export type BarColor = "yellow" | "red" | "purple" | "green" | "blue";

export function barColor(kind: EventKind): BarColor {
    if (kind === "blood-moon" || kind === "world-boss") return "red";
    if (kind === "happy-hour" || kind === "xp-boost") return "green";
    if (kind === "trivia") return "blue";
    return "yellow";
}

export function barCreate(name: string, color: BarColor): string[] {
    return [
        `bossbar remove ${BAR}`,
        `bossbar add ${BAR} ${text(name)}`,
        `bossbar set ${BAR} color ${color}`,
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
 * Each statistic is read into the scratch score with `store result`, which
 * writes a zero when the read fails. A read fails for a player who has not
 * counted anything yet, and for a statistic this version of the game does not
 * have - no deepslate or copper ores before 1.17 - whose objective was never
 * made. Copied with `operation` instead, the copy failed and left the previous
 * statistic's value in the scratch score, counted again under this one's
 * weight: a coal ore mined on 1.16 scored four times over.
 */
export function scoreTick(preset: EventPreset): string[] {
    const counted = components(preset);
    if (counted.length === 0 || !hasScoreboard(preset)) return [];
    const lines: string[] = [`scoreboard players set @a ${SUM} 0`];
    for (const one of counted) {
        lines.push(
            `execute as @a store result score @s ${TMP} run scoreboard players get @s ${one.objective}`
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

/**
 * `Alice has 12 [Blood moon]`, once per player, from one objective's read.
 *
 * The bracket holds the objective's DISPLAY name, not its id - the event's own
 * title for the side panel - so it is not matched on: every read asks about a
 * single objective, and whatever the brackets say is that one. Matching the id
 * there read every score on a real server as nothing, and left every podium
 * empty.
 */
export function readScores(output: string): Map<string, number> {
    const found = new Map<string, number>();
    const pattern = /(\.?[A-Za-z0-9_]{1,16}) has (-?\d+) \[[^\n]*?\]/g;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        found.set(match[1] as string, Number(match[2]));
    }
    return found;
}

// ------------------------------------------------------------------ the chat

/** A chat line in the server log: `[12:00:01] [Server thread/INFO]: <Alice> hello`,
 *  NeoForge's extra bracket and the "Not Secure" mark allowed for. */
export const CHAT_LINE = /\]: (?:\[Not Secure\] )?<(\.?[A-Za-z0-9_]{1,16})> (.+)$/gm;

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

/** Up to 1.15 a player's world is a number: -1 the Nether, 0 the Overworld, 1 the End. */
const NUMBERED_WORLDS: Readonly<Record<string, string>> = {
    "-1": "minecraft:the_nether",
    "0": "minecraft:overworld",
    "1": "minecraft:the_end"
};

export function readDimensions(output: string): Map<string, string> {
    const found = new Map<string, string>();
    const pattern =
        /(\.?[A-Za-z0-9_]{1,16}) has the following entity data: (?:"([a-z0-9_:./-]+)"|(-?\d+)(?![\d.]))/g;
    for (const match of stripFormatting(output).matchAll(pattern)) {
        const world = match[2] ?? NUMBERED_WORLDS[match[3] as string];
        if (world) found.set(match[1] as string, world);
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
        /(\.?[A-Za-z0-9_]{1,16}) has the following entity data: \[(-?[\d.E-]+)d, (-?[\d.E-]+)d, (-?[\d.E-]+)d\]/g;
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
        /(\.?[A-Za-z0-9_]{1,16}) has the following entity data: \[(-?[\d.E-]+)f, (-?[\d.E-]+)f\]/g;
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

/**
 * Whether somebody an event moved is back already: on, and no longer carrying
 * the tag it gave them for as long as they were in. An end that sent everybody
 * back and was stopped before it could write so leaves them listed as still
 * owed the trip - and a player who has since walked off must not be moved
 * again. Offline, or an answer it cannot read, is never "back".
 */
export async function alreadyBack(
    say: (line: string) => Promise<string>,
    name: string,
    tag: string
): Promise<boolean> {
    if (readTest(await say(`execute if entity @a[name=${name},tag=${tag}]`)) !== "failed")
        return false;
    return readTest(await say(`execute if entity @a[name=${name}]`)) === "passed";
}

// ------------------------------------------------------------------ what the server understands

/**
 * A command that parses only where items are written with components (1.20.5
 * on), and one that exists only from 1.16. Both name nobody - a tag no player
 * has - so neither can do anything; `clear` with a count of 0 takes nothing even
 * from somebody it finds.
 */
export const PROBE_COMPONENTS =
    "clear @a[tag=pe_probe] minecraft:stone[minecraft:custom_data={polaris_event:1b}] 0";
export const PROBE_ATTRIBUTE =
    "attribute @e[tag=pe_probe,limit=1] minecraft:generic.max_health get";

/** Whether the game read a probe as a command it knows, rather than refusing it. */
export function probeParsed(output: string): boolean {
    const said = output.trim();
    return (
        said.length > 0 &&
        !/<--\[HERE\]|unknown command|unknown or incomplete|incorrect argument|expected/i.test(said)
    );
}

/**
 * Whether the game has the command at all, whatever it made of the rest: from
 * 1.21.2 the attribute probe's id is refused as unknown, which is still an
 * `attribute` command answering.
 */
export function commandKnown(output: string): boolean {
    const said = output.trim();
    return said.length > 0 && !/unknown (or incomplete )?command/i.test(said);
}

// ------------------------------------------------------------------ Bukkit's plugins

/**
 * Asked once of a server to tell a Bukkit-family one (Spigot, Paper, Purpur and
 * the hybrids): only there is every vanilla command also `minecraft:<name>`.
 * Vanilla, Fabric and the Forge family know no such command.
 */
export const BUKKIT_PROBE = "minecraft:difficulty";

/** `The difficulty is Normal` from a Bukkit-family server. */
export function isBukkit(output: string): boolean {
    return /difficulty is/i.test(output);
}

/** Where an `execute`'s `run` is: the first one outside brackets and quotes. */
function runAt(line: string): number {
    let depth = 0;
    let quote: string | null = null;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index] as string;
        if (quote) {
            if (char === "\\") index += 1;
            else if (char === quote) quote = null;
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "[" || char === "{") depth += 1;
        else if (char === "]" || char === "}") depth -= 1;
        else if (depth === 0 && line.startsWith(" run ", index)) return index;
    }
    return -1;
}

/**
 * A line with its command - and the one an `execute` runs - named as vanilla's
 * own. A plugin's command of the same name wins over vanilla's on a Bukkit-family
 * server: EssentialsX has `kill`, `give`, `tp`, `gamemode`, `clear`, `xp`,
 * `time`, `weather` and `item`, and answers them its own way - players only for
 * `kill`, no `xp add`, no item with components to `clear` - so markers and
 * bosses lived on, kits were never taken back and prizes never arrived.
 */
export function namespaced(line: string): string {
    const named = namespacedAll(line);
    // Never at the price of a line too long to arrive: as it was, it may still.
    return commandBytes(named) <= COMMAND_BYTES_MAX ? named : line;
}

const NAMESPACE = "minecraft:";

function namespacedAll(line: string): string {
    const verb = /^([a-z_]+)(?= |$)/.exec(line)?.[1];
    if (!verb) return line;
    if (verb === "execute") {
        const at = runAt(line);
        if (at >= 0)
            return `${NAMESPACE}${line.slice(0, at)} run ${namespacedAll(line.slice(at + 5))}`;
    }
    return `${NAMESPACE}${line}`;
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

/**
 * The marker put on the ground under the trees, not on top of them.
 *
 * `spreadplayers` lands on the first block from the sky, which in a forest is a
 * crown of leaves - nowhere anybody walks to, so every place in a wood was given
 * up. The game's own heightmap that leaves out leaves does exactly this, from
 * 1.19.4; `markSurface` is what an older server gets instead. It stops on water
 * as well, which the ground check then refuses.
 */
export function markGround(x: number, z: number): string[] {
    return [
        `kill @e[tag=${MARK_TAG}]`,
        `execute in minecraft:overworld run summon minecraft:armor_stand ${x} 200 ${z} {Tags:["${MARK_TAG}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b}`,
        `execute in minecraft:overworld positioned ${x + 0.5} 0 ${z + 0.5} positioned over motion_blocking_no_leaves run tp @e[tag=${MARK_TAG},limit=1] ~ ~ ~`
    ];
}

/**
 * On a server without the heightmap - before 1.19.4 - `spreadplayers` leaves the
 * marker on a tree's crown, and every place in a wood was given up as rough.
 * Each line takes it one block down while what is under it is leaves, a log or
 * air; sent together, they bring it down through the crown and the trunk to the
 * ground, and stop at anything else - ground, water - which is then judged.
 */
const SETTLE_DEPTH = 32;
export const SETTLE_MARK: readonly string[] = Array.from({ length: SETTLE_DEPTH }, () =>
    ["#minecraft:leaves", "#minecraft:logs", "minecraft:air"].map(
        (below) =>
            `execute as @e[tag=${MARK_TAG},limit=1] at @s if block ~ ~-1 ~ ${below} run tp @s ~ ~-1 ~`
    )
).flat();

/** Whether two points are in the same chunk. */
export function sameChunk(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
    return a.x >> 4 === b.x >> 4 && a.z >> 4 === b.z >> 4;
}

/** Whether the marker was moved onto the ground. */
export function groundWorked(output: string): boolean {
    return /teleported/i.test(output);
}

export const READ_MARK = `data get entity @e[tag=${MARK_TAG},limit=1] Pos`;
export const CLEAR_MARK = `kill @e[tag=${MARK_TAG}]`;

/** Whether the game managed to put the marker down. */
export function spreadWorked(output: string): boolean {
    return /spread 1 (entity|player)/i.test(output) && !/could not spread/i.test(output);
}

// ------------------------------------------------------------------ nobody's home

/**
 * Where each player online would respawn - their bed or anchor, which is where
 * they live. Written two ways over the game's life: `SpawnX`/`SpawnZ` with a
 * `SpawnDimension` up to 1.21.4, a `respawn` compound from 1.21.5. Both are
 * asked; whichever the server does not have answers with an error that reads
 * as nothing. The world is asked too: an anchor in the Nether is no home at the
 * same x and z in the Overworld, where every event is played.
 */
export const HOMES = [
    "execute as @a run data get entity @s SpawnX",
    "execute as @a run data get entity @s SpawnZ",
    "execute as @a run data get entity @s respawn.pos",
    "execute as @a run data get entity @s SpawnDimension",
    "execute as @a run data get entity @s respawn.dimension"
] as const;

/**
 * The homes out of the answers to `HOMES`, in the same order. A home whose
 * world is not said is in the Overworld: before 1.16 there was nowhere else to
 * sleep, and from 1.21.5 the game leaves the Overworld out as the default.
 */
export function readHomes(
    spawnX: string,
    spawnZ: string,
    respawn: string,
    spawnDimension = "",
    respawnDimension = ""
): { x: number; z: number }[] {
    const each = (output: string) => {
        const found = new Map<string, number>();
        const pattern = /(\.?[A-Za-z0-9_]{1,16}) has the following entity data: (-?\d+)(?![\d.])/g;
        for (const match of stripFormatting(output).matchAll(pattern)) {
            found.set(match[1] as string, Number(match[2]));
        }
        return found;
    };
    const overworld = (worlds: ReadonlyMap<string, string>, name: string) =>
        (worlds.get(name) ?? "minecraft:overworld") === "minecraft:overworld";
    const legacyWorlds = readDimensions(spawnDimension);
    const modernWorlds = readDimensions(respawnDimension);
    const xs = each(spawnX);
    const zs = each(spawnZ);
    const homes: { x: number; z: number }[] = [];
    for (const [name, x] of xs) {
        const z = zs.get(name);
        if (z !== undefined && overworld(legacyWorlds, name)) homes.push({ x, z });
    }
    const modern =
        /(\.?[A-Za-z0-9_]{1,16}) has the following entity data: \[I;\s*(-?\d+),\s*-?\d+,\s*(-?\d+)\]/g;
    for (const match of stripFormatting(respawn).matchAll(modern)) {
        if (overworld(modernWorlds, match[1] as string))
            homes.push({ x: Number(match[2]), z: Number(match[3]) });
    }
    return homes;
}

/** How far from anybody's bed an event may put anything. */
export const HOME_CLEARANCE = 48;

/** How near a bed an event that changes nothing and brings nothing hostile may
 *  be, once nothing further out would do: an island with its home on it. */
export const NEAR_CLEARANCE = 8;

/**
 * How far out, and how far from a home, try number `tries` looks. Everything
 * starts at its own distance and the full clearance; one that changes nothing
 * and brings nothing hostile (`nearHome`) comes in after `after` tries -
 * halving the distance each time, down to just clear of the players - and may
 * then come as near a home as `NEAR_CLEARANCE`: an island with its home on it.
 */
export function searchReach(
    distance: number,
    radius: number,
    tries: number,
    nearHome: boolean,
    clearance: number,
    after = 4
): { reach: number; clearance: number } {
    if (!nearHome || tries < after) return { reach: distance, clearance };
    return {
        reach: Math.max(radius + 6, Math.round(distance / 2 ** (tries - after + 1))),
        clearance: NEAR_CLEARANCE + radius
    };
}

/** Open water at a column: the sea, a lake - nothing anybody built, and empty
 *  space for what is built in the air over it. */
export function waterUnder(point: { x: number; y: number; z: number }): string {
    return `execute in minecraft:overworld if block ${point.x} ${point.y - 1} ${point.z} minecraft:water`;
}

/**
 * How far the marker can come down from the column it was dropped on: before
 * 1.19.4 `spreadplayers` puts it on the nearest ground it likes, a block or two
 * off. A 1.16.5 meteor landed 47 blocks from a bed its column had cleared by 48.
 */
export const MARK_DRIFT = 2;

/**
 * A point about `distance` from the center that is clear of every home. The
 * bearing is tried all the way round first, then further out, so somebody
 * standing at their own door still gets an event - just past their land.
 */
export function clearPoint(
    center: { x: number; z: number },
    distance: number,
    homes: readonly { x: number; z: number }[],
    random: () => number,
    clearance = HOME_CLEARANCE,
    /** A way to keep to, in radians from north towards east, give or take a
     *  sixth of a turn: so the places of an event of many are not all one spot. */
    bearing: number | null = null
): { x: number; z: number } | null {
    // Kept further off by what the marker can drift, so where it lands is clear too.
    const clear = (point: { x: number; z: number }) =>
        homes.every(
            (home) => Math.hypot(point.x - home.x, point.z - home.z) >= clearance + MARK_DRIFT
        );
    for (let ring = 0; ring < 4; ring += 1) {
        const reach = distance + ring * (clearance / 2);
        for (let turn = 0; turn < 12; turn += 1) {
            const point = pointAway(center, reach, random, bearing);
            if (clear(point)) return point;
        }
    }
    return null;
}

/**
 * Ground nobody built: what the world generates on its surface, the plants that
 * grow on it, and snow. Anything else under an event - planks, bricks, glass, a
 * farm, a path, a roof - is somebody's, and the place is given up. So are leaves:
 * the top of a tree is not somewhere anybody walks to, which is why the flowers
 * are the small ones and the tall ones by name - `#minecraft:flowers` counts
 * cherry and flowering azalea leaves among them.
 *
 * Three lists, because the names moved: `short_grass` was `grass` before 1.20.3,
 * the dry grasses and leaf litter only grow from 1.21.5, and a name a server does
 * not know fails the whole check. The newest list is tried first, and the next
 * older one wherever a name is refused.
 */
const GROUND_LEGACY = [
    "grass_block",
    "dirt",
    "coarse_dirt",
    "podzol",
    "mycelium",
    "sand",
    "red_sand",
    "gravel",
    "stone",
    "granite",
    "diorite",
    "andesite",
    "snow",
    "snow_block",
    "clay",
    "sandstone",
    "red_sandstone",
    "terracotta",
    "white_terracotta",
    "orange_terracotta",
    "yellow_terracotta",
    "brown_terracotta",
    "red_terracotta",
    "light_gray_terracotta",
    "ice",
    "packed_ice",
    "blue_ice",
    "tall_grass",
    "fern",
    "large_fern",
    "dead_bush",
    "cactus",
    "sugar_cane",
    "pumpkin",
    "melon",
    "brown_mushroom",
    "red_mushroom",
    "grass",
    "dandelion",
    "poppy"
];
const GROUND_MODERN = [
    ...GROUND_LEGACY.filter((id) => !["grass", "dandelion", "poppy"].includes(id)),
    "short_grass",
    "#minecraft:small_flowers",
    "sunflower",
    "lilac",
    "rose_bush",
    "peony",
    "pink_petals",
    "sweet_berry_bush",
    "bamboo",
    "azalea",
    "flowering_azalea",
    "moss_block",
    "moss_carpet",
    "rooted_dirt",
    "mud",
    "mangrove_roots",
    "muddy_mangrove_roots",
    "pointed_dripstone",
    "calcite",
    "tuff",
    "powder_snow"
];
const GROUND_LATEST = [
    ...GROUND_MODERN,
    "leaf_litter",
    "short_dry_grass",
    "tall_dry_grass",
    "bush",
    "firefly_bush",
    "wildflowers",
    "cactus_flower"
];

/** The lists of ground names, newest first: the order they are tried in. */
export const GROUND_NAMES = ["latest", "modern", "legacy"] as const;

export type GroundNames = (typeof GROUND_NAMES)[number];

const GROUND: Readonly<Record<GroundNames, readonly string[]>> = {
    latest: GROUND_LATEST,
    modern: GROUND_MODERN,
    legacy: GROUND_LEGACY
};

/**
 * Whether what is under a point is somebody's rather than the world's, asked in
 * as many commands as it takes to keep each one short enough to arrive: it is
 * somebody's when every one of them answers `Test passed`, and the world's as
 * soon as one answers `Test failed`. Room is left for the `minecraft:` a
 * Bukkit-family server has put in front (`namespaced`).
 */
export function builtUnder(
    point: { x: number; y: number; z: number },
    names: GroundNames
): string[] {
    const at = `${point.x} ${point.y - 1} ${point.z}`;
    const prefix = "execute in minecraft:overworld";
    const lines: string[] = [];
    let line = prefix;
    for (const id of GROUND[names]) {
        const check = ` unless block ${at} ${id.startsWith("#") ? id : `minecraft:${id}`}`;
        if (line !== prefix && commandBytes(line + check) > COMMAND_BYTES_MAX - NAMESPACE.length) {
            lines.push(line);
            line = prefix;
        }
        line += check;
    }
    lines.push(line);
    return lines;
}

// ------------------------------------------------------------------ judging a place at once

/** The markers a place's columns are judged by, all at once (`siteSamples`). */
export const SAMPLE_TAG = "pe_samp";

const MARKER_DATA = "Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b";

/**
 * A marker summoned straight onto the ground at a column, under any trees -
 * the heightmap `markGround` uses, from 1.19.4 - in one line. An older server
 * refuses it, and nothing is summoned.
 */
export function summonOnGround(x: number, z: number, tag: string | null = null): string {
    const tags = [MARK_TAG, ...(tag ? [tag] : [])].map((one) => `"${one}"`).join(",");
    return `execute in minecraft:overworld positioned ${x + 0.5} 0 ${z + 0.5} positioned over motion_blocking_no_leaves run summon minecraft:armor_stand ~ ~ ~ {Tags:[${tags}],${MARKER_DATA}}`;
}

/**
 * A marker on top of whatever is highest in a column - a roof, a tree's crown,
 * the sea - by the heightmap that counts all of them (`motion_blocking`), for
 * what is built in the air over it.
 */
export function summonOnTop(x: number, z: number, tag: string): string {
    return `execute in minecraft:overworld positioned ${x + 0.5} 0 ${z + 0.5} positioned over motion_blocking run summon minecraft:armor_stand ~ ~ ~ {Tags:["${MARK_TAG}","${tag}"],${MARKER_DATA}}`;
}

/** How far apart the columns of a footprint are read for its top. */
export const TOP_STEP = 4;

/** Every column of a square footprint, `TOP_STEP` apart, its edges included. */
export function footprintColumns(
    center: { x: number; z: number },
    radius: number
): { x: number; z: number }[] {
    const offsets: number[] = [];
    for (let at = -radius; at < radius; at += TOP_STEP) offsets.push(at);
    offsets.push(radius);
    return offsets.flatMap((dx) => offsets.map((dz) => ({ x: center.x + dx, z: center.z + dz })));
}

/** A marker on top of every column of a footprint, the old ones taken away first. */
export function topLines(columns: readonly { x: number; z: number }[]): string[] {
    return [
        `kill @e[tag=${SAMPLE_TAG}]`,
        ...columns.map((one) => summonOnTop(one.x, one.z, SAMPLE_TAG))
    ];
}

/** The highest of the tops read, or null when none was. */
export function highestTop(points: readonly { y: number }[]): number | null {
    return points.length === 0 ? null : Math.max(...points.map((one) => one.y));
}

/** Every column of a place with a marker on its ground, the old ones taken away first. */
export function sampleLines(samples: readonly { x: number; z: number }[]): string[] {
    return [
        `kill @e[tag=${SAMPLE_TAG}]`,
        ...samples.map((one) => summonOnGround(one.x, one.z, SAMPLE_TAG))
    ];
}

/** Where every one of them came down: `Armor Stand has the following entity data: [..]`. */
export const READ_SAMPLES = `execute as @e[tag=${SAMPLE_TAG}] run data get entity @s Pos`;

export const CLEAR_SAMPLES = `kill @e[tag=${SAMPLE_TAG}]`;

/**
 * The markers standing on something somebody built, as `builtUnder` asks of one
 * column, asked of all of them at once: each line answers the positions of the
 * markers none of its names matched, and a marker on a build is in every
 * line's answer.
 */
export function builtUnderSamples(names: GroundNames): string[] {
    const prefix = `execute as @e[tag=${SAMPLE_TAG}] at @s`;
    const suffix = " run data get entity @s Pos";
    const lines: string[] = [];
    let line = prefix;
    for (const id of GROUND[names]) {
        const check = ` unless block ~ ~-1 ~ ${id.startsWith("#") ? id : `minecraft:${id}`}`;
        if (
            line !== prefix &&
            commandBytes(line + check + suffix) > COMMAND_BYTES_MAX - NAMESPACE.length * 2
        ) {
            lines.push(line + suffix);
            line = prefix;
        }
        line += check;
    }
    lines.push(line + suffix);
    return lines;
}

/** The markers standing on a tree, and the ones on open water. */
export const SAMPLES_ON_TREES = ["#minecraft:leaves", "#minecraft:logs"].map(
    (tag) =>
        `execute as @e[tag=${SAMPLE_TAG}] at @s if block ~ ~-1 ~ ${tag} run data get entity @s Pos`
);
export const SAMPLES_ON_WATER = `execute as @e[tag=${SAMPLE_TAG}] at @s if block ~ ~-1 ~ minecraft:water run data get entity @s Pos`;

/** The columns out of a read of the markers, by where each was summoned. */
export function samplesIn(output: string): { x: number; y: number; z: number }[] {
    return readWhere(output).map((one) => ({
        x: Math.floor(one.x),
        y: Math.floor(one.y),
        z: Math.floor(one.z)
    }));
}

// ------------------------------------------------------------------ reachable on foot

/** The markers a walk to a place is judged by (`pathLines`). */
export const PATH_TAG = "pe_path";
/** How far apart they stand. */
export const PATH_STEP = 6;
/** The most open water a walk may cross: a river can be swum, a strait cannot. */
export const MAX_SWIM = 12;
/** How far above or below where the players are a place may be. */
export const MAX_CLIMB = 24;

/** A marker on the ground every `PATH_STEP` blocks from one point to another,
 *  both ends included - in chunks not loaded, none. */
export function pathLines(from: { x: number; z: number }, to: { x: number; z: number }): string[] {
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    const steps = Math.max(1, Math.ceil(length / PATH_STEP));
    const lines = [`kill @e[tag=${PATH_TAG}]`];
    for (let step = 0; step <= steps; step += 1) {
        const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
        const z = Math.round(from.z + ((to.z - from.z) * step) / steps);
        lines.push(summonOnGround(x, z, PATH_TAG));
    }
    return lines;
}

export const READ_PATH = `execute as @e[tag=${PATH_TAG}] run data get entity @s Pos`;
export const READ_PATH_WET = `execute as @e[tag=${PATH_TAG}] at @s if block ~ ~-1 ~ minecraft:water run data get entity @s Pos`;
export const CLEAR_PATH = `kill @e[tag=${PATH_TAG}]`;

/**
 * Whether a place can be walked to from where the players are: along the
 * straight line there, no stretch of open water longer than `MAX_SWIM` - the
 * sea round an island - and the place no more than `MAX_CLIMB` above or below
 * where the walk starts. Columns not loaded are not known, and not held against it.
 */
export function walkable(
    from: { x: number; z: number },
    path: readonly { x: number; y: number; z: number }[],
    wet: readonly { x: number; z: number }[],
    to: { y: number }
): boolean {
    const key = (one: { x: number; z: number }) => `${Math.floor(one.x)},${Math.floor(one.z)}`;
    const water = new Set(wet.map(key));
    const along = [...path].sort(
        (a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z)
    );
    let run = 0;
    let longest = 0;
    let previous: { x: number; z: number } | null = null;
    for (const one of along) {
        if (water.has(key(one))) {
            run += previous ? Math.hypot(one.x - previous.x, one.z - previous.z) : PATH_STEP;
            longest = Math.max(longest, run);
        } else run = 0;
        previous = one;
    }
    if (longest > MAX_SWIM) return false;
    const start = along[0];
    return !start || Math.abs(to.y - start.y) <= MAX_CLIMB;
}

/** Whether the game said nothing: RCON's reply with its color reset and blank
 *  space taken away. */
export function silent(output: string): boolean {
    // eslint-disable-next-line no-control-regex
    return (
        stripFormatting(output)
            .replace(/\u001b?\[[0-9;]*m/g, "")
            .trim().length === 0
    );
}

/** Whether the game refused a block name it does not know, rather than answering. */
export function nameRefused(output: string): boolean {
    return /unknown block|<--\[HERE\]/i.test(output);
}

/** The columns a place is judged by: its center, and rings at its edge and halfway in. */
export function siteSamples(
    center: { x: number; z: number },
    radius: number
): { x: number; z: number }[] {
    const samples = [{ x: center.x, z: center.z }];
    const rings = radius >= 4 ? [radius, Math.round(radius / 2)] : [radius];
    for (const reach of rings) {
        for (let index = 0; index < 8; index += 1) {
            const angle = (index / 8) * Math.PI * 2;
            samples.push({
                x: Math.round(center.x + Math.cos(angle) * reach),
                z: Math.round(center.z + Math.sin(angle) * reach)
            });
        }
    }
    return samples;
}

/** How far above or below the center any of those may be and still be walked to. */
export const SITE_STEP = 4;

/**
 * How many of a place's columns may be rough - a tree's crown, a dip, a rise past
 * `SITE_STEP` - before the place is given up: a quarter, never the center. A
 * clearing in a forest or a gentle hill is still somewhere to walk to; a column
 * on somebody's build is never allowed, however few.
 */
export function roughAllowed(samples: number): number {
    return Math.floor(samples / 4);
}

/** Whether what is under a point is part of a tree - its leaves, or the top of
 *  its trunk: `Test passed` from either when it is. */
export function treeUnder(point: { x: number; y: number; z: number }): string[] {
    const at = `${point.x} ${point.y - 1} ${point.z}`;
    return [
        `execute in minecraft:overworld if block ${at} #minecraft:leaves`,
        `execute in minecraft:overworld if block ${at} #minecraft:logs`
    ];
}

/** How far either side of a bearing `pointAway` may stray: a sixth of a turn. */
export const BEARING_SPREAD = Math.PI / 6;

/**
 * A point `distance` away from a center, whole blocks: at a random bearing, or
 * within `BEARING_SPREAD` of `bearing` (radians from north, towards east -
 * the way `headingTo` reads).
 */
export function pointAway(
    center: { x: number; z: number },
    distance: number,
    random: () => number,
    bearing: number | null = null
): { x: number; z: number } {
    if (bearing !== null) {
        const reach = distance * (0.7 + random() * 0.3);
        const angle = bearing + (random() * 2 - 1) * BEARING_SPREAD;
        return {
            x: Math.round(center.x + Math.sin(angle) * reach),
            z: Math.round(center.z - Math.cos(angle) * reach)
        };
    }
    const angle = random() * Math.PI * 2;
    const reach = distance * (0.7 + random() * 0.3);
    return {
        x: Math.round(center.x + Math.cos(angle) * reach),
        z: Math.round(center.z + Math.sin(angle) * reach)
    };
}

// ------------------------------------------------------------------ supply drop

export const LOOT: Readonly<Record<EventOptions<"supply-drop">["loot"], string>> = {
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

/**
 * The same two, the way 1.13 can ask them: `execute if data` came in 1.14, so
 * there the chest is matched by the loot table it still holds - one line per
 * table an event puts in a chest. Every newer version reads these too, and finds
 * nothing left to take once `removeChest` has.
 */
export function chestUnopenedByTable(point: { x: number; y: number; z: number }): string[] {
    const at = `${point.x} ${point.y} ${point.z}`;
    return Object.values(LOOT).map(
        (table) =>
            `execute in minecraft:overworld if block ${at} minecraft:chest{LootTable:"${table}"}`
    );
}

/** Both ways to take an unopened event chest away: every version, and 1.13. */
export function removeChestLines(point: { x: number; y: number; z: number }): string[] {
    const at = `${point.x} ${point.y} ${point.z}`;
    return [
        removeChest(point),
        ...chestUnopenedByTable(point).map(
            (line) => `${line} run setblock ${at} minecraft:air replace`
        )
    ];
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

/**
 * Night, and rain for as long as it lasts. Rain, not thunder: a thunderstorm's
 * lightning sets wooden roofs on fire and turns a villager into a witch, a pig
 * into a zombified piglin - in the chunks round every player, their homes
 * included - and a real server lost a villager and part of a house to the one
 * a blood moon brought on. The rain's length is seconds up to 1.19.3 and ticks
 * from 1.19.4, where `s` asks for seconds - which the older versions refuse.
 * Both are sent, the bare number first: an older server takes it as seconds and
 * refuses the second; a newer one takes it as ticks and the second puts it right.
 */
export function nightfall(seconds: number): string[] {
    const storm = Math.max(60, Math.round(seconds));
    return ["time set 13000", `weather rain ${storm}`, `weather rain ${storm}s`];
}

/**
 * The game rules a blood moon holds still while it lasts: the clock, so the
 * night neither runs out before the event does (a Minecraft night is about eight
 * minutes) nor is slept through in a bed, and the weather, so the storm stays.
 * Put back to whatever the server had when it ends. Each is listed under every
 * name it has had; the first one the server answers to is the one it uses.
 */
export const FROZEN_RULES = [
    ["doDaylightCycle", "advance_time"],
    ["doWeatherCycle", "advance_weather"]
] as const;

/**
 * The rules an event played on something built in the sky holds while it runs
 * (`catalog.keepsDay`): the clock stopped at midday, so what is built there -
 * glass above all - can be seen and nothing spawns on it in the dark; and no
 * phantoms, which a player who has not slept brings down on the arena. Put back
 * to exactly what they were when it ends. Their names before 1.21.11, then after.
 */
export const DAY_RULES = [
    ["doDaylightCycle", "advance_time"],
    ["doInsomnia", "spawn_phantoms"]
] as const;

/**
 * The rule that lets a mob change the world: trample a farm, break a door, blow
 * a hole, take a block. An event that brings mobs up beside the players - their
 * homes included - holds it off while it runs, so nothing it summons touches
 * anything built; what it was is written down and put back exactly. Its name
 * before 1.21.11, then after.
 */
export const GRIEF_RULES = ["mobGriefing", "mob_griefing"] as const;

/** Midday: the day held still at its brightest. */
export const MIDDAY = "time set 6000";

/** Midnight: as dark as it gets, so whatever spawns does and nothing burns. */
export const MIDNIGHT = "time set 18000";

/** The rule that turns the weather, under each name it has had. */
export const WEATHER_RULES = ["doWeatherCycle", "advance_weather"] as const;

/**
 * The rules an event holds for what it needs of the world (`catalog.worldNeeds`):
 * the clock for a time of day, and phantoms off with a day (a player who has
 * not slept brings them down on an arena); the weather cycle for a weather.
 * Each group is listed under every name it has had.
 */
export function worldRules(needs: WorldNeeds): (readonly string[])[] {
    return [
        ...(needs.time ? [DAY_RULES[0]] : []),
        ...(needs.time === "day" ? [DAY_RULES[1]] : []),
        ...(needs.weather ? [WEATHER_RULES] : [])
    ];
}

/**
 * The time and the weather set for an event of `seconds`. The weather's length
 * is sent as seconds and as ticks, like `nightfall`: an older server takes the
 * bare number as seconds and refuses the second line; a newer one reads it as
 * ticks and the second line puts it right.
 */
export function worldLines(needs: WorldNeeds, seconds: number): string[] {
    const lasting = Math.max(60, Math.round(seconds) + 60);
    return [
        ...(needs.time === "day" ? [MIDDAY] : needs.time === "night" ? [MIDNIGHT] : []),
        ...(needs.weather
            ? [`weather ${needs.weather} ${lasting}`, `weather ${needs.weather} ${lasting}s`]
            : [])
    ];
}

/** The time of day put back as it was before the event; the weather goes on
 *  turning from the rule being given back. */
export function worldBack(needs: WorldNeeds, timeBefore: number | null): string[] {
    return needs.time && timeBefore !== null ? [`time set ${timeBefore}`] : [];
}

/**
 * The hostile creatures that can reach something built in the sky: whatever
 * flies to it, and whatever spawns on a dark corner of it. There is no selector
 * for "hostile" without a datapack, so each is named - an older version that
 * lacks one refuses that line alone.
 */
const HOSTILES = [
    "phantom",
    "zombie",
    "zombie_villager",
    "husk",
    "drowned",
    "skeleton",
    "stray",
    "creeper",
    "spider",
    "cave_spider",
    "enderman",
    "witch",
    "slime",
    "pillager",
    "vex"
] as const;

/** How far above an arena a hostile is still taken out: a phantom circles there. */
export const HOSTILE_MARGIN = 16;

/**
 * Every hostile creature inside an event's own box - and the air above it - taken
 * out, one line each, and nothing outside it. A named mob is kept: naming one
 * (a name tag) makes it persistent, and a persistent one is never touched - nor
 * is anything tamed, since nothing on the list can be.
 */
export function hostilesOut(box: {
    readonly x1: number;
    readonly y1: number;
    readonly z1: number;
    readonly x2: number;
    readonly y2: number;
    readonly z2: number;
}): string[] {
    const x = Math.min(box.x1, box.x2);
    const y = Math.min(box.y1, box.y2);
    const z = Math.min(box.z1, box.z2);
    const dx = Math.abs(box.x2 - box.x1);
    const dy = Math.abs(box.y2 - box.y1) + HOSTILE_MARGIN;
    const dz = Math.abs(box.z2 - box.z1);
    return HOSTILES.map(
        (type) =>
            `execute in minecraft:overworld run kill @e[type=minecraft:${type},x=${x},y=${y},z=${z},dx=${dx},dy=${dy},dz=${dz},nbt=!{PersistenceRequired:1b}]`
    );
}

/**
 * The rule that shows operators what commands did, as `[Rcon: Set [pe_sum] for
 * Alice to 3]` in their chat. An event runs dozens of commands a second - the
 * clock, the scoreboard, a title for each player - and every one of them landed
 * in the chat of every operator playing, burying it. Held off while an event is
 * on and put back after, like the rules a blood moon holds; the answers Polaris
 * reads over RCON do not depend on it. Its name before 1.21.11, then after.
 */
export const FEEDBACK_RULES = ["sendCommandFeedback", "send_command_feedback"] as const;

/**
 * What the side panel shows beside a player instead of their bare score, from
 * 1.20.3: the score stays the number the panel sorts by, and reads as `text` -
 * a time held as `2.5 min`, a large count as `12K` (`figures`).
 */
export function scoreShownAs(name: string, objective: string, text: string): string {
    return `scoreboard players display numberformat ${name} ${objective} fixed ${asciiJson(JSON.stringify({ text }))}`;
}

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

/**
 * Dawn after a blood moon. A server that keeps its clock still - an operator's
 * permanent noon - gets back the exact time it had; one whose days turn gets the
 * sunrise.
 */
export function daybreak(
    rules: Readonly<Record<string, string>> = {},
    timeBefore: number | null = null
): string[] {
    const frozen = FROZEN_RULES[0].some((name) => rules[name] === "false") && timeBefore !== null;
    return [
        frozen ? `time set ${timeBefore}` : "time set 23500",
        "weather clear",
        `kill @e[tag=${MOB_TAG}]`
    ];
}

/**
 * The world's time of day, to put back: `The time is 6000`. From 26.1 there is
 * no `daytime` to ask for - the day is a timeline, `READ_DAY_TIMELINE`, which
 * answers `Timeline minecraft:day is at 6000 tick(s)` - so that is asked when
 * the first answers nothing readable.
 */
export const READ_DAYTIME = "time query daytime";
export const READ_DAY_TIMELINE = "time query minecraft:day";
export function readDaytime(output: string): number | null {
    const match = /time is (\d+)|is at (\d+) tick/i.exec(output);
    return match ? Number(match[1] ?? match[2]) : null;
}

/** `The difficulty is Peaceful` - where hostile mobs vanish as they appear. */
export const READ_DIFFICULTY = "difficulty";
export function isPeaceful(output: string): boolean {
    return /difficulty is peaceful/i.test(output);
}

/** Whoever is not playing in survival or adventure: creative mines and kills at
 *  will, and a spectator cannot be hurt. */
export const NOT_SURVIVAL =
    "execute as @a[gamemode=!survival,gamemode=!adventure] run data get entity @s Pos";

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
 *
 * They rise wherever players are - by their homes too - so none of them may
 * take anything that is not the event's: no zombie breaks a door down on Hard
 * or calls for help (a reinforcement is a zombie nobody tagged, which the end
 * would never take away), and nothing picks up what a player dropped.
 */
export function wave(options: EventOptions<"blood-moon">, number: number): string[] {
    const kinds = [...WAVE_MOBS, ...(options.creepers ? ["creeper"] : [])];
    const players = "@a[gamemode=survival,distance=0..]";
    const lines: string[] = [];
    for (let index = 0; index < WAVE_SIZE[options.intensity]; index += 1) {
        const kind = kinds[(number + index) % kinds.length] as string;
        lines.push(
            `execute in minecraft:overworld as ${players} at @s run summon minecraft:${kind} ~ ~ ~ {Tags:["${MOB_TAG}","${NEW_TAG}"],CanPickUpLoot:0b,CanBreakDoors:0b,${DROPS_NOTHING}}`
        );
    }
    lines.push(
        `execute in minecraft:overworld as ${players} at @s run spreadplayers ~ ~ 4 16 false @e[tag=${NEW_TAG},distance=..1]`,
        ...armLines(`tag=${NEW_TAG}`, kinds)
    );
    // The attribute lost its `zombie.` in 1.21.2; both are tried.
    for (const id of ["minecraft:spawn_reinforcements", "minecraft:zombie.spawn_reinforcements"]) {
        lines.push(
            `execute as @e[tag=${NEW_TAG},type=minecraft:zombie] run attribute @s ${id} base set 0`
        );
    }
    lines.push(`tag @e[tag=${NEW_TAG}] remove ${NEW_TAG}`);
    return lines;
}

// ------------------------------------------------------------------ arming what is summoned

/**
 * What each mob fights with when the game spawns it. `summon` with data - which
 * every event sends, for its tags - skips the game's own equipping, so a
 * skeleton came out of a blood moon without its bow and could not shoot at all.
 * Every summoned mob that needs a weapon is handed it here. A mob a version
 * does not have (the bogged before 1.21) makes its line fail and nothing else.
 */
export const MOB_WEAPONS: Readonly<Record<string, string>> = {
    skeleton: "minecraft:bow",
    stray: "minecraft:bow",
    bogged: "minecraft:bow",
    wither_skeleton: "minecraft:stone_sword",
    pillager: "minecraft:crossbow",
    vindicator: "minecraft:iron_axe",
    vex: "minecraft:iron_sword",
    zombified_piglin: "minecraft:golden_sword",
    piglin: "minecraft:golden_sword"
};

/**
 * Mob data that makes a summoned creature drop none of what it holds or wears,
 * in both spellings the game has used: two lists up to 1.21.4, one
 * `drop_chances` from 1.21.5, which reads nothing else. A key a version does
 * not know is ignored.
 */
export const DROPS_NOTHING =
    "HandDropChances:[0.0f,0.0f],ArmorDropChances:[0.0f,0.0f,0.0f,0.0f],drop_chances:{mainhand:0.0f,offhand:0.0f,head:0.0f,chest:0.0f,legs:0.0f,feet:0.0f}";

/** An item into a slot of every entity a selector finds: `item replace` from
 *  1.17, `replaceitem` before it. Whichever the server does not know fails and
 *  changes nothing. */
export function equipLines(selector: string, slot: string, item: string): string[] {
    return [
        `item replace entity ${selector} ${slot} with ${item}`,
        `replaceitem entity ${selector} ${slot} ${item}`
    ];
}

/** Every mob of `mobs` that a selector's arguments (`tag=pe_new`) find, armed
 *  with its weapon (`MOB_WEAPONS`). */
export function armLines(filter: string, mobs: readonly string[]): string[] {
    return [...new Set(mobs)].flatMap((mob) => {
        const weapon = MOB_WEAPONS[mob];
        return weapon
            ? equipLines(`@e[${filter},type=minecraft:${mob}]`, "weapon.mainhand", weapon)
            : [];
    });
}

/** Who died during the night - their deaths counted from when it fell. */
export const READ_DEATHS = `execute as @a run scoreboard players get @s ${DEATHS}`;
export function readDeaths(output: string): Map<string, number> {
    return readScores(output);
}

// ------------------------------------------------------------------ world boss

const BOSS_ENTITY: Readonly<Record<EventOptions<"world-boss">["boss"], string>> = {
    "wither-skeleton": "wither_skeleton",
    ravager: "ravager",
    vindicator: "vindicator",
    husk: "husk",
    evoker: "evoker",
    captain: "pillager",
    wither: "wither"
};

export function bossEntity(boss: EventOptions<"world-boss">["boss"]): string {
    return BOSS_ENTITY[boss];
}

/**
 * The name over the boss's head, written the way this version reads it.
 *
 * Before 1.21.5 the name is JSON inside a quoted SNBT string, and that string
 * knows two escapes only: a backslash and the quote. Every accent in the JSON
 * is a `\u` escape, so its backslash is doubled before the quote is escaped -
 * left single, "El Señor de la Guerra" was refused as an invalid escape and the
 * boss went without a name.
 */
export function bossNameCommand(name: string, modernText: boolean): string {
    const component = text(`&c&l${name}`);
    const quoted = component.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const value = modernText ? componentAsSnbt(name) : `'${quoted}'`;
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
export function bossDamageTick(reach = BOSS_FIGHT_REACH): string[] {
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
        `scoreboard objectives add ${KILLS} minecraft.killed:minecraft.${BOSS_ENTITY[boss]}`,
        ...SHOTS.flatMap((objective, index) => [
            `scoreboard objectives remove ${objective}`,
            `scoreboard objectives add ${objective} minecraft.used:minecraft.${SHOT_ITEMS[index]}`
        ])
    ];
}

/** Where the boss is, while it is loaded. */
export const BOSS_WHERE = `data get entity @e[tag=${BOSS_TAG},limit=1] Pos`;

/** The boss's health right now: `... has the following entity data: 312.5f`. */
export const BOSS_HEALTH = `data get entity @e[tag=${BOSS_TAG},limit=1] Health`;

export function readHealth(output: string): number | null {
    const found = /entity data: (-?[\d.]+)f?\b/.exec(stripFormatting(output));
    return found ? Number(found[1]) : null;
}

/** How far from the boss a player counts as fighting it. */
export const BOSS_FIGHT_REACH = 40;

/**
 * The melee damage each player near the boss has dealt since the last tick
 * (`damage_dealt`, tenths of a health point): at the boss while it stands, or at
 * the spot it was last seen once it is down.
 */
export function readRawNear(at: { x: number; y: number; z: number } | null): string {
    const from = at
        ? `execute in minecraft:overworld positioned ${at.x} ${at.y} ${at.z}`
        : `execute as @e[tag=${BOSS_TAG},limit=1] at @s`;
    return `${from} as @a[distance=..${BOSS_FIGHT_REACH}] run scoreboard players get @s ${RAW_DAMAGE}`;
}

/** Every shot since the last look summed into one count, ready to be read. */
export const SHOTS_SUMMED = SHOTS.slice(1).map(
    (objective) =>
        `execute as @a run scoreboard players operation @s ${SHOTS[0]} += @s ${objective}`
);

/** Who near the boss (or where it fell) has shot since the last look. */
export function readShootersNear(at: { x: number; y: number; z: number } | null): string {
    const from = at
        ? `execute in minecraft:overworld positioned ${at.x} ${at.y} ${at.z}`
        : `execute as @e[tag=${BOSS_TAG},limit=1] at @s`;
    return `${from} as @a[distance=..${BOSS_FIGHT_REACH},scores={${SHOTS[0]}=1..}] run scoreboard players get @s ${SHOTS[0]}`;
}

/** The shots counted from zero again. */
export const SHOTS_RESET = SHOTS.map((objective) => `scoreboard players set @a ${objective} 0`);

/**
 * The boss's lost health nobody's melee accounts for - arrows, a trident,
 * magic, a mod's weapon: the game's `damage_dealt` counts none of those - split
 * evenly among whoever near it shot since the last look; with nobody shooting,
 * among those who hit it; and with neither, among everybody near it. `lost` and
 * `melee` are in the same tenths of a health point.
 */
export function unseenShares(
    lost: number,
    melee: ReadonlyMap<string, number>,
    shooters: readonly string[] = []
): Map<string, number> {
    const near = [...melee.keys()];
    const meleeTotal = [...melee.values()].reduce((sum, one) => sum + Math.max(0, one), 0);
    const rest = Math.round(lost) - meleeTotal;
    const shares = new Map<string, number>();
    const hitters = near.filter((name) => (melee.get(name) ?? 0) > 0);
    const takers = shooters.length > 0 ? [...shooters] : hitters.length > 0 ? hitters : near;
    if (rest <= 0 || takers.length === 0) return shares;
    const each = Math.floor(rest / takers.length);
    let spare = rest - each * takers.length;
    for (const name of takers) {
        const share = each + (spare > 0 ? 1 : 0);
        if (spare > 0) spare -= 1;
        if (share > 0) shares.set(name, share);
    }
    return shares;
}

/** A share added to a player's damage near the boss. */
export function shareLine(name: string, share: number): string {
    return `scoreboard players add ${name} ${DAMAGE} ${share}`;
}

/**
 * The last tick's melee near where the boss fell, moved into the count: done at
 * the spot, since there is no boss left to count round - what the tick counting
 * round the boss would do, which would throw the killing blows away.
 */
export function bossDamageAt(at: { x: number; y: number; z: number }): string[] {
    return [
        `scoreboard players add @a ${RAW_DAMAGE} 0`,
        `scoreboard players add @a ${DAMAGE} 0`,
        `execute in minecraft:overworld positioned ${at.x} ${at.y} ${at.z} as @a[distance=..${BOSS_FIGHT_REACH}] run scoreboard players operation @s ${DAMAGE} += @s ${RAW_DAMAGE}`,
        `scoreboard players set @a ${RAW_DAMAGE} 0`,
        `execute as @a run scoreboard players operation @s ${SUM} = @s ${DAMAGE}`,
        `execute as @a run scoreboard players operation @s ${SUM} /= #w10 ${CONST}`,
        `execute as @a[scores={${SUM}=1..}] run scoreboard players operation @s ${SCORE} = @s ${SUM}`
    ];
}

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
/** And then gone at once, down there where anything it drops is lost: the void
 *  takes a boss with hundreds of health a while, and a chunk let go of before
 *  then kept it, falling, for the next time it loaded. */
export const BOSS_GONE = `kill @e[tag=${BOSS_TAG}]`;

// ------------------------------------------------------------------ explorer and the hill

/** Who has reached a column: a box twelve blocks wide from bedrock to the sky. */
export function arrived(x: number, z: number): string {
    return `execute in minecraft:overworld as @a[x=${x - 6},y=-64,z=${z - 6},dx=12,dy=384,dz=12] run data get entity @s Pos`;
}

/** How many points the circle's edge is drawn with. */
const RING_POINTS = 24;

/**
 * The circle drawn where it is - its edge in flame at the height of the ground,
 * and a tall column of light in the middle that shows from far off - and
 * everybody inside it given the time.
 */
export function hillTick(
    point: { x: number; y: number; z: number },
    radius: number,
    seconds: number,
    /** Only players carrying this tag score: those an event brought to it. */
    tag?: string
): string[] {
    const cx = point.x + 0.5;
    const cz = point.z + 0.5;
    const edge = Array.from({ length: RING_POINTS }, (_, index) => {
        const angle = (index / RING_POINTS) * Math.PI * 2;
        const x = (cx + Math.cos(angle) * radius).toFixed(2);
        const z = (cz + Math.sin(angle) * radius).toFixed(2);
        return `execute in minecraft:overworld run particle minecraft:flame ${x} ${point.y + 0.3} ${z} 0 0.3 0 0 3 force`;
    });
    return [
        ...edge,
        `execute in minecraft:overworld run particle minecraft:end_rod ${cx} ${point.y + 16} ${cz} 0 16 0 0.01 120 force`,
        `execute in minecraft:overworld positioned ${cx} ${point.y} ${cz} as @a[distance=..${radius},gamemode=!spectator${tag ? `,tag=${tag}` : ""}] run scoreboard players add @s ${SCORE} ${seconds}`
    ];
}

/** Whether somebody stands inside the circle, measured as `hillTick` scores it. */
export function inHill(
    where: { x: number; y: number; z: number },
    point: { x: number; y: number; z: number },
    radius: number
): boolean {
    return (
        Math.hypot(where.x - (point.x + 0.5), where.y - point.y, where.z - (point.z + 0.5)) <=
        radius
    );
}

/** The eight ways a player can be told to go. North is -Z in this game. */
export const HEADINGS = [
    "north",
    "north-east",
    "east",
    "south-east",
    "south",
    "south-west",
    "west",
    "north-west"
] as const;

export type Heading = (typeof HEADINGS)[number];

/** Which way a point is from somebody, to the nearest eighth. */
export function headingTo(from: { x: number; z: number }, to: { x: number; z: number }): Heading {
    const degrees = (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI;
    return HEADINGS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8] as Heading;
}

/** An arrow for each eighth of a turn from the way somebody looks: ahead, then
 *  round to the right. */
const ARROWS = [0x2191, 0x2197, 0x2192, 0x2198, 0x2193, 0x2199, 0x2190, 0x2196].map((code) =>
    String.fromCharCode(code)
);

/**
 * The arrow pointing at a point from somebody at `from` looking along `yaw`
 * (the game's own: 0 south, 90 west, turning right as it grows).
 */
export function arrowTo(
    from: { x: number; z: number },
    yaw: number,
    to: { x: number; z: number }
): string {
    const toward = (Math.atan2(-(to.x - from.x), to.z - from.z) * 180) / Math.PI;
    const turn = (((toward - yaw) % 360) + 360) % 360;
    return ARROWS[Math.round(turn / 45) % 8] as string;
}

/** One line in one player's action bar. */
export function actionbarFor(name: string, line: string): string {
    return `title ${name} actionbar ${text(line)}`;
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

/**
 * Whether a `give` or an `xp add` reached somebody: the game's own word that it
 * did - `Gave 2 [Diamond] to Ana`, `Gave 5 experience levels to Ana` - in every
 * version from 1.13. Anything else did not arrive. Looking for the words of a
 * refusal instead read a player called ErrorBoy's prize as refused and gave it
 * again, and read `Can't give more than 6400 of ...` as given.
 */
export function gaveIt(output: string): boolean {
    return /^\s*Gave \d+ /m.test(stripFormatting(output));
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
// ------------------------------------------------------------------ joining with a click

/**
 * What a player's buttons set: `/trigger` is the one command every player may
 * run without being an operator, so a click in the chat can answer for them.
 * 1 is join, 2 is leave; 3 and 4 a builder's [Done] and [Undo]. Read and set
 * back to 0 each tick.
 */
export const JOIN_TRIGGER = "pe_join";
export const JOIN_VALUE = 1;
export const LEAVE_VALUE = 2;
export const DONE_VALUE = 3;
export const UNDO_VALUE = 4;

/** The side panel through the countdown: who has joined so far. */
export const JOIN_LIST = "pe_joined";

/**
 * The side panel listing who has joined, rewritten each tick: the objective made
 * (again, harmlessly, once it exists), shown, emptied and filled. Numbers are
 * hidden where the game can (1.20.3 on); an older one shows a 1 beside each name.
 */
export function joinListLines(title: string, names: readonly string[]): string[] {
    return [
        `scoreboard objectives add ${JOIN_LIST} dummy ${text(title)}`,
        // Made once and then refused as already there: the title - its count of
        // who joined - is written again each time, or it stays at "(0 joined)".
        `scoreboard objectives modify ${JOIN_LIST} displayname ${text(title)}`,
        `scoreboard objectives modify ${JOIN_LIST} numberformat blank`,
        `scoreboard objectives setdisplay sidebar ${JOIN_LIST}`,
        `scoreboard players reset * ${JOIN_LIST}`,
        ...names.map((name) => `scoreboard players set ${name} ${JOIN_LIST} 1`)
    ];
}

/** The list taken down when the event itself starts. */
export const JOIN_LIST_OFF = `scoreboard objectives remove ${JOIN_LIST}`;

/** The objective made, and everybody allowed to use it - again every tick, since
 *  the game takes the permission away each time it is used and a player who
 *  joins the server later has none yet. */
export function joinTriggerLines(): string[] {
    return [
        `scoreboard objectives add ${JOIN_TRIGGER} trigger`,
        `scoreboard players enable @a ${JOIN_TRIGGER}`
    ];
}

/** Whoever pressed a button since the last look: `Alice has 1 [pe_join]`. */
export const READ_JOIN_TRIGGER = `execute as @a[scores={${JOIN_TRIGGER}=1..}] run scoreboard players get @s ${JOIN_TRIGGER}`;

/** The buttons pressed are taken back, ready for the next press. */
export const RESET_JOIN_TRIGGER = `scoreboard players set @a[scores={${JOIN_TRIGGER}=1..}] ${JOIN_TRIGGER} 0`;

/**
 * The line that invites everybody, with a [Join] and a [Leave] button. The click
 * is written in both spellings the game has used - `clickEvent` with `value`
 * before 1.21.5, `click_event` with `command` from it - and each version reads
 * its own and ignores the other.
 */
export function joinButtons(
    lead: string,
    join: { label: string; hover: string },
    leave: { label: string; hover: string }
): string {
    return buttonsLine("@a", lead, [
        { ...join, color: "green", value: JOIN_VALUE },
        { ...leave, color: "gray", value: LEAVE_VALUE }
    ]);
}

/** A line to `target` - everybody, or one player - that ends in buttons, each
 *  setting the trigger to its value when clicked. */
export function buttonsLine(
    target: string,
    lead: string,
    buttons: readonly { label: string; hover: string; color: string; value: number }[]
): string {
    const button = (one: (typeof buttons)[number]) => {
        const command = `/trigger ${JOIN_TRIGGER} set ${one.value}`;
        return {
            text: one.label,
            color: one.color,
            bold: true,
            underlined: true,
            clickEvent: { action: "run_command", value: command },
            click_event: { action: "run_command", command },
            hoverEvent: { action: "show_text", contents: one.hover },
            hover_event: { action: "show_text", value: one.hover }
        };
    };
    const intro = JSON.parse(text(lead)) as unknown;
    const parts: unknown[] = ["", ...(Array.isArray(intro) ? intro : [intro])];
    for (const one of buttons) parts.push(" ", button(one));
    return `tellraw ${target} ${asciiJson(JSON.stringify(parts))}`;
}

const PRESSED: Readonly<Record<number, string>> = {
    [JOIN_VALUE]: "join",
    [LEAVE_VALUE]: "leave",
    [DONE_VALUE]: "done",
    [UNDO_VALUE]: "undo"
};

/** A chat line in the server log's own shape, for a button pressed: whatever
 *  reads the chat for `join`, `leave`, `done` or `undo` reads a press the same way. */
export function pressedLine(name: string, value: number): string | null {
    const word = PRESSED[value];
    return word ? `[00:00:00] [Server thread/INFO]: <${name}> ${word}` : null;
}

export function cleanup(
    preset: EventPreset,
    place: { x: number; y: number; z: number } | null,
    target: { x: number; z: number } | null = null,
    /** Game rules the event changed, and what they were before. */
    rules: Readonly<Record<string, string>> = {},
    /** The time of day before a blood moon, for a server whose clock stands still. */
    timeBefore: number | null = null
): string[] {
    const lines = [
        ...Object.entries(rules)
            .filter(
                ([name, value]) =>
                    /^[A-Za-z:_]+$/.test(name) && (value === "true" || value === "false")
            )
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
        ...SHOTS.map((objective) => `scoreboard objectives remove ${objective}`),
        `scoreboard objectives remove ${JOIN_TRIGGER}`,
        `scoreboard objectives remove ${JOIN_LIST}`,
        ...(preset.kind === "king-of-the-hill" ? ["scoreboard objectives remove pe_khp"] : []),
        CLEAR_MARK
    ];
    for (const one of components(preset))
        lines.push(`scoreboard objectives remove ${one.objective}`);
    if (preset.kind === "world-boss") lines.push(BOSS_BANISH, BOSS_GONE);
    if (preset.kind === "blood-moon") lines.push(...daybreak(rules, timeBefore));
    else lines.push(...worldBack(worldNeeds(preset), timeBefore));
    if (preset.kind === "happy-hour")
        lines.push(...happyEffectsClear(preset.options as EventOptions<"happy-hour">));
    if (preset.kind === "supply-drop" && place) lines.push(...removeChestLines(place));
    // Its teams and counts; the arena and the players are `closeArena`'s.
    if (preset.kind === "team-duel") lines.push(...duelTeardown());
    lines.push(...release(preset.kind === "explorer" ? null : place, target));
    return lines;
}
