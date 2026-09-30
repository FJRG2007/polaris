/**
 * What a player carries, kept safe while they play an event in its own arena.
 *
 * An arena or a stage hands out a kit - a sword, a shovel, glass to build with -
 * or asks everybody to come in empty-handed, and a player's own things must never
 * be lost to it: not to a kit cleared at the end, not to a restart, not to a
 * player who logs off halfway. So on the way in, every one of the 41 slots a
 * player has (the hotbar, the bag, the armour and the offhand) is copied - whole,
 * with every enchantment, name and shulker's contents - into two barrels that are
 * the event's own, the copy is read back and checked, and only then is the slot
 * emptied. On the way out, after the kit is taken back, each slot is copied back
 * from its barrel into the same slot if that slot is empty, or dropped at the
 * player's feet as theirs if it is not; the barrel slot is emptied only once the
 * player is seen to have it. Nothing is ever given back twice: a barrel slot that
 * is already empty was already given back.
 *
 * The barrels sit under the event's own floor, cased in barrier so nobody can
 * reach them, in air only, in the columns the event keeps loaded. `item` is
 * 1.17's: an older server keeps today's behaviour, the kit beside what they carry.
 *
 * Pure: the lines, the layout and the checks. The talking is `stash-service`.
 */

import { z } from "zod";
import { replaceSlot } from "../../item-argument";
import type { InventoryItem } from "../../inventory";

const pointSchema = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });

export type Spot = z.infer<typeof pointSchema>;

/** One slot kept: where it was, which barrel and slot it sits in, and what it is. */
const keptSchema = z.object({
    slot: z.number().int(),
    barrel: z.number().int().min(0).max(1),
    container: z.number().int().min(0).max(26),
    id: z.string(),
    count: z.number().int(),
    /** A digest of the stack's own data, to tell it from another of the same id. */
    data: z.string().nullable()
});

export type Kept = z.infer<typeof keptSchema>;

export const stashSchema = z.object({
    /** The two barrels, in order. */
    barrels: z.array(pointSchema).max(2),
    /** The barrier around them: taken away with them, and only what was placed. */
    casing: z.array(pointSchema).default([]),
    /** Every slot still in a barrel. Emptied as each is given back. */
    kept: z.array(keptSchema).default([]),
    /** `taking` from the moment the copy was checked until the slots are seen
     *  emptied - a stack still in its slot then was never taken; `stashed` after;
     *  `failed` for a give-back that could not finish. */
    state: z.enum(["taking", "stashed", "failed"]).default("stashed"),
    /** The snapshot row kept in the database for this stash. */
    record: z.string().nullable().default(null)
});

export type Stash = z.infer<typeof stashSchema>;

/** A barrel holds 27 stacks; 41 slots take two. */
export const BARREL_SLOTS = 27;

/** The slots kept, in the order they are laid into the barrels. */
export const SLOTS: readonly number[] = [
    ...Array.from({ length: 36 }, (_unused, index) => index),
    100,
    101,
    102,
    103,
    -106
];

/** Where the stack from a slot is kept: its place in `SLOTS`, over two barrels. */
export function keptAt(slot: number): { barrel: number; container: number } | null {
    const index = SLOTS.indexOf(slot);
    if (index < 0) return null;
    return { barrel: Math.floor(index / BARREL_SLOTS), container: index % BARREL_SLOTS };
}

/** The stacks that are kept: those in the 41 slots every version has. A modded
 *  slot - a backpack, a ring - is none of this, and is left where it is. */
export function keepable(items: readonly InventoryItem[]): InventoryItem[] {
    return items.filter(
        (item) =>
            keptAt(item.slot) !== null &&
            replaceSlot(item.slot) !== null &&
            // The event's own kit is the event's, cleared at the end - never kept.
            !(item.data?.snbt.includes("polaris_event") ?? false)
    );
}

const WORLD = "execute in minecraft:overworld run";

const at = (spot: Spot) => `${spot.x} ${spot.y} ${spot.z}`;

// ------------------------------------------------------------------ where

/**
 * Every block one stash takes, barrels first: two barrels side by side, the
 * barrier under them and round their four sides. What is over them is the
 * event's own floor.
 */
