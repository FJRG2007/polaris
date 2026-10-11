/**
 * Enchantments: which exist, which an item takes, and how a stack is written
 * with a different set of them.
 *
 * The game has written enchantments three ways a server here can still be
 * running, and an argument in the wrong one is refused or, worse, read as
 * something else:
 *
 * - `tag`: 1.13 to 1.20.4, `id{Enchantments:[{id:"minecraft:sharpness",lvl:5s}]}`.
 * - `levels`: 1.20.5 to 1.21.4, `id[minecraft:enchantments={levels:{...}}]`.
 * - `map`: 1.21.5 on, `id[minecraft:enchantments={...}]`.
 *
 * An enchanted book keeps what it carries apart from what is on it, as
 * `StoredEnchantments` / `minecraft:stored_enchantments`, and that is the set
 * edited on one.
 *
 * A stack is never rebuilt from scratch. Its own compound is walked and only the
 * one enchantment field is replaced, so the name on it, the wear and anything a
 * mod put there go back as they came. When the existing field holds something
 * this cannot read back exactly, the edit is refused rather than guessed at.
 *
 * Pure and browser-safe: the dialog validates with the same schema the action
 * does, and offers what the same catalogue says fits.
 */

import { z } from "zod";
import { gameMessage } from "../game-message";
import type { InventoryItem, ItemData } from "./inventory";
import { itemDetails, type Enchantment } from "./item-details";
import { splitTopLevel, topLevelColon, unquote } from "./snbt";

/** How a server writes enchantments. See the module comment. */
export type EnchantFormat = "tag" | "levels" | "map";

/** The highest level a command takes, whatever the enchantment. */
export const MAX_ENCHANT_LEVEL = 255;

/** How many enchantments one stack is allowed to carry through here. */
export const MAX_ENCHANTMENTS = 64;

/** What kind of item an enchantment fits, by what the item is. */
export type ItemKind =
    | "helmet"
    | "chestplate"
    | "leggings"
    | "boots"
    | "sword"
    | "axe"
    | "pickaxe"
    | "shovel"
    | "hoe"
    | "bow"
    | "crossbow"
    | "trident"
    | "mace"
    | "fishing_rod"
    | "shears"
    | "elytra"
    | "shield"
    | "durable"
    | "head"
    | "compass";

export interface EnchantmentInfo {
    /** The namespaced id, as written from 1.20.5 on. */
    readonly id: string;
    /** The highest level the game itself hands out. */
    readonly max: number;
    /** What it goes on. */
    readonly fits: readonly ItemKind[];
    /** The version that added it, where that is past 1.13. */
    readonly since?: readonly number[];
    /** Its id before 1.20.5, where that was different. */
    readonly legacyId?: string;
    /** Enchantments sharing a group cannot be on one item together in game. */
    readonly groups?: readonly string[];
}

const ARMOUR: readonly ItemKind[] = ["helmet", "chestplate", "leggings", "boots"];
const DURABLE: readonly ItemKind[] = [
    ...ARMOUR,
    "sword",
    "axe",
    "pickaxe",
    "shovel",
    "hoe",
    "bow",
    "crossbow",
    "trident",
    "mace",
    "fishing_rod",
    "shears",
    "elytra",
    "shield",
    "durable"
];
const DIGGERS: readonly ItemKind[] = ["axe", "pickaxe", "shovel", "hoe"];

