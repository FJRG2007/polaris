/**
 * A treasure hunt: loot chests hidden on open ground around the players, each
 * under a column of light, every player's action bar pointing at the nearest
 * one, and a point for every one a player opens.
 *
 * Pure, like the rest of the commands. What it guarantees about the world:
 *
 * - A chest only ever goes where there is air, or one of the few small wild
 *   plants that grow on open ground (`PLANTS`), in the same command that checks
 *   it; on a place `findPlace` chose - dry, flat, the world's own ground, clear
 *   of every bed online. The plant it stood in is written down and put back.
 * - One is only ever taken away while it is still exactly what was put there: a
 *   chest nobody has opened, with its loot table unrolled. An opened one is the
 *   finder's and stays.
 * - Every chest and every chunk kept loaded for it is in the run's state, so a
 *   restart still takes the unopened ones away and lets the chunks go.
 */

import * as speech from "../../speech";
import * as written from "../messages";
import * as commands from "../commands";
import type { HiddenChest } from "../state";
import type { EventOptions } from "../catalog";

/** What players read, in one language or - given `speech.EVERY` - in every one. */
const messages = speech.spoken(written);

/** How far apart two chests must be, so they are found one by one and not as a heap. */
export const CHEST_GAP = 16;
/** How near they may come once no place that far apart can be found: a small island. */
export const CHEST_GAP_NEAR = 8;
/** How close a player must be to a chest found open to be the one who opened it. */
export const OPENER_REACH = 8;

/**
 * The small wild plants a chest may take the place of, newest name first: a
 * meadow is short grass all over, and a chest that would only go into air found
 * nowhere on one - every chest of a hunt on an island ended up on its one path.
 * Put back when an unopened chest is taken away. A name a version does not know
 * answers nothing, and is passed over.
 */
export const PLANTS = ["short_grass", "grass", "fern", "snow"] as const;
export type Plant = (typeof PLANTS)[number];

type Spot = { x: number; y: number; z: number };

/** `Test passed` when a spot is air: asked before a chest goes there, so a
 *  chest that was already there is never taken for one of the hunt's. */
export function airAt(point: Spot): string {
    return `execute in minecraft:overworld if block ${point.x} ${point.y} ${point.z} minecraft:air`;
}

/** `Test passed` when a spot is that plant. */
export function plantAt(point: Spot, plant: Plant): string {
    return `execute in minecraft:overworld if block ${point.x} ${point.y} ${point.z} minecraft:${plant}`;
}

/** A chest with its loot, put down only where there is nothing but air - or,
 *  given `was`, only where that plant still is. */
export function hideChest(
    point: Spot,
    loot: EventOptions<"treasure-hunt">["loot"],
    was: Plant | null = null
): string {
    const at = `${point.x} ${point.y} ${point.z}`;
    const chest = `minecraft:chest{LootTable:"${commands.LOOT[loot]}"}`;
    return was
        ? `execute in minecraft:overworld if block ${at} minecraft:${was} run setblock ${at} ${chest} replace`
        : `execute in minecraft:overworld if block ${at} minecraft:air run setblock ${at} ${chest} keep`;
}

/** How far out the next chest is looked for: spread between a third of the
 *  distance and all of it, so they are not all on one ring. */
export function huntDistance(options: EventOptions<"treasure-hunt">, random: () => number): number {
    return Math.max(24, Math.round(options.distance * (0.35 + 0.65 * random())));
}

/**
 * The way chest number `index` of `count` is looked for, in radians from north:
 * each its own share of the circle, turned by an angle drawn from the run - so
 * no two chests are sought the same way, and a restart seeks the same ways.
 */
