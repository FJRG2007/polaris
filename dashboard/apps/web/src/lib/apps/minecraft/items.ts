/**
 * Items, as the game names them and as the panel draws them.
 *
 * Two audiences read an item id and neither reads it the same way. A command
 * wants `minecraft:diamond_sword`; an operator wants a sword. So one place turns
 * one into the other - the canonical id, the words for it, and the picture -
 * rather than each screen doing its own `replace(/^minecraft:/, "")`.
 *
 * The pictures are the vendored McIcons set (resources/mcicons), staged into
 * public/mcicons at build time and named after the id. That naming is the whole
 * lookup: there is no table to keep in step, and an id the set does not cover
 * resolves to a URL that 404s, which the slot renders as a placeholder.
 */

import Fuse from "fuse.js";

/** An item id as the game writes it, the namespace optional because `give Alice
 *  stone` is what an operator types. Shared with the form and the server action so
 *  all three agree on what is typeable. */
export const ITEM_ID_PATTERN = /^(?:[a-z0-9_.-]+:)?[a-z0-9_.-]{1,64}$/;

/** Where the staged icon set is served from. */
const ICON_BASE = "/mcicons";

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
 *  labelled by. */
export interface CatalogItem {
    /** Namespaced, ready for `give`. */
    readonly id: string;
    readonly label: string;
    /** Lowercase words, so "diamond sword" and "diamond_sword" both match. */
    readonly search: string;
}

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

/**
 * How far a fuzzy match may stray. Low enough that a query naming nothing still
 * finds nothing - an operator typing "beacon" into a catalogue without one wants
 * to be told so, not handed five things that share four letters with it.
 */
const FUZZY_THRESHOLD = 0.3;

/**
 * The fuzzy index for one catalogue, built once.
 *
 * Keyed on the array itself rather than rebuilt per keystroke: the catalogue is
 * ~1400 entries and is fetched once per tab, so the index outlives every search
 * run against it. Weak, so a catalogue that is replaced is not kept alive by its
 * own index.
 */
const fuzzyIndexes = new WeakMap<readonly CatalogItem[], Fuse<CatalogItem>>();

function fuzzyIndex(items: readonly CatalogItem[]): Fuse<CatalogItem> {
    let index = fuzzyIndexes.get(items);
    if (!index) {
        index = new Fuse(items, {
            keys: ["label", "search", "id"],
            threshold: FUZZY_THRESHOLD,
            // The word somebody wants is rarely the first one in the id, so where
            // in the string it matched must not decide whether it matched at all.
            ignoreLocation: true
        });
        fuzzyIndexes.set(items, index);
    }
    return index;
}

/**
 * The catalog entries matching what somebody typed, best first.
 *
 * "Best" is where the match starts: an operator typing "diamond" wants the
 * diamond before the diamond-encrusted everything else, and a list that buries it
 * under `block_of_diamond` is one they scroll past their own answer in. So what
 * literally contains the query is ranked first and by exactly that rule.
 *
 * A typo contains nothing, though, and "dimaond" is the query that made this a
 * search box rather than a filter. So a query that matched nothing literally is
 * asked of a fuzzy index instead of coming back empty.
 *
 * Only then. Fuzzy hits appended to a literal answer would mean "diamond sw" -
 * which names one item exactly - dragging in every other diamond behind it, and
 * an operator who typed enough to be precise should be answered precisely.
 */
export function searchItems(items: readonly CatalogItem[], query: string, limit: number): CatalogItem[] {
    const needle = query.trim().toLowerCase().replace(/[\s_]+/g, " ");
    if (needle.length === 0) return items.slice(0, limit);
    const scored: { item: CatalogItem; score: number }[] = [];
    for (const item of items) {
        const haystack = item.search.replace(/_/g, " ");
        const at = haystack.indexOf(needle);
        if (at === -1) continue;
        // Exact, then starts-with, then a word boundary, then anywhere.
        const score = item.label.toLowerCase() === needle ? 0 : at === 0 ? 1 : haystack[at - 1] === " " ? 2 : 3;
        scored.push({ item, score });
    }
    scored.sort((left, right) => left.score - right.score || left.item.label.localeCompare(right.item.label));
    if (scored.length > 0) return scored.slice(0, limit).map((entry) => entry.item);
    return fuzzyIndex(items)
        .search(needle, { limit })
        .map((hit) => hit.item);
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
    if (name.startsWith("bucket_of") || ONE_AT_A_TIME.some((word) => endsWithWord(name, word))) return 1;
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
