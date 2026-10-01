/**
 * Meteor shower: a few small piles of ore that come down over the event on
 * open ground, for players to race to and mine.
 *
 * Pure, like the rest of the commands. Nothing of anybody's is touched:
 *
 * - An ore block goes only where the block was air a moment before
 *   (`airTest`), and is put there with `setblock ... keep`, which the game
 *   itself refuses anywhere that is not air. Only a block then found to be
 *   exactly that ore (`isOurs`) is remembered as the event's.
 * - At the end a remembered block is taken away only while it is still
 *   exactly that ore (`removeIfOurs`); one that was mined - or mined and put
 *   back by a player, which is theirs now - is forgotten as soon as it is seen
 *   gone, and never touched again.
 *
 * What is scored is the game's own count of those ores mined (`minecraft.mined`)
 * - it credits the player whose pickaxe broke the block, which reading which
 * blocks turned to air could only guess at - counted only near a meteor, and
 * minus any of the same ores placed near one, so an ore block cannot be put
 * down and mined again for points.
 */

import { SCORE } from "../commands";
import { meteorGap, type EventOptions } from "../catalog";

export type MeteorOres = EventOptions<"meteor-shower">["ores"];

type Point = { readonly x: number; readonly y: number; readonly z: number };

/** One ore block of a meteor. */
export interface MeteorBlock extends Point {
    readonly block: string;
}

export interface Meteor extends Point {
    readonly blocks: readonly MeteorBlock[];
}

/** How much ground a meteor is judged by round where it lands. */
export const RADIUS = 3;
/** Mining within this of a meteor counts. */
export const REACH = 10;
/** An ore placed within this of a meteor is taken off: far enough that no
 *  block that could be mined from inside `REACH` was placed from outside it. */
export const PLACE_REACH = 20;
/** Within this of a meteor a player is close enough to have mined some of it. */
export const NEAR = 12;

/** Each mix, and how often each of its ores comes up. */
export const ORE_MIX: Readonly<Record<MeteorOres, readonly (readonly [string, number])[]>> = {
    common: [
        ["coal_ore", 3],
        ["iron_ore", 3],
        ["copper_ore", 2],
        ["gold_ore", 1],
        ["redstone_ore", 1],
        ["lapis_ore", 1]
    ],
    precious: [
        ["gold_ore", 3],
        ["lapis_ore", 2],
        ["diamond_ore", 2],
        ["emerald_ore", 1]
    ],
    diamond: [["diamond_ore", 1]],
    debris: [["ancient_debris", 1]]
};

/** Where the blocks of a meteor go, from where it lands: a low pile, the
 *  first ones on the ground and the rest heaped on them. */
const SHAPE: readonly (readonly [number, number, number])[] = [
    [0, 0, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, 1, 0],
    [1, 0, 1],
    [-1, 0, -1],
    [1, 0, -1],
    [-1, 0, 1],
    [1, 1, 0],
    [0, 1, 1]
];

/** An ore the event may name in a command - what a stored run holds is read back. */
const BLOCK_ID = /^minecraft:[a-z_]+$/;

/** How many meteors should be down `elapsedMs` into an event of `totalMs`:
 *  the first at once, then one every `meteorGap`. */
export function dueMeteors(elapsedMs: number, totalMs: number, count: number): number {
    const gap = meteorGap(totalMs, count);
    return Math.min(count, Math.floor(Math.max(0, elapsedMs) / gap) + 1);
}

/** `Test passed` while every block of a meteor is still its ore: one question
 *  for all of them, asked before any is asked about alone. */
export function allOurs(meteor: Meteor): string | null {
    const blocks = meteor.blocks.filter((block) => BLOCK_ID.test(block.block));
    if (blocks.length === 0) return null;
    return `execute in minecraft:overworld ${blocks.map((block) => `if block ${at(block)} ${block.block}`).join(" ")}`;
}

/** The cells of a meteor of `size` blocks landing on `point`, each with its ore. */
export function meteorCells(
    point: Point,
    size: number,
    ores: MeteorOres,
    random: () => number
): MeteorBlock[] {
    const mix = ORE_MIX[ores];
    const total = mix.reduce((sum, [, weight]) => sum + weight, 0);
    return SHAPE.slice(0, Math.max(1, Math.min(SHAPE.length, size))).map(([dx, dy, dz]) => {
        let roll = random() * total;
        let block = mix[mix.length - 1]![0];
        for (const [id, weight] of mix) {
            roll -= weight;
            if (roll < 0) {
                block = id;
                break;
            }
        }
        return { x: point.x + dx, y: point.y + dy, z: point.z + dz, block: `minecraft:${block}` };
    });
}

const at = (point: Point) => `${point.x} ${point.y} ${point.z}`;

/** `Test passed` only where the block is air now. */
export function airTest(point: Point): string {
    return `execute in minecraft:overworld if block ${at(point)} minecraft:air`;
}

/** An ore block into air, and nowhere else: `keep` leaves any other block be. */
export function placeBlock(block: MeteorBlock): string {
    return `execute in minecraft:overworld run setblock ${at(block)} ${block.block} keep`;
}

/** `Test passed` while the block is still exactly the meteor's ore. */
export function isOurs(block: MeteorBlock): string {
    return `execute in minecraft:overworld if block ${at(block)} ${block.block}`;
}

/** The block taken away only while it is still exactly the meteor's ore. */
export function removeIfOurs(block: MeteorBlock): string {
    return `execute in minecraft:overworld if block ${at(block)} ${block.block} run setblock ${at(block)} minecraft:air`;
}

