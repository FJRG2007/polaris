/**
 * What a stack is besides its id and count, in a shape a screen can show.
 *
 * A slot drawn as a bow says nothing about the bow: an enchanted book is worth
 * opening only for what is stored in it, and two diamond swords are not the
 * same sword. So the stack's own compound is walked for the things a player
 * would read on its tooltip in game - the name somebody typed, its enchantments
 * (or, on a book, the ones it carries to apply), and how worn it is.
 *
 * Both shapes the game has used are read: the components of 1.20.5 and later,
 * and the `tag` before them. Walked rather than matched (see ./snbt): an
 * enchanted book's compound holds ids of its own, and a pattern finds those as
 * readily as the ones it was looking for.
 *
 * Pure.
 */

import type { ItemData } from "./inventory";
import { readInt, splitTopLevel, topLevelColon, unquote } from "./snbt";

export interface Enchantment {
    /** The namespaced id, e.g. "minecraft:sharpness". */
    readonly id: string;
    readonly level: number;
}

export interface ItemDetails {
    /** The name somebody gave it at an anvil or with a command, or null. */
    readonly name: string | null;
    /** What is on the item itself. */
    readonly enchantments: Enchantment[];
    /** What an enchanted book carries to apply to something else. */
    readonly stored: Enchantment[];
    /** How much wear it has taken, or null for an item that has none. */
    readonly damage: number | null;
    /** Its whole durability when the stack states it, or null. */
    readonly maxDamage: number | null;
    readonly unbreakable: boolean;
}

/** A compound's top-level fields, keyed as written (quotes removed). */
function fieldsOf(compound: string): Map<string, string> {
    const fields = new Map<string, string>();
    const body = compound.trim();
    if (!body.startsWith("{") || !body.endsWith("}")) return fields;
    for (const field of splitTopLevel(body.slice(1, -1))) {
        const colon = topLevelColon(field);
        if (colon === -1) continue;
        fields.set(unquote(field.slice(0, colon)), field.slice(colon + 1).trim());
    }
    return fields;
}

/** A list's entries, or none when the value is not a list. */
function entriesOf(list: string | undefined): string[] {
    const body = list?.trim();
    if (!body || !body.startsWith("[") || !body.endsWith("]")) return [];
    return splitTopLevel(body.slice(1, -1)).map((entry) => entry.trim());
}

/** The namespaced form of an enchantment id, whichever way it was written. */
function namespaced(id: string): string {
    return id.includes(":") ? id : `minecraft:${id}`;
}

/**
 * The enchantments in one component: `{levels: {"minecraft:sharpness": 5}}` up
 * to 1.21.4, and `{"minecraft:sharpness": 5}` from 1.21.5 on.
 */
function fromComponent(value: string | undefined): Enchantment[] {
    if (!value) return [];
    const outer = fieldsOf(value);
    const levels = outer.has("levels") ? fieldsOf(outer.get("levels")!) : outer;
    const found: Enchantment[] = [];
    for (const [id, raw] of levels) {
        const level = readInt(raw);
        if (id && level !== null) found.push({ id: namespaced(id), level });
    }
    return found;
}

/** The enchantments in the older list shape: `[{id: "minecraft:sharpness", lvl: 5s}]`. */
function fromList(value: string | undefined): Enchantment[] {
    const found: Enchantment[] = [];
    for (const entry of entriesOf(value)) {
        const fields = fieldsOf(entry);
        const id = unquote(fields.get("id") ?? "");
        const level = readInt(fields.get("lvl"));
        if (id && level !== null) found.push({ id: namespaced(id), level });
    }
    return found;
}

/**
 * The words of a name, however it was stored: a JSON text component in a
 * string (up to 1.21.4), an SNBT text compound (1.21.5 on), or plain text.
 */
function nameFrom(value: string | undefined): string | null {
    if (!value) return null;
    const text = value.trim().startsWith("{") ? value.trim() : unquote(value);
    // A JSON text component can also be a bare JSON string: '"Excalibur"'.
    if (text.startsWith('"')) {
        try {
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed === "string") return parsed || null;
        } catch {
            return text;
        }
    }
    if (!text.startsWith("{")) return text || null;
    try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "text" in parsed) {
            const words = (parsed as { text: unknown }).text;
            if (typeof words === "string" && words) return words;
        }
    } catch {
        // Not JSON: an SNBT compound, read below.
    }
    const words = fieldsOf(text).get("text");
    return words ? unquote(words) || null : null;
}

/** Everything worth showing about a stack's data. A stack with none has none. */
export function itemDetails(data: ItemData | null): ItemDetails {
    const empty: ItemDetails = {
        name: null,
        enchantments: [],
        stored: [],
        damage: null,
        maxDamage: null,
        unbreakable: false
    };
    if (!data) return empty;
    const fields = fieldsOf(data.snbt);
    if (data.era === "components") {
        const damage = readInt(fields.get("minecraft:damage"));
        return {
            name: nameFrom(fields.get("minecraft:custom_name")),
            enchantments: fromComponent(fields.get("minecraft:enchantments")),
            stored: fromComponent(fields.get("minecraft:stored_enchantments")),
            damage: damage && damage > 0 ? damage : null,
            maxDamage: readInt(fields.get("minecraft:max_damage")),
            unbreakable: fields.has("minecraft:unbreakable")
        };
    }
    const display = fieldsOf(fields.get("display") ?? "");
    const damage = readInt(fields.get("Damage"));
    return {
        name: nameFrom(display.get("Name")),
        enchantments: fromList(fields.get("Enchantments")),
        stored: fromList(fields.get("StoredEnchantments")),
        damage: damage && damage > 0 ? damage : null,
        maxDamage: null,
        unbreakable: readInt(fields.get("Unbreakable")) === 1
    };
}

/** Whether the stack has anything worth a second line under its name. */
export function hasDetails(details: ItemDetails): boolean {
    return (
        details.name !== null ||
        details.enchantments.length > 0 ||
        details.stored.length > 0 ||
        details.damage !== null ||
        details.unbreakable
    );
}

const ROMAN: readonly [number, string][] = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"]
];

/** A level the way the game prints it: Roman up to the ones it ever draws, and
 *  digits past that, where Roman numerals stop being read at a glance. */
export function levelText(level: number): string {
    if (level < 1 || level > 10) return String(level);
    let left = level;
    let text = "";
    for (const [value, numeral] of ROMAN) {
        while (left >= value) {
            text += numeral;
            left -= value;
        }
    }
    return text;
}

/** "minecraft:fire_protection" as "Fire Protection", the way items are named. */
export function enchantmentLabel(id: string): string {
    return (id.split(":").pop() ?? id)
        .split("_")
        .filter((word) => word.length > 0)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

/** One enchantment as the game writes it: "Sharpness V". */
export function enchantmentText(enchantment: Enchantment): string {
    return `${enchantmentLabel(enchantment.id)} ${levelText(enchantment.level)}`;
}
