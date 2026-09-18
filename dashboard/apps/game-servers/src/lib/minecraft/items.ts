/**
 * Items, as the game names them and as the panel draws them.
 *
 * Two audiences read an item id and neither reads it the same way. A command
 * wants `minecraft:diamond_sword`; an operator wants a sword. So one place turns
 * one into the other - the canonical id, the words for it, and the picture -
 * rather than each screen doing its own `replace(/^minecraft:/, "")`.
 *
 * The pictures are the vendored McIcons set (resources/mcicons), shipped in this
 * app's bundle (scripts/stage-assets.mjs) and named after the id. That naming is the whole
 * lookup: there is no table to keep in step, and an id the set does not cover
 * resolves to a URL that 404s, which the slot renders as a placeholder.
 */

import { z } from "zod";
import { searchCatalog, type SearchableItem } from "@polaris/core/catalog-search";

/** An item id as the game writes it, the namespace optional because `give Alice
 *  stone` is what an operator types. Shared with the form and the server action so
 *  all three agree on what is typeable. */
export const ITEM_ID_PATTERN = /^(?:[a-z0-9_.-]+:)?[a-z0-9_.-]{1,64}$/;

/** Where the staged icon set is served from. */
const ICON_BASE = "/api/app-bundles/game-servers/current/assets/mcicons";

/** The namespace the icon set covers, and the one an unqualified id belongs to. */
const VANILLA = "minecraft";

/**
 * An id in the one form everything else here expects: lowercase, trimmed, and
 * namespaced.
 *
 * Returns null for anything that is not an item id, so a caller cannot build a
 * URL or a command out of arbitrary text.
 */
export function normalizeItemId(raw: string): string | null {
    const value = raw.trim().toLowerCase();
    if (!ITEM_ID_PATTERN.test(value)) return null;
    return value.includes(":") ? value : `${VANILLA}:${value}`;
}

/**
 * The id somebody typed, when what they typed was an id at all.
 *
 * The namespace is what tells the two apart. Left to `normalizeItemId`, half a
 * word on the way to "diamond_sword" is a well-formed id - `minecraft:swor` -
 * and a search box that hands one of those to `give` on the Enter key is a
 * failed command an operator did not ask for. Writing the namespace is the
 * deliberate act, and it is also how a modded id gets in, which is the reason
 * typing is still allowed at all.
 */
export function typedItemId(raw: string): string | null {
    return raw.includes(":") ? normalizeItemId(raw) : null;
}

/** The id without its namespace, which is what the set is named after and what an
 *  operator recognises. */
export function itemName(id: string): string {
    const colon = id.indexOf(":");
    return colon === -1 ? id : id.slice(colon + 1);
}

/**
 * The picture for an item, or null when there cannot be one.
 *
 * Only the vanilla namespace: a modded id names an item this set never had, and a
 * URL built out of it would 404 on every render rather than fall back once.
 */
export function itemIconUrl(id: string): string | null {
    const normalized = normalizeItemId(id);
    if (normalized === null || !normalized.startsWith(`${VANILLA}:`)) return null;
    return `${ICON_BASE}/${VANILLA}_${itemName(normalized)}.png`;
}

/** The item in words - "diamond_sword" reads as "Diamond Sword". Derived rather
 *  than listed: 1400 hand-written labels would be 1400 chances to disagree with
 *  the id underneath them. */
export function itemLabel(id: string): string {
    return itemName(id)
        .split("_")
        .filter((word) => word.length > 0)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
}

/** Where the ids the icon set covers are listed, written by the staging script. */
export const ITEM_CATALOG_URL = `${ICON_BASE}/items.json`;

/** One entry of the picker's catalog: the id to send, and what it is searched and
 *  labelled by. The same shape every game panel searches, so the ranking lives in
 *  one place and this does not carry a second copy of the fields. */
export type CatalogItem = SearchableItem;

