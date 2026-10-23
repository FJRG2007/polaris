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
 * Each one looks the part where the server has the blocks (1.16 on): one
 * heart a shower of something rarer, in the middle of the last heap (`HEART`,
 * `heartAt`), worth `HEART_POINTS` blocks, and a scorched rim of blackstone and
 * basalt round each heap (`crustCells`),
 * put into air the same way and taken back the same way - never scored, and
 * never what decides whether a meteor is mined out.
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
    /** Its scorched rim (`crustCells`); none on a run from before it had one. */
    readonly crust?: readonly MeteorBlock[];
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

/**
 * The heart of a shower: one block of something rarer than its ore, in the
 * middle of the last meteor's heap (`heartAt`), where it is mined last. Never
 * one of the mix's own ores, so its count is its own.
 */
export const HEART: Readonly<Record<MeteorOres, string>> = {
    common: "diamond_ore",
    precious: "ancient_debris",
    diamond: "ancient_debris",
    debris: "diamond_ore"
};
/** What a heart mined near its meteor counts, in blocks. */
export const HEART_POINTS = 5;
/** Ancient debris, blackstone and basalt: from 1.16. */
export const RICH_SINCE = [1, 16] as const;

/** The heart this server can have: none where it is ancient debris and the
 *  server is older than that. */
export function heartOf(ores: MeteorOres, rich: boolean): string | null {
    const heart = HEART[ores];
    return heart === "ancient_debris" && !rich ? null : heart;
}

/** The heart the meteor landing `landing` (from 0) of `count` carries: only
 *  the last one has it, so a shower pays out one rare block, not one a meteor. */
export function heartAt(
    ores: MeteorOres,
    rich: boolean,
    landing: number,
    count: number
): string | null {
    return landing === count - 1 ? heartOf(ores, rich) : null;
}

/** The scorched rim round a meteor, and how often each block comes up:
 *  gilded blackstone now and then, which drops a little gold. */
export const CRUST_MIX: readonly (readonly [string, number])[] = [
    ["blackstone", 5],
    ["basalt", 4],
    ["gilded_blackstone", 1]
];

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
    random: () => number,
    heart: string | null = null
): MeteorBlock[] {
    return SHAPE.slice(0, Math.max(1, Math.min(SHAPE.length, size))).map(([dx, dy, dz], at) => {
        // The heart in the middle of the heap, under whatever is heaped on it.
        const block = at === 0 && heart ? heart : pick(ORE_MIX[ores], random);
        return { x: point.x + dx, y: point.y + dy, z: point.z + dz, block: `minecraft:${block}` };
    });
}

/** One block of a mix, by its weights. */
function pick(mix: readonly (readonly [string, number])[], random: () => number): string {
    const total = mix.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = random() * total;
    for (const [id, weight] of mix) {
        roll -= weight;
        if (roll < 0) return id;
    }
    return mix[mix.length - 1]![0];
}

/**
 * The scorched rim round a meteor's heap: on the ground, beside the heap and
 * never on it, so every ore can still be seen from above; some of it a block
 * higher, always on rim below. Each one ringed round the heap's foot is also
 * asked to stand on something (`groundTest`) before it is put down.
 */
export function crustCells(
    point: Point,
    ore: readonly Point[],
    random: () => number
): MeteorBlock[] {
    const foot = ore.filter((cell) => cell.y === point.y);
    const taken = new Set(ore.map((cell) => `${cell.x} ${cell.y} ${cell.z}`));
    const low: MeteorBlock[] = [];
    for (let dx = -2; dx <= 2; dx += 1) {
        for (let dz = -2; dz <= 2; dz += 1) {
            const x = point.x + dx;
            const z = point.z + dz;
            if (taken.has(`${x} ${point.y} ${z}`)) continue;
            const beside = foot.some(
                (cell) => Math.max(Math.abs(cell.x - x), Math.abs(cell.z - z)) === 1
            );
            if (!beside || random() >= 0.8) continue;
            low.push({ x, y: point.y, z, block: `minecraft:${pick(CRUST_MIX, random)}` });
        }
    }
    const high = low
        .filter(() => random() < 0.45)
        .map((cell) => ({
            x: cell.x,
            y: cell.y + 1,
            z: cell.z,
            block: `minecraft:${pick(CRUST_MIX, random)}`
        }));
    return [...low, ...high];
}

const at = (point: Point) => `${point.x} ${point.y} ${point.z}`;

/** `Test passed` only where the block is air now. */
export function airTest(point: Point): string {
    return `execute in minecraft:overworld if block ${at(point)} minecraft:air`;
}

/** `Test passed` where the block under a point is air: nothing is put down
 *  to hang there. */