/** Every enchantment vanilla Java has, from 1.13 on. */
export const ENCHANTMENTS: readonly EnchantmentInfo[] = [
    { id: "minecraft:protection", max: 4, fits: ARMOUR, groups: ["protection"] },
    { id: "minecraft:fire_protection", max: 4, fits: ARMOUR, groups: ["protection"] },
    { id: "minecraft:blast_protection", max: 4, fits: ARMOUR, groups: ["protection"] },
    { id: "minecraft:projectile_protection", max: 4, fits: ARMOUR, groups: ["protection"] },
    { id: "minecraft:feather_falling", max: 4, fits: ["boots"] },
    { id: "minecraft:respiration", max: 3, fits: ["helmet"] },
    { id: "minecraft:aqua_affinity", max: 1, fits: ["helmet"] },
    { id: "minecraft:thorns", max: 3, fits: ARMOUR },
    { id: "minecraft:depth_strider", max: 3, fits: ["boots"], groups: ["boots-water"] },
    { id: "minecraft:frost_walker", max: 2, fits: ["boots"], groups: ["boots-water"] },
    { id: "minecraft:soul_speed", max: 3, fits: ["boots"], since: [1, 16] },
    { id: "minecraft:swift_sneak", max: 3, fits: ["leggings"], since: [1, 19] },
    { id: "minecraft:sharpness", max: 5, fits: ["sword", "axe"], groups: ["damage"] },
    { id: "minecraft:smite", max: 5, fits: ["sword", "axe", "mace"], groups: ["damage"] },
    {
        id: "minecraft:bane_of_arthropods",
        max: 5,
        fits: ["sword", "axe", "mace"],
        groups: ["damage"]
    },
    { id: "minecraft:knockback", max: 2, fits: ["sword"] },
    { id: "minecraft:fire_aspect", max: 2, fits: ["sword", "mace"] },
    { id: "minecraft:looting", max: 3, fits: ["sword"] },
    {
        id: "minecraft:sweeping_edge",
        max: 3,
        fits: ["sword"],
        legacyId: "minecraft:sweeping"
    },
    { id: "minecraft:efficiency", max: 5, fits: [...DIGGERS, "shears"] },
    { id: "minecraft:silk_touch", max: 1, fits: DIGGERS, groups: ["drops"] },
    { id: "minecraft:fortune", max: 3, fits: DIGGERS, groups: ["drops"] },
    { id: "minecraft:power", max: 5, fits: ["bow"] },
    { id: "minecraft:punch", max: 2, fits: ["bow"] },
    { id: "minecraft:flame", max: 1, fits: ["bow"] },
    { id: "minecraft:infinity", max: 1, fits: ["bow"], groups: ["arrows"] },
    { id: "minecraft:luck_of_the_sea", max: 3, fits: ["fishing_rod"] },
    { id: "minecraft:lure", max: 3, fits: ["fishing_rod"] },
    { id: "minecraft:loyalty", max: 3, fits: ["trident"], groups: ["riptide-loyalty"] },
    { id: "minecraft:impaling", max: 5, fits: ["trident"] },
    {
        id: "minecraft:riptide",
        max: 3,
        fits: ["trident"],
        groups: ["riptide-loyalty", "riptide-channeling"]
    },
    { id: "minecraft:channeling", max: 1, fits: ["trident"], groups: ["riptide-channeling"] },
    { id: "minecraft:multishot", max: 1, fits: ["crossbow"], since: [1, 14], groups: ["bolts"] },
    { id: "minecraft:quick_charge", max: 3, fits: ["crossbow"], since: [1, 14] },
    { id: "minecraft:piercing", max: 4, fits: ["crossbow"], since: [1, 14], groups: ["bolts"] },
    { id: "minecraft:density", max: 5, fits: ["mace"], since: [1, 21], groups: ["damage"] },
    { id: "minecraft:breach", max: 4, fits: ["mace"], since: [1, 21], groups: ["damage"] },
    { id: "minecraft:wind_burst", max: 3, fits: ["mace"], since: [1, 21] },
    { id: "minecraft:unbreaking", max: 3, fits: DURABLE },
    { id: "minecraft:mending", max: 1, fits: DURABLE, groups: ["arrows"] },
    { id: "minecraft:binding_curse", max: 1, fits: [...ARMOUR, "elytra", "head"] },
    { id: "minecraft:vanishing_curse", max: 1, fits: [...DURABLE, "head", "compass"] }
];

const BY_ID = new Map<string, EnchantmentInfo>(
    ENCHANTMENTS.flatMap((info) => [
        [info.id, info] as const,
        ...(info.legacyId ? [[info.legacyId, info] as const] : [])
    ])
);

/** The catalogue entry for an id in either spelling, or null for one a mod added. */
export function enchantmentInfo(id: string): EnchantmentInfo | null {
    return BY_ID.get(namespaced(id)) ?? null;
}

/** The id an enchantment is written with in a format. */
export function enchantmentIdFor(id: string, format: EnchantFormat): string {
    const info = enchantmentInfo(id);
    if (!info) return namespaced(id);
    return format === "tag" && info.legacyId ? info.legacyId : info.id;
}