/** The manifest as the picker uses it. Anything that is not a list of item names
 *  is an empty catalog: the picker falls back to a typed id, which is what it was
 *  before there was a catalog at all. */
export function readItemCatalog(manifest: unknown): CatalogItem[] {
    if (!Array.isArray(manifest)) return [];
    const items: CatalogItem[] = [];
    for (const entry of manifest) {
        if (typeof entry !== "string") continue;
        const id = normalizeItemId(entry);
        if (id === null) continue;
        const label = itemLabel(id);
        items.push({ id, label, search: `${label.toLowerCase()} ${itemName(id)}` });
    }
    return items;
}

/** The largest a texture may claim to be. A 16x16 is the normal one; past this
 *  is an atlas or a lie, and neither belongs in an inventory slot. */
export const MAX_TEXTURE_SIDE = 4096;

/**
 * Where an item's picture comes from.
 *
 * Spelled out once, as a schema rather than as a type, because all three places
 * that handle it handle bytes somebody else wrote: the reader that pulls it out
 * of a downloaded jar, the cache file it is written into and read back from, and
 * the panel that receives it over the API. A shape written down three times is
 * three things to keep in step; this is one, and it is checked at every crossing.
 */
export const modItemIconSchema = z.union([
    /** A PNG carried by the jar, kept under `name`, at its own pixel size - which
     *  the panel needs because a mod texture is not always square. */
    z.object({
        kind: z.literal("mod"),
        name: z.string().refine(isIconName),
        width: z.number().int().positive().max(MAX_TEXTURE_SIDE),
        height: z.number().int().positive().max(MAX_TEXTURE_SIDE)
    }),
    /** A texture the jar does not carry, as the model names it - `block/stone`.
     *  Resolved against the vendored vanilla set by `vanillaTextureName`. */
    z.object({ kind: z.literal("vanilla"), texture: z.string().max(200) })
]);

export type ModItemIcon = z.infer<typeof modItemIconSchema>;

/** One item a mod adds, as it is read out of the jar and written back out of the
 *  cache. */
export const modItemSchema = z.object({
    /** Namespaced, ready for `give`. */
    id: z.string().max(160),
    /** What the game calls it, in the language the panel is in. */
    label: z.string().max(120),
    icon: modItemIconSchema.nullable()
});

export type ModItem = z.infer<typeof modItemSchema>;

/**
 * One item a mod adds, as the server's own route reports it.
 *
 * Read out of the mod's jar rather than off the running server, so it is the same
 * answer whether the server is up or not. `icon` is either a picture kept beside
 * the build it came out of, or the vanilla texture the mod's model points at -
 * most of what a mod adds is a variation on something the game already draws.
 */
export interface ModItemView extends ModItem {
    /** Which mod, by the name on the server's list. */
    readonly mod: string;
    /** The build its picture is kept under. */
    readonly build: string;
}

/** A picture and how to draw it. Mod textures are not always square - an animated
 *  one is a column of frames, a connected one a row of variants - and a strip
 *  squashed into a slot is a smear, so the first square of it is drawn instead. */
export interface ItemPicture {
    readonly url: string;
    readonly width: number;
    readonly height: number;
}

/**
 * What a build and a kept picture may be named.
 *
 * Here rather than beside the code that reads the jars, because both sides of
 * this check the same two shapes and a rule spelled out twice is a rule that
 * drifts: the panel puts them into a URL, and the route puts them into a path.
 *
 * A build is a jar's SHA-1. A picture's name is one path segment with no
 * separator and no `..` in it, so it can only ever name a file in the one folder
 * it is looked for in.
 */
const BUILD = /^[0-9a-f]{40}$/;
const ICON_NAME = /^[a-z0-9_.-]{1,180}$/;

export function isBuildKey(value: string): boolean {
    return BUILD.test(value);
}

export function isIconName(name: string): boolean {
    return ICON_NAME.test(name) && !name.includes("..");
}

