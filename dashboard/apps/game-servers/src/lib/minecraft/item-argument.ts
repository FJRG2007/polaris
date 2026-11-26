/**
 * A stack, written back out as a command argument.
 *
 * Reading an inventory is lossy by nature - the reply is prose around SNBT - and
 * writing one back is where that stops being harmless. `/item replace` takes an
 * item argument and builds the stack from scratch, so anything the argument does
 * not say is gone: the enchantments on a sword, the name somebody typed on it,
 * the damage it has taken, what is inside a shulker box.
 *
 * So this never approximates. It re-emits the compound the server itself wrote,
 * unchanged, and when it cannot do that exactly it returns null and the caller
 * refuses the move. A refused drag is a small annoyance; a silently disenchanted
 * sword is somebody's evening.
 *
 * Pure and browser-safe: the editor pre-checks a drag with the same function the
 * action re-checks it with, so a slot that cannot be moved is never draggable in
 * the first place.
 */

import { readBalanced, splitTopLevel, topLevelColon, unquote } from "./snbt";
import {
    ARMOUR_SLOTS,
    HOTBAR_SLOTS,
    MAIN_SLOT_ROWS,
    OFFHAND_SLOT,
    type InventoryItem
} from "./inventory";

/**
 * The per-argument ceiling the transport enforces (see `assertSafeArgument` in
 * ./service). An item argument is one argv element, so a stack whose data does
 * not fit is one this cannot move - a fully enchanted, renamed shulker of tools
 * genuinely exceeds it.
 */
export const MAX_ARGUMENT_LENGTH = 512;

/** What empties a slot. Replacing with air is how the game removes a stack. */
export const AIR = "minecraft:air";

/** Why a stack cannot be written back, in the words the screen uses. */
export type ItemArgumentRefusal = "unreadable" | "too-long";

/**
 * The stack as `/item replace ... with` takes it, or a refusal.
 *
 * Two shapes, and the reply already said which: a componentised server wrote
 * `components: {"minecraft:x": v}` and takes `id[minecraft:x=v]`; an older one
 * wrote `tag: {...}` and takes `id{...}` verbatim.
 */
export function itemArgument(
    item: InventoryItem
): { ok: true; value: string } | { ok: false; why: ItemArgumentRefusal } {
    const built = build(item);
    if (built === null) return { ok: false, why: "unreadable" };
    if (built.length > MAX_ARGUMENT_LENGTH) return { ok: false, why: "too-long" };
    return { ok: true, value: built };
}

/** True when this stack can be written back at all, for a grid deciding whether
 *  a slot may be picked up. */
export function isMovable(item: InventoryItem): boolean {
    return itemArgument(item).ok;
}

function build(item: InventoryItem): string | null {
    const id = item.id.trim();
    if (!id) return null;
    if (!item.data) return id;
    if (item.data.era === "tag") return `${id}${item.data.snbt}`;
    const components = componentList(item.data.snbt);
    return components === null ? null : `${id}[${components}]`;
}

/**
 * `{"minecraft:damage": 5}` as `minecraft:damage=5`.
 *
 * The reply quotes its keys and separates them with a colon; the argument does
 * neither. Values are carried across untouched - they are SNBT on both sides, and
 * the moment this starts interpreting one is the moment it can be wrong about it.
 *
 * The key has to arrive quoted, and that is not fussiness. A component key is
 * namespaced, so it contains a colon of its own: read `minecraft:damage`
 * unquoted and the first colon found is the one inside the key, which silently
 * yields `minecraft=damage` - a component nobody asked for, in place of the one
 * that was there. Vanilla quotes every component key for exactly this reason, so
 * anything that arrives unquoted is a shape this does not recognise and must not
 * guess at.
 */
function componentList(snbt: string): string | null {
    const body = snbt.slice(1, -1).trim();
    if (body.length === 0) return "";
    const parts: string[] = [];
    for (const field of splitTopLevel(body)) {
        if (field[0] !== '"' && field[0] !== "'") return null;
        const colon = topLevelColon(field);
        if (colon === -1) return null;
        const key = unquote(field.slice(0, colon));
        const value = field.slice(colon + 1).trim();
        if (!key || !value) return null;
        // A component taken off the item's own defaults is read back as
        // `"!minecraft:food": {}` and written as the bare `!minecraft:food`:
        // the argument refuses a value after one.
        if (key.startsWith("!")) {
            if (value !== "{}") return null;
            parts.push(key);
            continue;
        }
        parts.push(`${key}=${value}`);
    }
    return parts.join(",");
}

