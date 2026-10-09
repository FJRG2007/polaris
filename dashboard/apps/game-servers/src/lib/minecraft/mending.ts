/**
 * Experience a prize pays, spent first on the player's worn-down Mending gear.
 *
 * Somebody near the end of the game carries a Mending sword and armour, and a
 * prize of levels on the bar is of little use to them; what the experience
 * would have done for them is repair. So before a prize of levels goes on the
 * bar, the experience it is worth is counted in points - from the level they
 * are at, as the game charges each level (`pointsFor`) - and spent at the
 * game's own rate, two points of durability a point of experience, on every
 * damaged item with Mending they carry, the hotbar and the bag included, not
 * only what they hold and wear as an orb would. What is left goes on the bar
 * as points. Nothing to repair - no Mending, or all of it whole - and the
 * prize is the levels, exactly as before.
 *
 * Only on a server whose items are components (1.20.5 on): the damage is
 * read off `minecraft:damage` and written back with an inline item modifier,
 * and each write first checks the slot still holds that item at that damage
 * (`execute if items`), so an item the player moved in between is never
 * touched. What was repaired is read back, not assumed: an older server, or
 * one that refuses the modifier, repairs nothing and pays the levels.
 *
 * Pure: the plan, the lines and the reading. `delivery` does the talking.
 */

import { replaceSlot } from "./item-argument";
import type { InventoryItem } from "./inventory";
import { ARMOUR_SLOTS, OFFHAND_SLOT } from "./inventory";
import { readInt, splitTopLevel, topLevelColon, unquote } from "./snbt";

/** Durability one point of experience repairs, as Mending does. */
export const DURABILITY_PER_POINT = 2;

/** Points from `level` to the next, as the game charges them. */
export function pointsToNext(level: number): number {
    if (level <= 15) return 2 * level + 7;
    if (level <= 30) return 5 * level - 38;
    return 9 * level - 158;
}

/** Points `levels` more levels are worth to somebody at `level`. */
export function pointsFor(level: number, levels: number): number {
    let total = 0;
    for (let at = Math.max(0, level); at < Math.max(0, level) + levels; at += 1)
        total += pointsToNext(at);
    return total;
}

/** The fewest whole levels from `level` worth at least `points`. */
export function levelsFor(level: number, points: number): number {
    let levels = 0;
    let left = points;
    while (left > 0) {
        left -= pointsToNext(level + levels);
        levels += 1;
    }
    return levels;
}

/** A damaged item with Mending, where it is. */
export interface Worn {
    readonly slot: number;
    readonly id: string;
    readonly damage: number;
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

/** Whether an enchantments component names Mending: `{levels: {...}}` up to
 *  1.21.4, the bare map after. A stored enchantment - a book - is another
 *  component, and never counts. */
function hasMending(enchantments: string | undefined): boolean {
    if (!enchantments) return false;
    const fields = fieldsOf(enchantments);
    const levels = fields.has("levels") ? fieldsOf(fields.get("levels")!) : fields;
    return (readInt(levels.get("minecraft:mending")) ?? 0) > 0;
}

/** Every damaged item with Mending in a bag: what it is, where, how worn. A
 *  slot no command can name is left out. */
export function wornMending(items: readonly InventoryItem[]): Worn[] {
    const worn: Worn[] = [];
    for (const item of items) {
        if (item.data?.era !== "components" || replaceSlot(item.slot) === null) continue;
        const fields = fieldsOf(item.data.snbt);
        if (!hasMending(fields.get("minecraft:enchantments"))) continue;
        const damage = readInt(fields.get("minecraft:damage")) ?? 0;
        if (damage > 0) worn.push({ slot: item.slot, id: item.id, damage });
    }
    return worn;
}

/** What is held and worn comes first, as an orb would mend it; then the most worn. */
function rank(item: Worn): number {
    return ARMOUR_SLOTS.includes(item.slot) || item.slot === OFFHAND_SLOT || item.slot <= 8 ? 0 : 1;
}

/** One repair: the damage the item should be left at, and the points it costs. */
export interface Repair extends Worn {
    readonly to: number;
    readonly points: number;
}

/** The repairs `points` pay for, held and worn first, then the most worn. */
export function plan(worn: readonly Worn[], points: number): Repair[] {
    const repairs: Repair[] = [];
    let left = points;
    const order = [...worn].sort((a, b) => rank(a) - rank(b) || b.damage - a.damage);
    for (const item of order) {
        if (left <= 0) break;
        const mended = Math.min(item.damage, left * DURABILITY_PER_POINT);
        const cost = Math.ceil(mended / DURABILITY_PER_POINT);
        repairs.push({ ...item, to: item.damage - mended, points: cost });
        left -= cost;
    }
    return repairs;
}

/** The line that sets one item's damage - only while that slot still holds it
 *  exactly as it was read. */
export function repairLine(name: string, repair: Repair): string {
    const slot = replaceSlot(repair.slot)!;
    return `execute if items entity ${name} ${slot} ${repair.id}[minecraft:damage=${repair.damage}] run item modify entity ${name} ${slot} {"function":"minecraft:set_components","components":{"minecraft:damage":${repair.to}}}`;
}

/** Points the repairs really took, from the bag read again after them: an
 *  item counts only if it is still in its slot, and only for what it gained. */
export function pointsTaken(repairs: readonly Repair[], after: readonly InventoryItem[]): number {
    let taken = 0;
    for (const repair of repairs) {
        const now = after.find((item) => item.slot === repair.slot && item.id === repair.id);
        if (!now?.data || now.data.era !== "components") continue;
        const damage = readInt(fieldsOf(now.data.snbt).get("minecraft:damage")) ?? 0;
        const mended = repair.damage - Math.max(damage, repair.to);
        if (mended > 0) taken += Math.ceil(mended / DURABILITY_PER_POINT);
    }
    return taken;
}
