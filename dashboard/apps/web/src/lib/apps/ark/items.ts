/**
 * ARK items, as the game names them and as the panel draws them.
 *
 * The game's own vocabulary here is three names for one thing: an operator says
 * "Metal Ingot", the picture on disk is keyed by the item's class
 * (`PrimalItemResource_MetalIngot`), and the command that hands one over wants the
 * blueprint path the class lives at. So the catalogue carries all three and
 * nothing else has to know how they line up.
 *
 * The class is the key rather than the name because two items can share a name -
 * a mission variant of a gun is called the same thing as the gun - and the class
 * is what the game distinguishes them by.
 *
 * Where the catalogue comes from is documented in `resources/arkicons`: the item
 * data is extracted from the game's own assets by Project Purlovia and the
 * pictures come from the community wiki, both vendored rather than fetched so
 * nothing here talks to anybody at runtime.
 */

import { searchCatalog, type SearchableItem } from "@/lib/apps/catalog-search";

/** An item's class, which is what the picture is named after and what a screen
 *  sends back. Deliberately strict: it is turned into a URL and looked up in a
 *  catalogue, and it arrives from a browser. */
export const ARK_ITEM_KEY = /^[A-Za-z0-9_]{1,80}$/;

/**
 * A blueprint path as the game writes it, without the trailing `_C` and without
 * the `Blueprint'…'` wrapper.
 *
 * Proved rather than trusted, because this ends up inside a console command. The
 * catalogue is Polaris' own file, so this is not the security boundary - that is
 * the class key, which is what a browser is allowed to send - but a bad line in a
 * regenerated catalogue should fail here rather than reach a server.
 */
export const ARK_BLUEPRINT_PATH = /^\/Game\/[A-Za-z0-9_./-]{3,200}$/;

/** Where the staged pictures and the browser's copy of the catalogue are served
 *  from. Written by `copy-arkicons-assets.mjs` at build time. */
const ICON_BASE = "/arkicons";

export const ARK_ITEM_CATALOG_URL = `${ICON_BASE}/items.json`;

/** One entry as a screen holds it: what to send, what it is called, and how many
 *  of it go in a stack. */
export interface ArkItem extends SearchableItem {
    /** The item's class. */
    readonly id: string;
    readonly label: string;
    readonly search: string;
    /** How many the game puts in one stack, which is what turns a quantity into
     *  "three stacks" on the way past. */
    readonly stack: number;
    /** Behind the ones there is a picture of. About one item in eight has none -
     *  event portals, boss summons, things that were never released - and a grid
     *  led by empty boxes reads as a broken screen rather than as a real list. */
    readonly rank: number;
}

/** The manifest as the picker uses it. Anything that is not a list of items is an
 *  empty catalogue: the picker says the pictures did not load rather than drawing
 *  an empty grid it cannot explain. */
export function readArkItemCatalog(manifest: unknown): ArkItem[] {
    if (!Array.isArray(manifest)) return [];
    const items: ArkItem[] = [];
    for (const entry of manifest) {
        if (typeof entry !== "object" || entry === null) continue;
        const { key, name, stack, icon } = entry as {
            key?: unknown;
            name?: unknown;
            stack?: unknown;
            icon?: unknown;
        };
        if (typeof key !== "string" || !ARK_ITEM_KEY.test(key)) continue;
        if (typeof name !== "string" || name.length === 0) continue;
        items.push({
            id: key,
            label: name,
            // The class as well as the name: an operator who knows the game reads
            // "ArrowTranq" in a mod's notes and types that, and the name on the
            // wiki is "Tranquilizer Arrow".
            search: `${name.toLowerCase()} ${key.toLowerCase()}`,
            stack: typeof stack === "number" && Number.isFinite(stack) ? Math.max(1, Math.trunc(stack)) : 1,
            // The manifest only says so when there is no picture, so anything that
            // does not deny it has one.
            rank: icon === false ? 1 : 0
        });
    }
    // The ones that draw first, and alphabetically within that. This is the order
    // the grid opens on before anybody searches, and it is the difference between
    // a first screen of items and a first screen of placeholders.
    return items.sort((left, right) => left.rank - right.rank || left.label.localeCompare(right.label));
}