/** Whether two ids name the same enchantment, whichever spelling each uses. */
export function sameEnchantment(left: string, right: string): boolean {
    const one = enchantmentInfo(left);
    return one ? one === enchantmentInfo(right) : namespaced(left) === namespaced(right);
}

/** How a version writes enchantments; null before 1.13, where ids were numbers. */
export function enchantFormatFor(
    version: string,
    atLeast: (version: string, wanted: readonly number[]) => boolean
): EnchantFormat | null {
    if (atLeast(version, [1, 21, 5])) return "map";
    if (atLeast(version, [1, 20, 5])) return "levels";
    if (atLeast(version, [1, 13])) return "tag";
    return null;
}

/** An enchanted book, which carries enchantments to apply rather than wearing them. */
export function isEnchantedBook(itemId: string): boolean {
    return namespaced(itemId) === "minecraft:enchanted_book";
}

const SUFFIXES: readonly (readonly [string, ItemKind])[] = [
    ["_helmet", "helmet"],
    ["_chestplate", "chestplate"],
    ["_leggings", "leggings"],
    ["_boots", "boots"],
    ["_sword", "sword"],
    ["_axe", "axe"],
    ["_pickaxe", "pickaxe"],
    ["_shovel", "shovel"],
    ["_hoe", "hoe"],
    ["_head", "head"],
    ["_skull", "head"]
];

const WHOLE: Readonly<Record<string, ItemKind>> = {
    bow: "bow",
    crossbow: "crossbow",
    trident: "trident",
    mace: "mace",
    fishing_rod: "fishing_rod",
    shears: "shears",
    elytra: "elytra",
    shield: "shield",
    flint_and_steel: "durable",
    carrot_on_a_stick: "durable",
    warped_fungus_on_a_stick: "durable",
    brush: "durable",
    carved_pumpkin: "head",
    compass: "compass",
    recovery_compass: "compass"
};

/** What kind of item this is, for which enchantments fit it. Read off the id's
 *  own name, so a mod's ruby sword is a sword. Null for anything else. */
export function itemKind(itemId: string): ItemKind | null {
    const name = namespaced(itemId).split(":")[1] ?? "";
    const whole = WHOLE[name];
    if (whole) return whole;
    return SUFFIXES.find(([suffix]) => name.endsWith(suffix))?.[1] ?? null;
}

/**
 * The enchantments a screen offers for an item: what fits it, on this server's
 * version, and that does not clash with what it already has. A book takes any
 * of them. `every` drops the fit and clash rules, which commands do not enforce.
 */
export function offeredEnchantments(
    itemId: string,
    current: readonly Enchantment[],
    available: readonly string[] | null,
    every = false
): EnchantmentInfo[] {
    const kind = itemKind(itemId);
    const book = isEnchantedBook(itemId);
    const taken = new Set(current.flatMap((one) => enchantmentInfo(one.id)?.groups ?? []));
    return ENCHANTMENTS.filter((info) => {
        if (available && !available.includes(info.id)) return false;
        if (current.some((one) => sameEnchantment(one.id, info.id))) return false;
        if (every || book) return true;
        if (!kind || !info.fits.includes(kind)) return false;
        return !(info.groups ?? []).some((group) => taken.has(group));
    });
}

/** The ids a server on this version and format has. With no version, as many as
 *  the format proves: `tag` is before 1.20.5, so nothing from 1.21 on. */
export function availableEnchantments(
    version: string | null,
    format: EnchantFormat,
    atLeast: (version: string, wanted: readonly number[]) => boolean
): string[] {
    return ENCHANTMENTS.filter((info) => {
        if (!info.since) return true;
        if (version !== null) return atLeast(version, info.since);
        return format !== "tag" || atLeast("1.20.4", info.since);
    }).map((info) => info.id);
}

/** The enchantments a stack has that an edit changes: what a book carries, or
 *  what is on anything else. */
export function editableEnchantments(item: InventoryItem): Enchantment[] {
    const details = itemDetails(item.data);
    return isEnchantedBook(item.id) ? details.stored : details.enchantments;
}

/** Whether a set has a level past what the game itself hands out. */
export function exceedsMax(list: readonly Enchantment[]): boolean {
    return list.some((one) => {
        const info = enchantmentInfo(one.id);
        return info !== null && one.level > info.max;
    });
}

// ------------------------------------------------------------------ validation

