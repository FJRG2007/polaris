/**
 * What a player carries, kept safe while they play an event in its own arena.
 *
 * An arena or a stage hands out a kit - a sword, a shovel, glass to build with -
 * or asks everybody to come in empty-handed, and a player's own things must never
 * be lost to it: not to a kit cleared at the end, not to a restart, not to a
 * player who logs off halfway, not to a fall on the way home.
 *
 * On the way in, every stack in the 41 slots every version has (the hotbar, the
 * bag, the armor and the offhand) is written to the database whole - its slot,
 * id, count and the raw data the server wrote, the same lossless form an
 * inventory export takes (`inventory-transfer`) - with the player's experience,
 * and only once that is written is the slot emptied and the experience taken.
 *
 * On the way out, once they are home and standing on something, each stack goes
 * back through the same checked slot write an import uses: into the slot it came
 * from when that slot is empty, read back and compared; dropped at their feet as
 * theirs, read back and compared, when it is not. A stack is let go of only once
 * it is seen given back, and a stack already in its own slot was given back
 * before a restart - nothing is ever given twice. A player who is not on gets it
 * all when they are.
 *
 * A stack a command cannot carry - one whose data is too long for a command, or
 * whose reply was too long to read whole - is never taken: it stays where it is.
 *
 * Before this, the stacks were copied into two barrels under the event's floor,
 * cased in barrier. `barrels` and `casing` are kept for a stash written that
 * way: its stacks are given back from its database copy all the same, and the
 * blocks it placed are taken away once it is done - only where they still are
 * the barrel or barrier it placed.
 *
 * Pure: the lines, the layout and the checks. The talking is `stash-service`.
 */

import { z } from "zod";
import type { InventoryItem } from "../../inventory";
import { itemArgument, replaceSlot } from "../../item-argument";
import { COMMAND_BYTES_MAX, commandBytes } from "../../command-size";

const pointSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });

export type Spot = z.infer<typeof pointSchema>;

/** One slot kept: where it was, and what it is. `barrel` and `container` only
 *  on a stash kept in barrels, before this. */
const keptSchema = z.object({
    slot: z.number().int(),
    barrel: z.number().int().min(0).max(1).optional(),
    container: z.number().int().min(0).max(26).optional(),
    id: z.string(),
    count: z.number().int(),
    /** A digest of the stack's own data, to tell it from another of the same id. */
    data: z.string().nullable()
});

export type Kept = z.infer<typeof keptSchema>;

/** Experience as the game counts it: whole levels, and the points into the next. */
const experienceSchema = z.object({
    levels: z.number().int().min(0),
    points: z.number().int().min(0)
});

export type Experience = z.infer<typeof experienceSchema>;

export const stashSchema = z.object({
    /** A stash kept in barrels, before this: the two barrels, in order. */
    barrels: z.array(pointSchema).max(2).default([]),
    /** And the barrier round them: taken away with them, and only what was placed. */
    casing: z.array(pointSchema).default([]),
    /** Every slot still owed. Emptied as each is given back. */
    kept: z.array(keptSchema).default([]),
    /** The experience taken, until it is given back. */
    experience: experienceSchema.nullable().default(null),
    /** `taking` from the moment the copy was written until the slots are seen
     *  emptied - a stack still in its slot then was never taken; `stashed` after;
     *  `failed` for a give-back that could not finish. */
    state: z.enum(["taking", "stashed", "failed"]).default("stashed"),
    /** The database row that holds each stack whole. */
    record: z.string().nullable().default(null)
});

export type Stash = z.infer<typeof stashSchema>;

/** The slots kept, in the game's own numbering. */
export const SLOTS: readonly number[] = [
    ...Array.from({ length: 36 }, (_unused, index) => index),
    100,
    101,
    102,
    103,
    -106
];

/**
 * The stacks that are kept: those in the 41 slots every version has, that a
 * command can write back whole. A modded slot - a backpack, a ring - is none of
 * this and is left where it is, and so is a stack too big for a command.
 */
export function keepable(items: readonly InventoryItem[]): InventoryItem[] {
    return items.filter(
        (item) =>
            SLOTS.includes(item.slot) &&
            replaceSlot(item.slot) !== null &&
            itemArgument(item).ok &&
            // The event's own kit is the event's, cleared at the end - never kept.
            !(item.data?.snbt.includes("polaris_event") ?? false)
    );
}

/** Two stacks the same: id, count and data. `digest` turns a stack's data into
 *  the same short form a `Kept` holds. */
export function sameStack(
    kept: Pick<Kept, "id" | "count" | "data">,
    item: InventoryItem | undefined,
    digest: (item: InventoryItem) => string | null
): boolean {
    return (
        item !== undefined &&
        item.id === kept.id &&
        item.count === kept.count &&
        digest(item) === kept.data
    );
}

/** What to keep, from what a player carries. */
export function keepFrom(
    items: readonly InventoryItem[],
    digest: (item: InventoryItem) => string | null
): Kept[] {
    return keepable(items).map((item) => ({
        slot: item.slot,
        id: item.id,
        count: item.count,
        data: digest(item)
    }));
}

/** A slot emptied, once its copy is written. */
export function emptySlot(name: string, slot: number): string | null {
    const named = replaceSlot(slot);
    return named ? `item replace entity ${name} ${named} with minecraft:air` : null;
}

// ------------------------------------------------------------------ experience

export function readLevels(name: string): string {
    return `xp query ${name} levels`;
}

export function readPoints(name: string): string {
    return `xp query ${name} points`;
}

/** `Ana has 12 experience levels` / `Ana has 5 experience points`. Null when
 *  it is not that answer - the player is not on. */
