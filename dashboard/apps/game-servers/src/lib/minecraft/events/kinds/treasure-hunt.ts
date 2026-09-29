/**
 * A treasure hunt: loot chests hidden on open ground around the players, told
 * in clues that sharpen as it goes, and a point for every one a player opens.
 *
 * Pure, like the rest of the commands. What it guarantees about the world:
 *
 * - A chest is only ever put into air (`if block ... air` and `setblock ... keep`
 *   in the same command), on a place `findPlace` chose - dry, flat, the world's
 *   own ground, clear of every bed online.
 * - One is only ever taken away while it is still exactly what was put there: a
 *   chest nobody has opened, with its loot table unrolled. An opened one is the
 *   finder's and stays.
 * - Every chest and every chunk kept loaded for it is in the run's state, so a
 *   restart still takes the unopened ones away and lets the chunks go.
 */

import * as commands from "../commands";
import * as messages from "../messages";
import type { HiddenChest } from "../state";
import type { EventOptions, Language } from "../catalog";

/** How close a chest must be before a player's action bar points at it. */
export const GUIDE_RANGE = 48;
/** How far apart two chests must be, so one find is not two. */
export const CHEST_GAP = 16;
/** How precisely the second clue tells where a chest is. */
export const AREA_STEP = 50;
/** How close a player must be to a chest found open to be the one who opened it. */
export const OPENER_REACH = 8;
/** The beams come on for the last this-many seconds - or the last quarter of a
 *  short hunt, whichever is less. */
export const BEAM_SECONDS = 120;

type Spot = { x: number; y: number; z: number };

/** `Test passed` when a spot is air: asked before a chest goes there, so a
 *  chest that was already there is never taken for one of the hunt's. */
export function airAt(point: Spot): string {
    return `execute in minecraft:overworld if block ${point.x} ${point.y} ${point.z} minecraft:air`;
}

/** A chest with its loot, put down only where there is nothing but air. */
export function hideChest(point: Spot, loot: EventOptions<"treasure-hunt">["loot"]): string {
    const at = `${point.x} ${point.y} ${point.z}`;
    return `execute in minecraft:overworld if block ${at} minecraft:air run setblock ${at} minecraft:chest{LootTable:"${commands.LOOT[loot]}"} keep`;
}

/** How far out the next chest is looked for: spread between a third of the
 *  distance and all of it, so they are not all on one ring. */
export function huntDistance(options: EventOptions<"treasure-hunt">, random: () => number): number {
    return Math.max(24, Math.round(options.distance * (0.35 + 0.65 * random())));
}

/** Whether a place is too near a chest already down. */
export function tooClose(point: Spot, chests: readonly HiddenChest[]): boolean {
    return chests.some((one) => Math.hypot(one.x - point.x, one.z - point.z) < CHEST_GAP);
}

/** Where everybody in the Overworld is, on average: what the first clue is told from. */
export function centreOf(
    players: readonly { x: number; z: number }[]
): { x: number; z: number } | null {
    if (players.length === 0) return null;
    const sum = players.reduce((total, one) => ({ x: total.x + one.x, z: total.z + one.z }), {
        x: 0,
        z: 0
    });
    return { x: Math.round(sum.x / players.length), z: Math.round(sum.z / players.length) };
}

/** Which clue is due: the first as soon as the chests are down, the area a
 *  third of the way in, the exact spot two thirds in. */
export function clueDue(share: number): 1 | 2 | 3 {
    return share >= 2 / 3 ? 3 : share >= 1 / 3 ? 2 : 1;
}

/** Whether the beams are on: the last minutes only. */
export function beamsOn(secondsLeft: number, totalSeconds: number): boolean {
    return secondsLeft <= Math.min(BEAM_SECONDS, totalSeconds / 4);
}

/** One clue for every chest nobody has opened yet, numbered as they were hidden. */
export function clues(
    chests: readonly HiddenChest[],
    step: 1 | 2 | 3,
    origin: { x: number; z: number },
    language: Language
): string[] {
    return chests.flatMap((chest, index) => {
        if (chest.opened) return [];
        const number = index + 1;
        if (step === 1) {
            const away = Math.hypot(chest.x - origin.x, chest.z - origin.z);
            return [
                messages.huntClueFar(
                    number,
                    Math.max(AREA_STEP, commands.roughly(away, AREA_STEP)),
                    commands.headingTo(origin, chest),
                    origin,
                    language
                )
            ];
        }
        if (step === 2) {
            return [
                messages.huntClueArea(
                    number,
                    commands.roughly(chest.x, AREA_STEP),
                    commands.roughly(chest.z, AREA_STEP),
                    AREA_STEP,
                    language
                )
            ];
        }
        return [messages.huntClueExact(number, chest.x, chest.y, chest.z, language)];
    });
}

/**
 * What each player's action bar says: the way to the nearest chest nobody has
 * opened once they are close to one, and how many are left otherwise.
 */
export function guides(
    players: readonly { name: string; x: number; z: number }[],
    chests: readonly HiddenChest[],
    language: Language
): string[] {
    const open = chests.filter((one) => !one.opened);
    return players.map((player) => {
        let best: { chest: HiddenChest; away: number } | null = null;
        for (const chest of open) {
            const away = Math.hypot(chest.x + 0.5 - player.x, chest.z + 0.5 - player.z);
            if (!best || away < best.away) best = { chest, away };
        }
        const line =
            best && best.away <= GUIDE_RANGE
                ? messages.huntNear(
                      Math.round(best.away),
                      commands.headingTo(player, { x: best.chest.x + 0.5, z: best.chest.z + 0.5 }),
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
        ...chests.filter((one) => !one.opened).flatMap((one) => commands.removeChestLines(one)),
        ...chunks([...held, ...chests]).map((point) => commands.forceloadRemove(point.x, point.z))
    ];
}

/** One point per chunk. */
function chunks(points: readonly { x: number; z: number }[]): { x: number; z: number }[] {
    const found = new Map<string, { x: number; z: number }>();
    for (const point of points) found.set(`${point.x >> 4},${point.z >> 4}`, point);
    return [...found.values()];
}