export function blocksAt(origin: Spot): { barrels: Spot[]; casing: Spot[] } {
    const { x, y, z } = origin;
    return {
        barrels: [
            { x, y, z },
            { x: x + 1, y, z }
        ],
        casing: [
            { x, y: y - 1, z },
            { x: x + 1, y: y - 1, z },
            { x: x - 1, y, z },
            { x: x + 2, y, z },
            { x, y, z: z - 1 },
            { x: x + 1, y, z: z - 1 },
            { x, y, z: z + 1 },
            { x: x + 1, y, z: z + 1 }
        ]
    };
}

/**
 * Where stashes can go under a floor: every fourth column along it, every third
 * row across, one block under the floor's own layer - so two stashes never touch
 * and each is covered by the floor above it.
 */
export function spotsUnder(floor: {
    readonly x1: number;
    readonly z1: number;
    readonly x2: number;
    readonly z2: number;
    readonly y: number;
}): Spot[] {
    const spots: Spot[] = [];
    const [x1, x2] = [Math.min(floor.x1, floor.x2), Math.max(floor.x1, floor.x2)];
    const [z1, z2] = [Math.min(floor.z1, floor.z2), Math.max(floor.z1, floor.z2)];
    for (let z = z1 + 1; z <= z2 - 1; z += 3) {
        for (let x = x1 + 1; x + 2 <= x2; x += 4) spots.push({ x, y: floor.y - 1, z });
    }
    return spots;
}

/** One question: are all of these air? `Test passed` when they are. */
export function allAir(spots: readonly Spot[]): string {
    return `execute in minecraft:overworld ${spots.map((spot) => `if block ${at(spot)} minecraft:air`).join(" ")}`;
}

/** Put down into air only: the barrels, then their casing. */
export function placeLines(blocks: { barrels: readonly Spot[]; casing: readonly Spot[] }): string[] {
    return [
        ...blocks.barrels.map((spot) => `${WORLD} setblock ${at(spot)} minecraft:barrel keep`),
        ...blocks.casing.map((spot) => `${WORLD} setblock ${at(spot)} minecraft:barrier keep`)
    ];
}

/** Whether a block is still what was put there. */
export function isBlock(spot: Spot, block: "minecraft:barrel" | "minecraft:barrier"): string {
    return `execute in minecraft:overworld if block ${at(spot)} ${block}`;
}

/**
 * Taken away again, and only where the block is still the one placed: an empty
 * barrel (checked first by the caller), the barrier round it.
 */
export function removeLines(stash: Pick<Stash, "barrels" | "casing">): string[] {
    return [
        ...stash.barrels.map(
            (spot) =>
                `execute in minecraft:overworld if block ${at(spot)} minecraft:barrel run setblock ${at(spot)} minecraft:air`
        ),
        ...stash.casing.map(
            (spot) =>
                `execute in minecraft:overworld if block ${at(spot)} minecraft:barrier run setblock ${at(spot)} minecraft:air`
        )
    ];
}

// ------------------------------------------------------------------ in

/** A slot copied into its barrel. */
export function copyIn(name: string, barrels: readonly Spot[], slot: number): string | null {
    const where = keptAt(slot);
    const named = replaceSlot(slot);
    const barrel = where ? barrels[where.barrel] : undefined;
    if (!where || !named || !barrel) return null;
    return `${WORLD} item replace block ${at(barrel)} container.${where.container} from entity ${name} ${named}`;
}

/** A slot emptied, once its copy was checked. */
export function emptySlot(name: string, slot: number): string | null {
    const named = replaceSlot(slot);
    return named ? `item replace entity ${name} ${named} with minecraft:air` : null;
}

// ------------------------------------------------------------------ out

/** A kept stack copied back into the slot it came from. */
export function copyBack(name: string, barrels: readonly Spot[], kept: Kept): string | null {
    const named = replaceSlot(kept.slot);
    const barrel = barrels[kept.barrel];
    if (!named || !barrel) return null;
    return `${WORLD} item replace entity ${name} ${named} from block ${at(barrel)} container.${kept.container}`;
}

/** The tag a stack dropped for somebody carries until it is checked. */
export function dropTag(kept: Kept): string {
    return `pe_sd${kept.barrel}_${kept.container}`;
}

/**
 * A kept stack whose slot is taken now, dropped at the player's feet as theirs:
 * an item that never despawns and only they can pick up, holding the barrel's
 * copy exactly. Nobody can pick it up until it is checked (`releaseDrop`): a
 * player standing there would otherwise take the placeholder it starts as.
 */
