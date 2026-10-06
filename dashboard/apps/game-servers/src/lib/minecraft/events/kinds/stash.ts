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
 * A stack too long for one command - a shulker box of enchanted gear, a piece
 * of armor with a long lore - is read and written in as many commands as it
 * takes, through command storage (`stack-storage`). Nothing a player brings is
 * left on them: a stack that cannot be taken at all - one string in it longer
 * than any command, a slot no command reaches - keeps them out of the event
 * instead, with everything of theirs where it was.
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
import * as storage from "../../stack-storage";
import type { InventoryItem } from "../../inventory";
import { itemArgument, replaceSlot } from "../../item-argument";
import { readInt, splitTopLevel, topLevelColon, unquote } from "../../snbt";
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

/** Health and hunger as the game keeps them on a player. */
const vitalsSchema = z.object({
    health: z.number().min(0),
    food: z.number().int().min(0).max(20),
    saturation: z.number().min(0),
    exhaustion: z.number().min(0)
});

export type Vitals = z.infer<typeof vitalsSchema>;

export const stashSchema = z.object({
    /** A stash kept in barrels, before this: the two barrels, in order. */
    barrels: z.array(pointSchema).max(2).default([]),
    /** And the barrier round them: taken away with them, and only what was placed. */
    casing: z.array(pointSchema).default([]),
    /** Every slot still owed. Emptied as each is given back. */
    kept: z.array(keptSchema).default([]),
    /** The experience taken, until it is given back. */
    experience: experienceSchema.nullable().default(null),
    /** Their health and hunger on the way in, until they are given back. */
    vitals: vitalsSchema.nullable().default(null),
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

/** The event's own kit: the event's, cleared at the end - never kept, and never
 *  in the way of anybody coming in. */
export function isKit(item: InventoryItem): boolean {
    if (!item.data) return false;
    const root = fieldsOf(item.data.snbt);
    const marked =
        item.data.era === "components"
            ? fieldsOf(root.get("minecraft:custom_data") ?? root.get("custom_data") ?? "")
            : root;
    return readInt(marked.get("polaris_event")) === 1;
}

/** A compound's own members by key, its nested ones left whole. */
function fieldsOf(snbt: string): Map<string, string> {
    const fields = new Map<string, string>();
    const text = snbt.trim();
    if (!text.startsWith("{") || !text.endsWith("}")) return fields;
    for (const field of splitTopLevel(text.slice(1, -1))) {
        const colon = topLevelColon(field);
        if (colon === -1) continue;
        fields.set(unquote(field.slice(0, colon)), field.slice(colon + 1).trim());
    }
    return fields;
}

/** A stack as the game holds an item - `{id, count, components}` - for building
 *  it in storage. Only for the component era: its holder hands an item over by
 *  its `contents` slot, which a tag-era server is not known to have. */
export function stackValue(item: InventoryItem): string | null {
    if (item.data?.era !== "components") return null;
    return `{id:${JSON.stringify(item.id)},count:${item.count},components:${item.data.snbt}}`;
}

/** The lines that build a stack too long for one command in storage under
 *  `key`; null when no number of commands can. */
export function longLines(key: string, item: InventoryItem): string[] | null {
    const value = stackValue(item);
    return value ? storage.storeLines(key, value) : null;
}

/** Written back with one command: `item replace ... with` carries it whole. */
export function fitsOneLine(item: InventoryItem): boolean {
    return itemArgument(item).ok;
}

/**
 * Whether a stack can be taken and given back whole: it sits in one of the 41
 * slots every version has, and a command - or several, through storage - writes
 * it back exactly. A modded slot, or a stack with one piece longer than any
 * command, cannot; the player who carries one is kept out instead.
 */
export function takeable(item: InventoryItem): boolean {
    return (
        SLOTS.includes(item.slot) &&
        replaceSlot(item.slot) !== null &&
        (fitsOneLine(item) || longLines(longKey("00000000", item.slot), item) !== null)
    );
}

/**
 * Where a stack taken is written down to go back to: its own slot, or - when a
 * stack taken before it already went from there, one picked up into a slot
 * just emptied - the first slot nobody is owed, the bag before the hotbar
 * before what is worn. Null when every slot is owed already.
 */
export function slotFor(slot: number, owed: ReadonlySet<number>): number | null {
    if (!owed.has(slot)) return slot;
    const order = [
        ...SLOTS.filter((one) => one >= 9 && one <= 35),
        ...SLOTS.filter((one) => one >= 0 && one <= 8),
        ...SLOTS.filter((one) => one >= 100 || one < 0)
    ];
    return order.find((one) => !owed.has(one)) ?? null;
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

/**
 * Whether `now` is `wanted`, as the game can say it back. The game keeps the
 * points into the next level as a fraction of that level, a float, and answers
 * `xp query ... points` rounded down from it: some values come back one point
 * under what was set - 235 points at level 49 reads 234, 16 at level 112 reads
 * 15. Asking for the exact number called experience that was given back not
 * given back, and a retry from the panel then gave it a second time.
 */
export function sameExperience(now: Experience, wanted: Experience): boolean {
    return now.levels === wanted.levels && Math.abs(now.points - wanted.points) <= 1;
}

/** Their experience set to exactly this: levels first, then the points into the next. */
export function setExperience(name: string, experience: Experience): string[] {
    return [
        `xp set ${name} ${experience.levels} levels`,
        `xp set ${name} ${experience.points} points`
    ];
}

/** Their experience added to: the levels, then the points - which run on into
 *  the next level as the game counts them. */
export function addExperience(name: string, experience: Experience): string[] {
    return [
        `xp add ${name} ${experience.levels} levels`,
        `xp add ${name} ${experience.points} points`
    ];
}

// ------------------------------------------------------------------ vitals
//
// Vanilla refuses `data modify` on a player, so health and hunger are put back
// with what the game itself does to them: Instant Health at amplifier 10 heals to full,
// `damage ... minecraft:generic_kill` takes off the exact rest (it passes
// armor, Protection and Resistance, and scales with nothing without an
// attacker), Saturation adds `n` food and `2n` saturation at once, and Hunger
// adds 0.005 * (amplifier + 1) exhaustion a tick - every 4 of it costs one
// saturation point, or one food point once saturation is gone.

/** The player's numbers each read on its own, in `Vitals` order, then absorption. */
export function readVitals(name: string): string[] {
    return [
        `data get entity ${name} Health`,
        `data get entity ${name} foodLevel`,
        `data get entity ${name} foodSaturationLevel`,
        `data get entity ${name} foodExhaustionLevel`,
        `data get entity ${name} AbsorptionAmount`
    ];
}

/** `Ana has the following entity data: 17.5f`. Null when it is not that answer. */
export function readEntityNumber(output: string): number | null {
    const match = /has the following entity data: (-?\d+(?:\.\d+)?(?:E-?\d+)?)[bsLfdBSFD]?\s*$/.exec(
        output.trim()
    );
    return match ? Number(match[1]) : null;
}

/** Hunger's most exhaustion in a second: amplifier 255, 20 ticks. */
const HUNGER_PER_SECOND = 0.1 * 256;

/** Hunger for as few whole seconds as add `exhaustion`, as close as a tenth a
 *  second allows. Null for nothing worth adding. */
export function hungerFor(exhaustion: number): { seconds: number; amplifier: number } | null {
    if (exhaustion < 0.05) return null;
    const seconds = Math.ceil(exhaustion / HUNGER_PER_SECOND);
    const amplifier = Math.min(255, Math.max(0, Math.round(exhaustion / (0.1 * seconds)) - 1));
    return { seconds, amplifier };
}

export function hungerLines(name: string, hunger: { seconds: number; amplifier: number }): string[] {
    return [
        endHunger(name),
        `effect give ${name} minecraft:hunger ${hunger.seconds} ${hunger.amplifier} true`
    ];
}

/** Hunger stopped, whatever is left of it. */
export function endHunger(name: string): string {
    return `effect clear ${name} minecraft:hunger`;
}

/** Saturation given once: `points` food and twice as much saturation, each
 *  held to the game's 20 and to the food level. */
export function feedLine(name: string, points: number): string {
    return `effect give ${name} minecraft:saturation 1 ${points - 1} true`;
}

/** Healed to full: Instant Health heals 4 << amplifier - 4096 at X. */
export function healLine(name: string): string {
    return `effect give ${name} minecraft:instant_health 1 10 true`;
}

/** Exactly `amount` off their health, absorption first. */
export function hurtLine(name: string, amount: number): string {
    return `damage ${name} ${Number(amount.toFixed(4))} minecraft:generic_kill`;
}

/**
 * The next step from `now` towards `wanted` food, saturation and exhaustion:
 * Saturation can only add, and only food and saturation together; Hunger can
 * only take away, saturation first. So a level that must come down, or a
 * saturation Saturation cannot reach on top of what is there, is first drained
 * to `wanted.food - ceil(saturation / 2)` with nothing left, then fed back up
 * to the food level, and the saturation left over drained a point at a time
 * with the exhaustion wanted on top.
 */
export function foodStep(
    now: Pick<Vitals, "food" | "saturation" | "exhaustion">,
    wanted: Pick<Vitals, "food" | "saturation" | "exhaustion">
):
    | { kind: "drain"; exhaustion: number }
    | { kind: "feed"; points: number }
    | null {
    const reachable = Math.min(now.saturation + 2 * (wanted.food - now.food), wanted.food);
    if (now.food > wanted.food || reachable < wanted.saturation - 0.01) {
        const floor = Math.max(wanted.food - Math.ceil(wanted.saturation / 2 - 0.0001), 0);
        const points = Math.ceil(now.saturation - 0.0001) + Math.max(now.food - floor, 0);
        if (points > 0) return drain(points, now.exhaustion, wanted.exhaustion);
    }
    if (now.food < wanted.food) return { kind: "feed", points: wanted.food - now.food };
    const over = Math.max(Math.floor(now.saturation - wanted.saturation + 0.0001), 0);
    return drain(over, now.exhaustion, wanted.exhaustion);
}

/**
 * Hunger for `points` points with `wanted` exhaustion left over. A point goes
 * only past 4, not at it, so what is left is kept a tenth off either edge -
 * twice Hunger's error over one second. More than a second's worth is only
 * as exact as a twentieth a second, so it stops halfway into the last point
 * and leaves that one, and the exact rest, to a step of its own.
 */
function drain(
    points: number,
    exhaustion: number,
    wanted: number
): { kind: "drain"; exhaustion: number } | null {
    const rest = points > 0 ? Math.min(Math.max(wanted, 0.1), 3.9) : wanted;
    const whole = 4 * points + rest - exhaustion;
    if (whole > HUNGER_PER_SECOND) return { kind: "drain", exhaustion: 4 * points - exhaustion - 2 };
    return whole >= 0.05 ? { kind: "drain", exhaustion: whole } : null;
}

/**
 * Whether `now` is `wanted` as closely as the game lets it be put: health to
 * a hundredth, the food level exactly, saturation from what it was to under a
 * point over (Hunger takes it a whole point at a time), and exhaustion - which
 * nothing lowers - to a tenth or two under, and anything over.
 */
export function sameVitals(now: Vitals, wanted: Vitals): boolean {
    return (
        Math.abs(now.health - wanted.health) <= 0.01 &&
        now.food === wanted.food &&
        now.saturation >= wanted.saturation - 0.01 &&
        now.saturation < wanted.saturation + 1 &&
        now.exhaustion >= wanted.exhaustion - 0.25
    );
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
export function dropLines(
    name: string,
    item: InventoryItem,
    record: string | null
): string[] | null {
    const tag = dropTag(record, item.slot);
    const it = `@e[type=minecraft:item,tag=${tag}]`;
    const tail = `Tags:["${tag}"],PickupDelay:32767,Age:-32768`;
    const modern = `execute unless entity ${it} at ${name} run summon minecraft:item ~ ~ ~ {Item:{id:"${item.id}",count:${item.count}${item.data?.era === "components" ? `,components:${item.data.snbt}` : ""}},${tail}}`;
    const legacy = `execute unless entity ${it} at ${name} run summon minecraft:item ~ ~ ~ {Item:{id:"${item.id}",Count:${item.count}b${item.data?.era === "tag" ? `,tag:${item.data.snbt}` : ""}},${tail}}`;
    const lines =
        item.data === null
            ? [modern, legacy]
            : item.data.era === "components"
              ? [modern]
              : [legacy];
    return lines.every((line) => commandBytes(line) <= COMMAND_BYTES_MAX) ? lines : null;
}

/** The storage key, and the tag of the item display, a stack too long for one
 *  command is handed over through: one per stash and slot. */
export function longKey(record: string | null, slot: number): string {
    return dropTag(record, slot).replace("pe_gb", "gb");
}

export function holdTag(record: string | null, slot: number): string {
    return dropTag(record, slot).replace("pe_gb", "pe_hd");
}

/**
 * A kept stack too long for one command, dropped at the player's feet as
 * theirs: built in storage, an item summoned there unless the one dropped
 * before is still lying there, and filled from storage. Null when no number
 * of commands can write it.
 */
export function longDropLines(
    name: string,
    item: InventoryItem,
    record: string | null
): string[] | null {
    const key = longKey(record, item.slot);
    const build = longLines(key, item);
    if (!build) return null;
    const tag = dropTag(record, item.slot);
    const it = `@e[type=minecraft:item,tag=${tag}]`;
    return [
        ...build,
        `execute unless entity ${it} at ${name} run summon minecraft:item ~ ~ ~ {Item:{id:"minecraft:stone",count:1},Tags:["${tag}"],PickupDelay:32767,Age:-32768}`,
        storage.fillItemLine(`@e[type=minecraft:item,tag=${tag},limit=1]`, key),
        storage.forgetLine(key)
    ];
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