/** The picture for an item's class. Always a URL: an item the set has no picture
 *  for resolves to one that 404s, which the slot draws as a placeholder - the same
 *  way the Minecraft grid handles an item nobody has drawn yet. */
export function arkItemIconUrl(key: string): string | null {
    return ARK_ITEM_KEY.test(key) ? `${ICON_BASE}/${key}.webp` : null;
}

/** The entries matching what somebody typed, best first. */
export function searchArkItems(items: readonly ArkItem[], query: string, limit: number): ArkItem[] {
    return searchCatalog(items, query, limit);
}

/**
 * The most of one thing that can be handed over at once.
 *
 * Not a limit the game has - it is a limit on a typo. A quantity is typed into a
 * box, and an extra nought on a resource is a server spending the next minute
 * making sixty thousand of something and a player who cannot move for weight.
 */
export const MAX_ARK_GIVE = 1000;

/** How good the item arrives. Zero is what a survivor crafts with no skill;
 *  higher is the ascendant end of the same scale. The ceiling is well past
 *  anything the game hands out on its own. */
export const MAX_ARK_QUALITY = 100;

/** How many stacks a quantity actually arrives as. The game splits them itself -
 *  this only counts them. */
export function arkStackCount(stack: number, quantity: number): number {
    const size = Math.max(1, Math.trunc(stack));
    return Math.ceil(Math.max(0, Math.trunc(quantity)) / size);
}

/**
 * How a quantity lands, for the sentence under the field.
 *
 * The count on its own was being read out as "2 stacks of 100", which is a
 * sentence that says two hundred. Ask for a hundred and twenty-five and that is
 * what it said - so the line under the box contradicted the number in the box,
 * and the one that was right was the box. Somebody trusting the sentence hands
 * out an amount nobody asked for.
 *
 * So the remainder is named. A quantity that fills its stacks exactly still
 * reads as before, because there is nothing left over to say.
 *
 * Null when it all fits in one stack: there is no split to describe, and a line
 * saying so is a line in the way.
 */
export function describeArkStacks(stack: number, quantity: number): string | null {
    const size = Math.max(1, Math.trunc(stack));
    const total = Math.max(0, Math.trunc(quantity));
    if (total <= size) return null;
    // Gear does not stack at all, so counting it in stacks of one is arithmetic
    // rather than English. Five swords are five swords.
    if (size === 1) return `Arrives as ${total} separate pieces.`;
    const full = Math.trunc(total / size);
    const rest = total - full * size;
    const stacks = full === 1 ? `a stack of ${size}` : `${full} stacks of ${size}`;
    return rest === 0
        ? `Arrives as ${stacks}.`
        : `Arrives as ${stacks} and ${rest}.`;
}

export interface ArkGive {
    /** The in-game player id, which is a number and not the Steam id. */
    readonly playerId: string;
    readonly blueprintPath: string;
    readonly quantity: number;
    readonly quality: number;
    /** Hand over the blueprint for the thing rather than the thing. */
    readonly blueprint: boolean;
}

/**
 * The console command that gives somebody an item.
 *
 * `GiveItemToPlayer` rather than `GiveItem` or `GFI`: those two put the item in
 * the inventory of whoever ran them, and nobody ran this - Polaris speaks to the
 * server over RCON, where there is no character to give anything to. The one that
 * names its target is the only one that means anything from here.
 *
 * The path is wrapped the way the game's own admin lists write it: quoted, inside
 * `Blueprint'…'`, and stopping at the object rather than at the generated class.
 */
export function arkGiveCommand(give: ArkGive): string {
    if (!/^\d{1,20}$/.test(give.playerId)) throw new Error("That is not an in-game player id");
    if (!ARK_BLUEPRINT_PATH.test(give.blueprintPath)) throw new Error("That is not an item");
    const quantity = Math.max(1, Math.min(MAX_ARK_GIVE, Math.trunc(give.quantity)));
    const quality = Math.max(0, Math.min(MAX_ARK_QUALITY, Math.trunc(give.quality)));
    return [
        "GiveItemToPlayer",
        give.playerId,
        `"Blueprint'${give.blueprintPath}'"`,
        String(quantity),
        String(quality),
        give.blueprint ? "1" : "0"
    ].join(" ");
}
