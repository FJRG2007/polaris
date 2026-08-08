/**
 * What a player is carrying, out of what the server answers.
 *
 * `data get entity <player> Inventory` replies with SNBT - Minecraft's own
 * notation, close to JSON and not JSON: unquoted keys, type suffixes on numbers
 * (`64b`, `0s`), single-quoted strings, and compounds nested arbitrarily deep
 * inside an item's `components`.
 *
 * That nesting is why this walks the text rather than matching it. An enchanted
 * book carries an `id` inside its own components, and a pattern looking for `id`
 * finds that one as readily as the item's - so the reader tracks depth and quoting
 * and only ever reads the keys of the entry it is actually in.
 *
 * Pure, and no further than it needs to go: an operator wants to see what is in
 * the bag and in which slot, so slots, ids and counts are read and everything
 * else in an entry is stepped over rather than modelled.
 */

/** One stack, as the server reported it. */
export interface InventoryItem {
    /** Where it sits. 0-8 is the hotbar, 100-103 the armour, -106 the offhand. */
    readonly slot: number;
    /** The namespaced id, e.g. "minecraft:diamond_pickaxe". */
    readonly id: string;
    readonly count: number;
}

/** Where a slot number puts the item, in the words the game uses for it. */
export function slotLabel(slot: number): string {
    if (slot === -106) return "Offhand";
    if (slot >= 100 && slot <= 103) return ["Boots", "Leggings", "Chestplate", "Helmet"][slot - 100] ?? "Armour";
    if (slot >= 0 && slot <= 8) return `Hotbar ${slot + 1}`;
    return `Slot ${slot}`;
}

/**
 * The stacks in a `data get entity ... Inventory` reply.
 *
 * Anything that is not that reply - a server that refused, a player who is not
 * on, an empty inventory - is an empty list rather than a throw: this is read to
 * fill a panel, and there is nothing an operator does differently about "no items"
 * and "could not be read" that the panel does not already say.
 */
export function parseInventory(output: string): InventoryItem[] {
    const start = output.indexOf("[");
    if (start === -1) return [];
    const list = readBalanced(output, start);
    if (list === null) return [];
    const items: InventoryItem[] = [];
    for (const entry of splitTopLevel(list.slice(1, -1))) {
        const item = readItem(entry);
        if (item) items.push(item);
    }
    return items.sort((left, right) => left.slot - right.slot);
}

/** The substring from `open` to its matching bracket, quotes respected. Null when
 *  the reply was cut off before it closed. */
function readBalanced(text: string, open: number): string | null {
    const closing = text[open] === "[" ? "]" : "}";
    let depth = 0;
    let quote: string | null = null;
    for (let index = open; index < text.length; index += 1) {
        const character = text[index] as string;
        if (quote) {
            if (character === "\\") index += 1;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") {
            depth -= 1;
            if (depth === 0) return character === closing ? text.slice(open, index + 1) : null;
        }
    }
    return null;
}

/** The comma-separated members of a compound or list body, ignoring the commas
 *  inside nested ones and inside strings. */
function splitTopLevel(body: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let index = 0; index < body.length; index += 1) {
        const character = body[index] as string;
        if (quote) {
            if (character === "\\") index += 1;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") depth -= 1;
        else if (character === "," && depth === 0) {
            parts.push(body.slice(start, index));
            start = index + 1;
        }
    }
    const last = body.slice(start).trim();
    if (last.length > 0) parts.push(last);
    return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** One `{Slot: 0b, id: "minecraft:stone", count: 64}` entry, if it is one. */
function readItem(entry: string): InventoryItem | null {
    if (!entry.startsWith("{")) return null;
    const fields = new Map<string, string>();
    for (const field of splitTopLevel(entry.slice(1, -1))) {
        const colon = topLevelColon(field);
        if (colon === -1) continue;
        fields.set(field.slice(0, colon).trim().toLowerCase(), field.slice(colon + 1).trim());
    }
    const id = unquote(fields.get("id") ?? "");
    if (!id) return null;
    // "Count" in the old shape, "count" in the componentised one; a stack that
    // names neither is a single item, which is how the game writes one.
    return { slot: readNumber(fields.get("slot")) ?? 0, id, count: readNumber(fields.get("count")) ?? 1 };
}

/** The colon separating this field's key from its value, skipping the ones inside
 *  a nested compound or a quoted string. */
function topLevelColon(field: string): number {
    let depth = 0;
    let quote: string | null = null;
    for (let index = 0; index < field.length; index += 1) {
        const character = field[index] as string;
        if (quote) {
            if (character === "\\") index += 1;
            else if (character === quote) quote = null;
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        else if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") depth -= 1;
        else if (character === ":" && depth === 0) return index;
    }
    return -1;
}

function unquote(value: string): string {
    const trimmed = value.trim();
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
        return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return trimmed;
}

/** An SNBT number, which carries its type as a suffix (`64b`, `12s`, `3L`). */
function readNumber(value: string | undefined): number | null {
    if (value === undefined) return null;
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
}