/**
 * Where `/item replace` puts a slot.
 *
 * The command names slots in words while the inventory numbers them, and the two
 * do not line up: the bag is 9-35 in the reply and `inventory.0`-`inventory.26`
 * in the command. Null for a slot the vanilla grid never draws - a modded
 * backpack has a name only that mod knows.
 */
export function replaceSlot(slot: number): string | null {
    if (slot === OFFHAND_SLOT) return "weapon.offhand";
    if (slot >= 0 && slot <= 8) return `hotbar.${slot}`;
    if (slot >= 9 && slot <= 35) return `inventory.${slot - 9}`;
    const armour = ["armor.feet", "armor.legs", "armor.chest", "armor.head"][slot - 100];
    return armour ?? null;
}

/** Every slot the grid draws, which is every slot that can be written to. */
export function writableSlots(): number[] {
    return [...ARMOUR_SLOTS, OFFHAND_SLOT, ...HOTBAR_SLOTS, ...MAIN_SLOT_ROWS.flat()];
}

/** Which way a server writes an item's data, by its version: data components
 *  from Java 1.20.5 on, an NBT compound before it. */
export type ItemDataEra = "components" | "tag";

/** Why data asked for on an item cannot be sent. `wrong-form` is data written
 *  the other era's way. */
export type ItemDataRefusal = "unreadable" | "too-long" | "wrong-form";

/** One component as `/give` takes it: `minecraft:damage=5`, `damage=5`, or the
 *  bare `!minecraft:food` that takes a default one off. */
const COMPONENT_FIELD = /^(?:!(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+|(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+=[\s\S]+)$/;

/**
 * Data somebody asked for on an item - a name, damage, a book's pages -
 * checked and written right after the id, the one shape this server reads
 * (minecraft.wiki/w/Argument_types, `item_stack` and `item_predicate`): from
 * Java 1.20.5, `id[component=value,...]` (minecraft.wiki/w/Data_component_format);
 * before it, the NBT compound as `id{...}`. `/give` and `/clear` both take it,
 * `/clear` as a match on the stacks it removes.
 *
 * The components are taken with or without their brackets, or as the quoted
 * compound an inventory reads them back as (`games_player_inventory`). Data in the other
 * era's form, a bracket or a quote left open, or a control character is
 * refused rather than sent: the server would reject it or read something else.
 */
export function itemDataArgument(
    id: string,
    data: string,
    era: ItemDataEra
): { ok: true; value: string } | { ok: false; why: ItemDataRefusal } {
    const raw = data.trim();
    // eslint-disable-next-line no-control-regex
    if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, why: "unreadable" };
    const built = era === "tag" ? tagArgument(id, raw) : componentsArgument(id, raw);
    if ("why" in built) return { ok: false, why: built.why };
    if (built.value.length > MAX_ARGUMENT_LENGTH) return { ok: false, why: "too-long" };
    return { ok: true, value: built.value };
}

type Built = { value: string } | { why: ItemDataRefusal };

/** `id{...}`: one whole compound, or the refusal. */
function tagArgument(id: string, raw: string): Built {
    if (!raw.startsWith("{")) return { why: "wrong-form" };
    return readBalanced(raw, 0) === raw ? { value: `${id}${raw}` } : { why: "unreadable" };
}

/**
 * `id[a=1,b=2]`, from the list with or without its brackets, or from the
 * components as an inventory reads them back, `{"minecraft:x": v}` - the same
 * data. Any other compound is the older NBT form.
 */
function componentsArgument(id: string, raw: string): Built {
    if (raw.startsWith("{")) {
        if (readBalanced(raw, 0) !== raw) return { why: "unreadable" };
        const read = componentList(raw);
        if (read === null) return { why: "wrong-form" };
        return read ? { value: `${id}[${read}]` } : { why: "unreadable" };
    }
    const list = raw.startsWith("[") ? raw : `[${raw}]`;
    if (readBalanced(list, 0) !== list) return { why: "unreadable" };
    const fields = splitTopLevel(list.slice(1, -1));
    if (fields.length === 0 || !fields.every((field) => COMPONENT_FIELD.test(field)))
        return { why: "unreadable" };
    return { value: `${id}[${fields.join(",")}]` };
}