/** One enchantment id, normalised: trimmed, lower case, namespaced. */
const enchantmentIdSchema = z
    .string()
    .trim()
    .toLowerCase()
    .transform((value) => (value.includes(":") ? value : `minecraft:${value}`))
    .pipe(
        z
            .string()
            .regex(
                /^[a-z0-9_.-]{1,64}:[a-z0-9_./-]{1,64}$/,
                gameMessage("minecraft", "enchant.errors.id")
            )
    );

const LEVEL_RULE = gameMessage("minecraft", "enchant.errors.level", { max: MAX_ENCHANT_LEVEL });

const enchantmentSchema = z.object({
    id: enchantmentIdSchema,
    level: z
        .number({ message: LEVEL_RULE })
        .int(LEVEL_RULE)
        .min(1, LEVEL_RULE)
        .max(MAX_ENCHANT_LEVEL, LEVEL_RULE)
});

/** A list of enchantments as a stored or sent request carries it. */
export const enchantmentListSchema = z
    .array(enchantmentSchema)
    .max(
        MAX_ENCHANTMENTS,
        gameMessage("minecraft", "enchant.errors.tooMany", { max: MAX_ENCHANTMENTS })
    );

/**
 * A whole set as a screen asks for it. Over a vanilla maximum only when the
 * request says so, which is the dialog's own switch; a mod's enchantment has no
 * maximum here, so only the command's ceiling applies to it.
 */
export const enchantmentSetSchema = z
    .object({
        enchantments: enchantmentListSchema,
        overMax: z.boolean().default(false)
    })
    .superRefine((value, ctx) => {
        const seen: string[] = [];
        value.enchantments.forEach((one, index) => {
            if (seen.some((other) => sameEnchantment(other, one.id)))
                ctx.addIssue({
                    code: "custom",
                    path: ["enchantments", index],
                    message: gameMessage("minecraft", "enchant.errors.duplicate")
                });
            seen.push(one.id);
            const info = enchantmentInfo(one.id);
            if (!value.overMax && info && one.level > info.max)
                ctx.addIssue({
                    code: "custom",
                    path: ["enchantments", index],
                    message: gameMessage("minecraft", "enchant.errors.overMax", { max: info.max })
                });
        });
    });

export type EnchantmentSet = z.infer<typeof enchantmentSetSchema>;

// ------------------------------------------------------------------ writing

/**
 * The stack with exactly these enchantments, or null when it cannot be written
 * without losing something. `format` decides only what is not already on the
 * stack: an item that has an enchantment field is rewritten in that field's own
 * shape.
 */
export function withEnchantments(
    item: InventoryItem,
    list: readonly Enchantment[],
    format: EnchantFormat
): InventoryItem | null {
    const era = item.data?.era ?? (format === "tag" ? "tag" : "components");
    if ((era === "tag") !== (format === "tag")) return null;
    const book = isEnchantedBook(item.id);
    const data =
        era === "components"
            ? componentsWith(item.data, book, list, format)
            : tagWith(item.data, book, list);
    if (data === undefined) return null;
    return { ...item, data };
}

/** A new stack's argument for `/give`: the item with these enchantments. */
export function enchantedStack(
    itemId: string,
    list: readonly Enchantment[],
    format: EnchantFormat
) {
    return withEnchantments({ slot: 0, id: itemId, count: 1, data: null }, list, format);
}

interface Field {
    readonly key: string;
    readonly raw: string;
    readonly value: string;
}

/** A compound's fields in order, with each key as written. Null when it is not
 *  a compound this can take apart and put back together. */
function fieldsIn(snbt: string): Field[] | null {
    const body = snbt.trim();
    if (!body.startsWith("{") || !body.endsWith("}")) return null;
    const inner = body.slice(1, -1).trim();
    if (inner.length === 0) return [];
    const fields: Field[] = [];
    for (const raw of splitTopLevel(inner)) {
        const colon = topLevelColon(raw);
        if (colon === -1) return null;
        fields.push({
            key: unquote(raw.slice(0, colon)),
            raw: raw.trim(),
            value: raw.slice(colon + 1).trim()
        });
    }
    return fields;
}

/** The compound with one field replaced, added, or - with null - removed. Null
 *  data when nothing is left. */
