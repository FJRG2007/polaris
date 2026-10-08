/**
 * A prize handed to one player, and where it went.
 *
 * `give` answers "Gave 5 [Diamond] to Ana" whether the diamonds went into her
 * inventory or - a full one - fell at her feet, where they despawn after five
 * minutes, or are lost in lava or carried off by water. So what she carries of
 * the item is counted before and after (`clear <player> <item> 0` counts without
 * taking anything, from 1.13), and whatever did not go in is known to have been
 * dropped: the operator has chosen that a full inventory drops the rest rather
 * than keeping it owed. Levels need no room; the level is read before and after
 * to see the rise. Levels go to the player's worn Mending gear first, as the
 * experience they are worth (`mending`), and only the rest to the bar.
 *
 * One command at a time, through the caller's `say`, which keeps each in the
 * server's RCON turn.
 */

import { stripFormatting } from "./parse";
import { gaveIt } from "./events/commands";
import { readLiveInventory } from "./inventory-service";
import * as mending from "./mending";

export interface Reward {
    readonly items: readonly { readonly id: string; readonly count: number }[];
    readonly levels: number;
}

export interface DeliveredItem {
    readonly id: string;
    /** How many were given. */
    readonly count: number;
    /** How many of them fell at the player's feet: the inventory had no room. */
    readonly dropped: number;
    /** The item's name as the game wrote it in its answer (`[Diamond]`). */
    readonly label: string | null;
}

/** An item with Mending the prize's experience repaired. */
export interface MendedItem {
    readonly id: string;
    /** Points of experience it took. */
    readonly points: number;
}

export interface Delivery {
    readonly items: readonly DeliveredItem[];
    /** Levels the player went up by. */
    readonly levels: number;
    /** What the experience repaired before the rest went on the bar. */
    readonly mended?: readonly MendedItem[];
}

export interface Handed {
    readonly delivery: Delivery;
    /** What the game did not take at all - somebody not on, a refused item -
     *  to be kept for later; null when everything was given. */
    readonly left: Reward | null;
}

export function giveLine(name: string, item: { id: string; count: number }): string {
    return `give ${name} ${item.id} ${item.count}`;
}

export function levelsLine(name: string, levels: number): string {
    return `xp add ${name} ${levels} levels`;
}

/** How many of an item a player carries, taking none. */
export function countLine(name: string, id: string): string {
    return `clear ${name} ${id} 0`;
}

/** `Found 3 matching item(s) on player Ana` / `No items were found on player
 *  Ana`; null for any other answer. */
export function readCount(output: string): number | null {
    const plain = stripFormatting(output);
    const found = /Found (\d+) matching item/i.exec(plain);
    if (found) return Number(found[1]);
    return /No items were found/i.test(plain) ? 0 : null;
}

export function levelLine(name: string): string {
    return `xp query ${name} levels`;
}

export function pointsLine(name: string, points: number): string {
    return `xp add ${name} ${points} points`;
}

/** `Ana has 12 experience levels`; null for any other answer. */
export function readLevel(output: string): number | null {
    const found = /has (\d+) experience level/i.exec(stripFormatting(output));
    return found ? Number(found[1]) : null;
}

/** The item's name out of the game's answer: `Gave 5 [Diamond] to Ana`. */
export function labelIn(output: string): string | null {
    return /Gave \d+ (\[[^\]]+\])/.exec(stripFormatting(output))?.[1] ?? null;
}

/**
 * One player's prize, a line at a time: each item counted on them, given, and
 * counted again; the levels read, added and read again. Answers what arrived
 * and what fell at their feet, and what the game refused outright - never what
 * it took, which would then be given twice.
 */
export async function deliver(
    say: (line: string) => Promise<string>,
    name: string,
    reward: Reward
): Promise<Handed> {
    const items: DeliveredItem[] = [];
    const left: { id: string; count: number }[] = [];
    for (const item of reward.items) {
        const before = readCount(await say(countLine(name, item.id)));
        const answer = await say(giveLine(name, item));
        if (!gaveIt(answer)) {
            left.push(item);
            continue;
        }
        const after = readCount(await say(countLine(name, item.id)));
        // Counted both times: whatever did not go in fell at their feet. A count
        // the game would not give is taken as all of it in, as before.
        const kept =
            before !== null && after !== null
                ? Math.min(item.count, Math.max(0, after - before))
                : item.count;
        items.push({
            id: item.id,
            count: item.count,
            dropped: item.count - kept,
            label: labelIn(answer)
        });
    }
    let levels = 0;
    let levelsLeft = 0;
    let mended: MendedItem[] = [];
    if (reward.levels > 0) {
        const before = readLevel(await say(levelLine(name)));
        const repaired = before === null ? null : await mend(say, name, before, reward.levels);
        mended = repaired?.mended ?? [];
        // The rest of the experience on the bar: the levels whole when nothing
        // was repaired, the points left when something was.
        const line = repaired
            ? repaired.left > 0
                ? pointsLine(name, repaired.left)
                : null
            : levelsLine(name, reward.levels);
        if (line === null || gaveIt(await say(line))) {
            const after = line === null ? before : readLevel(await say(levelLine(name)));
            levels =
                before !== null && after !== null
                    ? Math.max(0, after - before)
                    : repaired
                      ? 0
                      : reward.levels;
        } else {
            // Repaired already, only the rest is still owed: as the whole
            // levels it buys, never more than the prize was.
            levelsLeft = repaired ? mending.levelsFor(before!, repaired.left) : reward.levels;
        }
    }
    return {
        delivery: { items, levels, ...(mended.length > 0 ? { mended } : {}) },
        left: left.length === 0 && levelsLeft === 0 ? null : { items: left, levels: levelsLeft }
    };
}

/**
 * The experience `levels` are worth to somebody at `level`, spent on their
 * worn Mending gear (`mending`). Null when nothing was repaired - nothing
 * worn, an older server, a bag that could not be read - so the levels are
 * paid as they were; otherwise what was repaired and the points still owed.
 */
async function mend(
    say: (line: string) => Promise<string>,
    name: string,
    level: number,
    levels: number
): Promise<{ mended: MendedItem[]; left: number } | null> {
    const ask = (argv: readonly string[]) => say(argv.join(" "));
    const read = async () => {
        const reading = await readLiveInventory(ask, name).catch(() => null);
        return reading?.answered ? reading.items : null;
    };
    const items = await read();
    if (!items) return null;
    const points = mending.pointsFor(level, levels);
    const repairs = mending.plan(mending.wornMending(items), points);
    if (repairs.length === 0) return null;
    for (const repair of repairs) await say(mending.repairLine(name, repair));
    const after = await read();
    if (!after) return null;
    const mended = repairs.flatMap((repair) => {
        const taken = mending.pointsTaken([repair], after);
        return taken > 0 ? [{ id: repair.id, points: taken }] : [];
    });
    if (mended.length === 0) return null;
    const taken = mended.reduce((sum, one) => sum + one.points, 0);
    return { mended, left: Math.max(0, points - taken) };
}

/** Everything a delivery repaired, and the experience it took. */
export function mendedOf(delivery: Delivery): { count: number; points: number } | null {
    const mended = delivery.mended ?? [];
    if (mended.length === 0) return null;
    return { count: mended.length, points: mended.reduce((sum, one) => sum + one.points, 0) };
}

/** Everything of a delivery that fell at the player's feet. */
export function droppedOf(delivery: Delivery): DeliveredItem[] {
    return delivery.items.filter((one) => one.dropped > 0);
}