/** The modded items out of whatever the route answered. Anything that is not one
 *  is dropped rather than rendered: it is a list the panel draws pictures and
 *  commands out of. */
export function readModItems(payload: unknown): ModItemView[] {
    const rows = (payload as { items?: unknown } | null)?.items;
    if (!Array.isArray(rows)) return [];
    const items: ModItemView[] = [];
    for (const row of rows) {
        if (row === null || typeof row !== "object") continue;
        const entry = row as Record<string, unknown>;
        const id = typeof entry.id === "string" ? normalizeItemId(entry.id) : null;
        if (id === null || id.startsWith(`${VANILLA}:`)) continue;
        items.push({
            id,
            label:
                typeof entry.label === "string" && entry.label.length > 0
                    ? entry.label
                    : itemLabel(id),
            mod: typeof entry.mod === "string" ? entry.mod : "",
            build: typeof entry.build === "string" && isBuildKey(entry.build) ? entry.build : "",
            icon: readModIcon(entry.icon)
        });
    }
    return items;
}

function readModIcon(value: unknown): ModItemIcon | null {
    const parsed = modItemIconSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** The modded items as catalog entries, searchable beside the vanilla ones. The
 *  mod's name is searched too, so "securitycraft" finds everything it adds. */
export function modCatalogItems(items: readonly ModItemView[]): CatalogItem[] {
    return items.map((item) => ({
        id: item.id,
        label: item.label,
        // The namespace as well as the mod's name on the list, because the two are
        // spelled differently and an operator has only ever seen one of them:
        // SecurityCraft is `security-craft` on the mod list and `securitycraft` in
        // every id it registers, and a search box that answers only to the first
        // is one the obvious query misses.
        search: `${item.label.toLowerCase()} ${itemName(item.id)} ${modNamespace(item.id)} ${item.mod.toLowerCase()}`
            .replace(/\s+/g, " ")
            .trim(),
        // Behind the vanilla entry of the same name, so a search for "stone"
        // answers with stone before it answers with a mod's version of it.
        rank: 1,
        ...(item.mod.length > 0 ? { from: item.mod } : {})
    }));
}

/** The namespace an id belongs to, which is the other name a mod goes by. */
function modNamespace(id: string): string {
    const colon = id.indexOf(":");
    return colon === -1 ? "" : id.slice(0, colon);
}

/**
 * The picture for a modded item, or null when nothing can draw it.
 *
 * Two kinds, and the caller only sees a URL: one kept beside the build it was
 * read out of, and one the mod borrows from the game, which Polaris already
 * ships. The vanilla one is checked against the set that is actually on disk,
 * because a name that is not in it is a broken image rather than a picture.
 */
export function modItemPicture(
    item: ModItemView,
    installedAppId: string,
    vanilla: ReadonlySet<string>
): ItemPicture | null {
    if (item.icon === null) return null;
    if (item.icon.kind === "vanilla") {
        const name = vanillaTextureName(item.icon.texture, vanilla);
        return name === null
            ? null
            : { url: `${ICON_BASE}/${VANILLA}_${name}.png`, width: 1, height: 1 };
    }
    if (!isBuildKey(item.build)) return null;
    const asked = new URLSearchParams({ build: item.build, name: item.icon.name });
    return {
        url: `/api/apps/installed/${encodeURIComponent(installedAppId)}/minecraft/items/icon?${asked.toString()}`,
        width: item.icon.width,
        height: item.icon.height
    };
}

/**
 * The vanilla item whose picture stands in for a texture a mod points at.
 *
 * The vendored set is rendered item icons, and a model names a block face -
 * `block/quartz_block_side` - so the face is dropped before looking. Checked
 * against the set rather than assumed.
 */
export function vanillaTextureName(texture: string, known: ReadonlySet<string>): string | null {
    const name = texture.split("/").pop() ?? texture;
    if (known.has(name)) return name;
    for (const suffix of ["_side", "_top", "_bottom", "_front", "_end", "_inner", "_outer"]) {
        if (!name.endsWith(suffix)) continue;
        const trimmed = name.slice(0, -suffix.length);
        if (known.has(trimmed)) return trimmed;
    }
    return null;
}

/**
 * How a picture is sized inside a square slot.
 *
 * A square one fills it. Anything else is drawn at the scale that makes its
 * shorter side fill the slot and cropped to the first square - the top frame of
 * an animation, the first variant of a connected texture - which is the one the
 * game itself shows on an item in a hand.
 */
export function pictureFit(picture: ItemPicture): { width: string; height: string } | null {
    const side = Math.min(picture.width, picture.height);
    if (side <= 0 || picture.width === picture.height) return null;
    return {
        width: `${(picture.width / side) * 100}%`,
        height: `${(picture.height / side) * 100}%`
    };
}

/** The catalog entries matching what somebody typed, best first - see
 *  `catalog-search`, which is where the ranking lives now that ARK's items are
 *  searched the same way. */
export function searchItems(
    items: readonly CatalogItem[],
    query: string,
    limit: number
): CatalogItem[] {
    return searchCatalog(items, query, limit);
}

/**
 * How many of an item fit in one stack.
 *
 * The catalogue is a directory listing of icons - ids and nothing else - so this
 * is derived from the id rather than looked up. Only the exceptions to
 * sixty-four are worth encoding: the things that come one at a time, and the
 * sixteens. Everything else is sixty-four, and the server clamps whatever this
 * gets wrong, so the cost of a miss is an amount somebody retypes rather than an
 * item that goes missing.
 */
const ONE_AT_A_TIME: readonly string[] = [
    "sword",
    "pickaxe",
    "axe",
    "shovel",
    "hoe",
    "helmet",
    "chestplate",
    "leggings",
    "boots",
    "boat",
    "minecart",
    "bed",
    "horse_armor",
    "shield",
    "bow",
    "crossbow",
    "elytra",
    "saddle",
    "cake",
    "potion",
    "bucket",
    "shears",
    "flint_and_steel",
    "fishing_rod",
    "trident",
    "totem_of_undying",
    "written_book",
    "writable_book",
    "enchanted_book"
];

const SIXTEEN: readonly string[] = [
    "ender_pearl",
    "snowball",
    "egg",
    "sign",
    "hanging_sign",
    "armor_stand",
    "honey_bottle",
    "bucket_of"
];

/** The trailing word of an id, which is what names the kind of thing it is:
 *  `diamond_sword` is a sword, `bucket_of_axolotl` is a bucket. */
function endsWithWord(name: string, word: string): boolean {
    return name === word || name.endsWith(`_${word}`);
}

export function maxStackFor(id: string): number {
    const name = itemName(normalizeItemId(id) ?? id);
    if (name.startsWith("bucket_of") || ONE_AT_A_TIME.some((word) => endsWithWord(name, word)))
        return 1;
    if (SIXTEEN.some((word) => endsWithWord(name, word))) return 16;
    return 64;
}

/**
 * A total, cut into the stacks it actually arrives as.
 *
 * Asking for 128 diamonds is asking for two stacks, and saying so is the whole
 * job: `/give` takes a count, but what a player receives is stacks, and a tool
 * that refused anything over 64 made somebody press the button twice for a
 * number they had already typed once. Items that do not stack are the reason
 * this reads the size per item rather than assuming 64 - 128 saddles is 128
 * stacks of one, and pretending otherwise hands out two.
 */
export function stacksFor(id: string, total: number): number[] {
    const size = maxStackFor(id);
    const stacks: number[] = [];
    for (let left = Math.max(0, Math.trunc(total)); left > 0; left -= size) {
        stacks.push(Math.min(size, left));
    }
    return stacks;
}