export function dropLines(name: string, barrels: readonly Spot[], kept: Kept): string[] {
    const barrel = barrels[kept.barrel];
    if (!barrel) return [];
    const tag = dropTag(kept);
    const it = `@e[type=minecraft:item,tag=${tag},limit=1]`;
    return [
        `execute at ${name} run summon minecraft:item ~ ~ ~ {Item:{id:"minecraft:stone",count:1},Tags:["${tag}"],PickupDelay:32767,Age:-32768}`,
        `execute as ${it} run item replace entity @s contents from block ${at(barrel)} container.${kept.container}`,
        `execute as ${it} run data modify entity @s Owner set from entity ${name} UUID`
    ];
}

/** Whether the dropped stack is there at all: before 1.20.5 the summon above
 *  makes an empty item (its `count` is not read), which is gone at once. */
export function dropThere(kept: Kept): string {
    return `execute if entity @e[type=minecraft:item,tag=${dropTag(kept)}]`;
}

/**
 * The same drop as the game wrote items before 1.20.5: the placeholder with
 * `Count`, and the copy taken from the barrel's list of items (an item entity
 * has no `contents` slot there). What the copy carries of its barrel slot is
 * taken off again.
 */
export function legacyDropLines(name: string, barrels: readonly Spot[], kept: Kept): string[] {
    const barrel = barrels[kept.barrel];
    if (!barrel) return [];
    const tag = dropTag(kept);
    const it = `@e[type=minecraft:item,tag=${tag},limit=1]`;
    return [
        `execute at ${name} run summon minecraft:item ~ ~ ~ {Item:{id:"minecraft:stone",Count:1b},Tags:["${tag}"],PickupDelay:32767,Age:-32768}`,
        `execute as ${it} run data modify entity @s Item set from block ${at(barrel)} Items[{Slot:${kept.container}b}]`,
        `execute as ${it} run data remove entity @s Item.Slot`,
        `execute as ${it} run data modify entity @s Owner set from entity ${name} UUID`
    ];
}

/** The dropped stack, read back to check it holds the copy. */
export function readDrop(kept: Kept): string {
    return `data get entity @e[type=minecraft:item,tag=${dropTag(kept)},limit=1] Item`;
}

/** Checked: theirs to pick up, and from then on simply their item. */
export function releaseDrop(kept: Kept): string[] {
    const tag = dropTag(kept);
    return [
        `execute as @e[type=minecraft:item,tag=${tag}] run data modify entity @s PickupDelay set value 0s`,
        `tag @e[type=minecraft:item,tag=${tag}] remove ${tag}`
    ];
}

/** Not what it should hold: taken away again. The stack is still in its barrel. */
export function discardDrop(kept: Kept): string {
    return `kill @e[type=minecraft:item,tag=${dropTag(kept)}]`;
}

/** A barrel slot emptied once the player is seen to have what was in it. */
export function emptyKept(barrels: readonly Spot[], kept: Kept): string | null {
    const barrel = barrels[kept.barrel];
    if (!barrel) return null;
    return `${WORLD} item replace block ${at(barrel)} container.${kept.container} with minecraft:air`;
}

// ------------------------------------------------------------------ checks

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

/**
 * What to keep, from what a player carries: each stack with its barrel and slot.
 */
export function keepFrom(
    items: readonly InventoryItem[],
    digest: (item: InventoryItem) => string | null
): Kept[] {
    return keepable(items).map((item) => {
        const where = keptAt(item.slot)!;
        return {
            slot: item.slot,
            barrel: where.barrel,
            container: where.container,
            id: item.id,
            count: item.count,
            data: digest(item)
        };
    });
}

/**
 * Whether the barrels hold exactly the copy: every kept stack in its barrel slot,
 * and nothing else in either barrel.
 */
export function copiedWhole(
    kept: readonly Kept[],
    barrels: readonly (readonly InventoryItem[])[],
    digest: (item: InventoryItem) => string | null
): boolean {
    for (const [index, held] of barrels.entries()) {
        const wanted = kept.filter((one) => one.barrel === index);
        if (held.length !== wanted.length) return false;
        for (const one of wanted) {
            const item = held.find((stack) => stack.slot === one.container);
            if (!sameStack(one, item, digest)) return false;
        }
    }
    return true;
}
