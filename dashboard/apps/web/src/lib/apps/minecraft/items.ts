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
 * The catalog entries matching what somebody typed, best first.
 *
 * "Best" is where the match starts: an operator typing "diamond" wants the
 * diamond before the diamond-encrusted everything else, and a list that buries it
 * under `block_of_diamond` is one they scroll past their own answer in.
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
    return scored.slice(0, limit).map((entry) => entry.item);
}