export function readExperienceCount(output: string): number | null {
    const match = /has (\d+) experience (?:levels?|points?)/i.exec(output);
    return match ? Number(match[1]) : null;
}

/** Their experience set to exactly this: levels first, then the points into the next. */
export function setExperience(name: string, experience: Experience): string[] {
    return [
        `xp set ${name} ${experience.levels} levels`,
        `xp set ${name} ${experience.points} points`
    ];
}

// ------------------------------------------------------------------ out

/** The tag a stack dropped for somebody carries until it is checked: one per
 *  stash and slot, so a drop left by a stopped give-back is found again. */
export function dropTag(record: string | null, slot: number): string {
    const owner = (record ?? "x").replace(/[^A-Za-z0-9]/g, "").slice(-8);
    return `pe_gb${owner}_${SLOTS.indexOf(slot)}`;
}

/**
 * A kept stack whose slot is taken now, dropped at the player's feet as theirs:
 * an item that never despawns and nobody can pick up until it is checked, then
 * only they can. Written the way the stack's own data is - a count and
 * components from 1.20.5, a `Count` and a tag before - and, for a stack with no
 * data, both: the second only where the first made nothing (an older server
 * reads no `count` and drops an empty stack at once). Tagged for its stash and
 * slot (`dropTag`). Null when a line would be longer than a command can be.
 */
export function dropLines(name: string, item: InventoryItem, record: string | null): string[] | null {
    const tag = dropTag(record, item.slot);
    const it = `@e[type=minecraft:item,tag=${tag}]`;
    const tail = `Tags:["${tag}"],PickupDelay:32767,Age:-32768`;
    const modern = `execute unless entity ${it} at ${name} run summon minecraft:item ~ ~ ~ {Item:{id:"${item.id}",count:${item.count}${item.data?.era === "components" ? `,components:${item.data.snbt}` : ""}},${tail}}`;
    const legacy = `execute unless entity ${it} at ${name} run summon minecraft:item ~ ~ ~ {Item:{id:"${item.id}",Count:${item.count}b${item.data?.era === "tag" ? `,tag:${item.data.snbt}` : ""}},${tail}}`;
    const lines =
        item.data === null ? [modern, legacy] : item.data.era === "components" ? [modern] : [legacy];
    return lines.every((line) => commandBytes(line) <= COMMAND_BYTES_MAX) ? lines : null;
}

/** The dropped stack, read back to check it holds the copy. */
export function readDrop(tag: string): string {
    return `data get entity @e[type=minecraft:item,tag=${tag},limit=1] Item`;
}

/** Checked: only they can pick it up, from now. */
export function releaseDrop(name: string, tag: string): string[] {
    const it = `@e[type=minecraft:item,tag=${tag}]`;
    return [
        `execute as ${it} run data modify entity @s Owner set from entity ${name} UUID`,
        `execute as ${it} run data modify entity @s PickupDelay set value 0s`,
        `tag ${it} remove ${tag}`
    ];
}

/** Not what it should hold: taken away again. The stack is still owed. */
export function discardDrop(tag: string): string {
    return `kill @e[type=minecraft:item,tag=${tag}]`;
}

// ------------------------------------------------------------------ home, and down

/**
 * Whether somebody is still in the air: nothing under their feet. Standing,
 * swimming or sinking in water all count as down - there is nothing left to fall.
 * `Test passed` while they are up.
 */
export function airborne(name: string): string {
    return `execute as ${name} at @s if block ~ ~-0.2 ~ minecraft:air if block ~ ~-1.2 ~ minecraft:air`;
}

// ------------------------------------------------------------------ the barrels, before this

/** Whether a block is still what a stash kept in barrels placed there. */
export function isBlock(spot: Spot, block: "minecraft:barrel" | "minecraft:barrier"): string {
    return `execute in minecraft:overworld if block ${spot.x} ${spot.y} ${spot.z} ${block}`;
}

/** A barrel slot emptied once what it held is given back from the database copy. */
export function emptyBarrelSlot(barrels: readonly Spot[], kept: Kept): string | null {
    const barrel = kept.barrel === undefined ? undefined : barrels[kept.barrel];
    if (!barrel || kept.container === undefined) return null;
    return `execute in minecraft:overworld run item replace block ${barrel.x} ${barrel.y} ${barrel.z} container.${kept.container} with minecraft:air`;
}

/** A kept stack copied from its barrel slot into the player's slot it came from. */
export function copyFromBarrel(name: string, barrels: readonly Spot[], kept: Kept): string | null {
    const barrel = kept.barrel === undefined ? undefined : barrels[kept.barrel];
    const named = replaceSlot(kept.slot);
    if (!barrel || kept.container === undefined || !named) return null;
    return `execute in minecraft:overworld run item replace entity ${name} ${named} from block ${barrel.x} ${barrel.y} ${barrel.z} container.${kept.container}`;
}

/**
 * The blocks a stash in barrels placed, taken away - each only where it still is
 * the block that was placed: a barrel (checked empty first by the caller), the
 * barrier round it.
 */
export function removeLines(stash: Pick<Stash, "barrels" | "casing">): string[] {
    const air = (spot: Spot, block: string) =>
        `execute in minecraft:overworld if block ${spot.x} ${spot.y} ${spot.z} ${block} run setblock ${spot.x} ${spot.y} ${spot.z} minecraft:air`;
    return [
        ...stash.barrels.map((spot) => air(spot, "minecraft:barrel")),
        ...stash.casing.map((spot) => air(spot, "minecraft:barrier"))
    ];
}