export function chestBearing(runId: string, index: number, count: number): number {
    let hash = 0;
    for (const char of runId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const turn = ((hash % 360) * Math.PI) / 180;
    return turn + (index * 2 * Math.PI) / Math.max(1, count);
}

/** Whether a place is too near a chest already down, `gap` apart at least. */
export function tooClose(point: Spot, chests: readonly HiddenChest[], gap = CHEST_GAP): boolean {
    return chests.some((one) => Math.hypot(one.x - point.x, one.z - point.z) < gap);
}

/** How far apart players can be and still be one group (`centerOf`). */
export const GROUP_REACH = 128;

/** Where the most players in the Overworld are together, on average: where the
 *  chests are spread round. Players far apart are not averaged into ground
 *  nobody is near - the largest group is, or one player when none are close. */
export function centerOf(
    players: readonly { x: number; z: number }[]
): { x: number; z: number } | null {
    if (players.length === 0) return null;
    const groups = players.map((one) =>
        players.filter((other) => Math.hypot(other.x - one.x, other.z - one.z) <= GROUP_REACH)
    );
    const group = groups.reduce((best, next) => (next.length > best.length ? next : best));
    const sum = group.reduce((total, one) => ({ x: total.x + one.x, z: total.z + one.z }), {
        x: 0,
        z: 0
    });
    return { x: Math.round(sum.x / group.length), z: Math.round(sum.z / group.length) };
}

/**
 * Every chest nobody has opened yet shown from afar: a column of light over it,
 * and a glow round the chest itself.
 */
export function marks(chests: readonly HiddenChest[]): string[] {
    return chests
        .filter((one) => !one.opened)
        .flatMap((one) => [
            commands.beam(one),
            `execute in minecraft:overworld run particle minecraft:glow ${one.x + 0.5} ${one.y + 0.8} ${one.z + 0.5} 0.4 0.4 0.4 0 6 force`
        ]);
}

/**
 * What each player's action bar says: how far the nearest chest nobody has
 * opened is and which way, and how many are left - always, however far.
 */
export function guides(
    players: readonly { name: string; x: number; z: number }[],
    chests: readonly HiddenChest[],
    language: speech.Speech
): string[] {
    const open = chests.filter((one) => !one.opened);
    return players.map((player) => {
        let best: { chest: HiddenChest; away: number } | null = null;
        for (const chest of open) {
            const away = Math.hypot(chest.x + 0.5 - player.x, chest.z + 0.5 - player.z);
            if (!best || away < best.away) best = { chest, away };
        }
        const line = best
            ? messages.huntGuide(
                  Math.round(best.away),
                  commands.headingTo(player, { x: best.chest.x + 0.5, z: best.chest.z + 0.5 }),
                  open.length,
                  chests.length,
                  language
              )
            : messages.huntLeftBar(open.length, chests.length, language);
        return commands.actionbarFor(player.name, line);
    });
}

/** The chunks under every chest, and the columns tried for them, kept loaded -
 *  said again every tick, since finding the next place lets go of an area. */
export function holdChests(held: readonly { x: number; z: number }[]): string[] {
    return chunks(held).map((point) => commands.forceload(point.x, point.z));
}

/** A chest nobody opened taken away, the plant it stood in put back: only while
 *  it is still that chest, with its loot unrolled. */
export function removeLines(chest: HiddenChest): string[] {
    const at = `${chest.x} ${chest.y} ${chest.z}`;
    const was = PLANTS.find((one) => one === chest.was);
    return [
        ...(was
            ? [
                  `execute in minecraft:overworld if block ${at} minecraft:chest if data block ${at} LootTable run setblock ${at} minecraft:${was} replace`
              ]
            : []),
        ...commands.removeChestLines(chest)
    ];
}

/**
 * The hunt taken out of the world: every chest nobody opened taken away - only
 * while it is still an unopened chest - and every chunk kept for them let go.
 * Each line fails harmlessly when there is nothing to do, so it can run again.
 */
export function huntCleanup(
    chests: readonly HiddenChest[],
    held: readonly { x: number; z: number }[]
): string[] {
    return [
        ...chests.filter((one) => !one.opened).flatMap(removeLines),
        ...chunks([...held, ...chests]).map((point) => commands.forceloadRemove(point.x, point.z))
    ];
}

/** One point per chunk. */
function chunks(points: readonly { x: number; z: number }[]): { x: number; z: number }[] {
    const found = new Map<string, { x: number; z: number }>();
    for (const point of points) found.set(`${point.x >> 4},${point.z >> 4}`, point);
    return [...found.values()];
}