export function groundTest(point: Point): string {
    return `execute in minecraft:overworld if block ${point.x} ${point.y - 1} ${point.z} minecraft:air`;
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
        // The blast thrown out round it: a ring of dust and a spray of embers.
        `execute in minecraft:overworld run particle minecraft:cloud ${x} ${point.y + 0.5} ${z} 3 0.2 3 0.05 160 force`,
        `execute in minecraft:overworld run particle minecraft:lava ${x} ${point.y + 1} ${z} 1 0.5 1 0 40 force`,
        "execute as @a at @s run playsound minecraft:entity.generic.explode master @s ~ ~ ~ 0.8 0.6"
    ];
}

/** A meteor still to mine, smouldering every look: smoke rising off it and an
 *  ember now and then, seen from a distance as well as the beam. */
export function smoulder(point: Point): string[] {
    const x = point.x + 0.5;
    const z = point.z + 0.5;
    return [
        `execute in minecraft:overworld run particle minecraft:large_smoke ${x} ${point.y + 1.5} ${z} 0.6 0.6 0.6 0.02 8 force`,
        `execute in minecraft:overworld run particle minecraft:lava ${x} ${point.y + 1} ${z} 0.6 0.3 0.6 0 2 force`
    ];
}

/** How far ahead of a player the trail to a meteor goes, a mote at each step. */
export const TRAIL_STEPS = [2, 4, 6, 8] as const;

/**
 * A short line of light from a player towards a meteor, at chest height, that
 * only they see: follow it and it leads there.
 */
export function trail(name: string, from: Point, to: Point): string[] {
    const dx = to.x + 0.5 - from.x;
    const dz = to.z + 0.5 - from.z;
    const length = Math.hypot(dx, dz);
    if (length < 1) return [];
    return TRAIL_STEPS.filter((step) => step < length).map((step) => {
        const x = (from.x + (dx / length) * step).toFixed(2);
        const z = (from.z + (dz / length) * step).toFixed(2);
        return `execute in minecraft:overworld run particle minecraft:end_rod ${x} ${(from.y + 1.2).toFixed(2)} ${z} 0 0 0 0 1 force ${name}`;
    });
}

const minedObjective = (index: number) => `pe_mo${index}`;
const usedObjective = (index: number) => `pe_mu${index}`;
const HEART_MINED = "pe_mh";
const HEART_USED = "pe_mhu";
const RAW = "pe_mraw";
const USED = "pe_mused";
export const TOTAL = "pe_mtot";

/** The counters: each ore of the mix mined, and placed, the heart's own, and
 *  the running total. No heart counters where the server has no heart. */
export function meteorSetup(ores: MeteorOres, heart: string | null = HEART[ores]): string[] {
    const lines: string[] = [];
    ORE_MIX[ores].forEach(([id], index) => {
        lines.push(
            `scoreboard objectives remove ${minedObjective(index)}`,
            `scoreboard objectives add ${minedObjective(index)} minecraft.mined:minecraft.${id}`,
            `scoreboard objectives remove ${usedObjective(index)}`,
            `scoreboard objectives add ${usedObjective(index)} minecraft.used:minecraft.${id}`
        );
    });
    if (heart)
        lines.push(
            `scoreboard objectives remove ${HEART_MINED}`,
            `scoreboard objectives add ${HEART_MINED} minecraft.mined:minecraft.${heart}`,
            `scoreboard objectives remove ${HEART_USED}`,
            `scoreboard objectives add ${HEART_USED} minecraft.used:minecraft.${heart}`
        );
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
export function meteorTick(
    meteors: readonly Point[],
    ores: MeteorOres,
    heart: string | null = null
): string[] {
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
    // A heart counts `HEART_POINTS` blocks, mined or placed alike.
    if (heart) {
        lines.push(
            `scoreboard players add @a ${HEART_MINED} 0`,
            `scoreboard players add @a ${HEART_USED} 0`
        );
        for (let time = 0; time < HEART_POINTS; time += 1)
            lines.push(
                `execute as @a run scoreboard players operation @s ${RAW} += @s ${HEART_MINED}`,
                `execute as @a run scoreboard players operation @s ${USED} += @s ${HEART_USED}`
            );
        lines.push(
            `scoreboard players set @a ${HEART_MINED} 0`,
            `scoreboard players set @a ${HEART_USED} 0`
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
        for (const block of [...meteor.blocks, ...(meteor.crust ?? [])]) {
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
        `scoreboard objectives remove ${HEART_MINED}`,
        `scoreboard objectives remove ${HEART_USED}`,
        `scoreboard objectives remove ${RAW}`,
        `scoreboard objectives remove ${USED}`,
        `scoreboard objectives remove ${TOTAL}`
    );
    return lines;
}