function replaced(
    data: ItemData | null,
    era: ItemData["era"],
    key: string,
    written: string,
    value: string | null
): ItemData | null | undefined {
    const fields = data ? fieldsIn(data.snbt) : [];
    if (fields === null) return undefined;
    const parts: string[] = [];
    let placed = false;
    for (const field of fields) {
        if (field.key !== key) {
            parts.push(field.raw);
            continue;
        }
        if (placed) return undefined;
        placed = true;
        if (value !== null) parts.push(`${written}:${value}`);
    }
    if (!placed && value !== null) parts.push(`${written}:${value}`);
    return parts.length === 0 ? null : { era, snbt: `{${parts.join(",")}}` };
}

function componentsWith(
    data: ItemData | null,
    book: boolean,
    list: readonly Enchantment[],
    format: EnchantFormat
): ItemData | null | undefined {
    const key = book ? "minecraft:stored_enchantments" : "minecraft:enchantments";
    const levels = list
        .map((one) => `"${enchantmentIdFor(one.id, format)}":${one.level}`)
        .join(",");
    const fields = data ? fieldsIn(data.snbt) : [];
    if (fields === null) return undefined;
    const existing = fields.find((field) => field.key === key);
    // An enchantment taken off the item's own defaults is a component of its
    // own, and this does not know what it would mean to write next to it.
    if (fields.some((field) => field.key === `!${key}`)) return undefined;
    if (list.length === 0) return replaced(data, "components", key, `"${key}"`, null);
    if (!existing)
        return replaced(
            data,
            "components",
            key,
            `"${key}"`,
            format === "levels" ? `{levels:{${levels}}}` : `{${levels}}`
        );
    const outer = fieldsIn(existing.value);
    if (outer === null) return undefined;
    const levelsField = outer.find((field) => field.key === "levels");
    if (!levelsField) {
        // The plain map of 1.21.5: every field has to be an enchantment this
        // read, or rewriting it would drop the one it did not.
        if (!readsWhole(outer)) return undefined;
        return replaced(data, "components", key, `"${key}"`, `{${levels}}`);
    }
    const inner = fieldsIn(levelsField.value);
    if (inner === null || !readsWhole(inner)) return undefined;
    // `show_in_tooltip` and anything else beside the levels goes back as it was.
    const rest = outer.filter((field) => field.key !== "levels").map((field) => field.raw);
    return replaced(
        data,
        "components",
        key,
        `"${key}"`,
        `{${[`levels:{${levels}}`, ...rest].join(",")}}`
    );
}

/** Whether every field of an enchantment map is an id and a whole level. */
function readsWhole(fields: readonly Field[]): boolean {
    return fields.every((field) => field.key.length > 0 && /^\d+[bsiL]?$/i.test(field.value));
}

function tagWith(
    data: ItemData | null,
    book: boolean,
    list: readonly Enchantment[]
): ItemData | null | undefined {
    const key = book ? "StoredEnchantments" : "Enchantments";
    const fields = data ? fieldsIn(data.snbt) : [];
    if (fields === null) return undefined;
    // `ench`, with numeric ids, is before 1.13 and is not written here.
    if (fields.some((field) => field.key === "ench")) return undefined;
    const existing = fields.find((field) => field.key === key);
    if (existing && !tagListReadsWhole(existing.value)) return undefined;
    const entries = list
        .map((one) => `{id:"${enchantmentIdFor(one.id, "tag")}",lvl:${one.level}s}`)
        .join(",");
    return replaced(data, "tag", key, key, list.length === 0 ? null : `[${entries}]`);
}

/** Whether each entry of an old enchantment list is exactly an id and a level. */
function tagListReadsWhole(value: string): boolean {
    const body = value.trim();
    if (!body.startsWith("[") || !body.endsWith("]")) return false;
    const inner = body.slice(1, -1).trim();
    if (inner.length === 0) return true;
    return splitTopLevel(inner).every((entry) => {
        const fields = fieldsIn(entry);
        return (
            fields !== null &&
            fields.length === 2 &&
            fields.some((field) => field.key === "id") &&
            fields.some((field) => field.key === "lvl" && /^\d+[bsiL]?$/i.test(field.value))
        );
    });
}

function namespaced(id: string): string {
    const value = id.trim().toLowerCase();
    return value.includes(":") ? value : `minecraft:${value}`;
}