/** `Test passed` when somebody is close enough to have mined some of it. */
export function playerNear(meteor: Point): string {
    return `execute in minecraft:overworld positioned ${meteor.x + 0.5} ${meteor.y} ${meteor.z + 0.5} if entity @a[distance=..${NEAR}]`;
}

/** It coming down: a trail of fire from the sky, smoke and a blast where it
 *  lands - all of it particles and sound, nothing that burns or breaks. */
export function landingEffects(point: Point): string[] {
    const x = point.x + 0.5;
    const z = point.z + 0.5;
    return [
        `execute in minecraft:overworld run particle minecraft:flame ${x} ${point.y + 30} ${z} 0.4 14 0.4 0.02 400 force`,
        `execute in minecraft:overworld run particle minecraft:large_smoke ${x} ${point.y + 1} ${z} 1.5 1 1.5 0.05 120 force`,
        `execute in minecraft:overworld run particle minecraft:explosion_emitter ${x} ${point.y + 1} ${z} 0 0 0 0 1 force`,
        "execute as @a at @s run playsound minecraft:entity.generic.explode master @s ~ ~ ~ 0.8 0.6"
    ];
}

const minedObjective = (index: number) => `pe_mo${index}`;
const usedObjective = (index: number) => `pe_mu${index}`;
const RAW = "pe_mraw";
const USED = "pe_mused";
export const TOTAL = "pe_mtot";

/** The counters: each ore of the mix mined, and placed, and the running total. */
export function meteorSetup(ores: MeteorOres): string[] {
    const lines: string[] = [];
    ORE_MIX[ores].forEach(([id], index) => {
        lines.push(
            `scoreboard objectives remove ${minedObjective(index)}`,
            `scoreboard objectives add ${minedObjective(index)} minecraft.mined:minecraft.${id}`,
            `scoreboard objectives remove ${usedObjective(index)}`,
            `scoreboard objectives add ${usedObjective(index)} minecraft.used:minecraft.${id}`
        );
    });
    lines.push(
        `scoreboard objectives remove ${RAW}`,
        `scoreboard objectives add ${RAW} dummy`,
        `scoreboard objectives remove ${USED}`,
        `scoreboard objectives add ${USED} dummy`,
        `scoreboard objectives remove ${TOTAL}`,
        `scoreboard objectives add ${TOTAL} dummy`
    );
    return lines;
}

/**
 * The ore mined near a meteor since the last tick added to each player's total,
 * and the ore placed near one taken off it; anything done anywhere else is let
 * go. A player near two meteors is counted once: what they did is emptied as
 * soon as it is added.
 */
export function meteorTick(meteors: readonly Point[], ores: MeteorOres): string[] {
    const indexes = ORE_MIX[ores].map((_, index) => index);
    const near = (meteor: Point, reach: number) =>
        `execute in minecraft:overworld positioned ${meteor.x + 0.5} ${meteor.y} ${meteor.z + 0.5} as @a[distance=..${reach}] run scoreboard players`;
    const lines: string[] = [];
    for (const index of indexes) {
        lines.push(
            `scoreboard players add @a ${minedObjective(index)} 0`,
            `scoreboard players add @a ${usedObjective(index)} 0`
        );
    }
    lines.push(
        `scoreboard players set @a ${RAW} 0`,
        `scoreboard players set @a ${USED} 0`,
        `scoreboard players add @a ${TOTAL} 0`
    );
    for (const index of indexes) {
        lines.push(
            `execute as @a run scoreboard players operation @s ${RAW} += @s ${minedObjective(index)}`,
            `execute as @a run scoreboard players operation @s ${USED} += @s ${usedObjective(index)}`,
            `scoreboard players set @a ${minedObjective(index)} 0`,
            `scoreboard players set @a ${usedObjective(index)} 0`
        );
    }
    for (const meteor of meteors) {
        lines.push(
            `${near(meteor, REACH)} operation @s ${TOTAL} += @s ${RAW}`,
            `${near(meteor, REACH)} set @s ${RAW} 0`,
            `${near(meteor, PLACE_REACH)} operation @s ${TOTAL} -= @s ${USED}`,
            `${near(meteor, PLACE_REACH)} set @s ${USED} 0`
        );
    }
    lines.push(
        `scoreboard players set @a ${RAW} 0`,
        `scoreboard players set @a ${USED} 0`,
        `execute as @a[scores={${TOTAL}=1..}] run scoreboard players operation @s ${SCORE} = @s ${TOTAL}`
    );
    return lines;
}

/**
 * What a meteor shower leaves, taken out: every block of every meteor that is
 * still exactly the ore the event put there - and nothing else - then its
 * counters. Safe to send again and again.
 */
export function meteorCleanup(meteors: readonly Meteor[], ores: MeteorOres): string[] {
    const lines: string[] = [];
    for (const meteor of meteors) {
        for (const block of meteor.blocks) {
            if (BLOCK_ID.test(block.block)) lines.push(removeIfOurs(block));
        }
    }
    ORE_MIX[ores].forEach((_, index) => {
        lines.push(
            `scoreboard objectives remove ${minedObjective(index)}`,
            `scoreboard objectives remove ${usedObjective(index)}`
        );
    });
    lines.push(
        `scoreboard objectives remove ${RAW}`,
        `scoreboard objectives remove ${USED}`,
        `scoreboard objectives remove ${TOTAL}`
    );
    return lines;
}
