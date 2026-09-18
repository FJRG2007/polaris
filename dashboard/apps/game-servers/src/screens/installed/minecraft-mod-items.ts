"use client";

/**
 * What the server's mods add, as the panel holds it.
 *
 * The vanilla catalogue is a static file and is the same on every server; this is
 * the other half, and it is per server - it depends on which mods are on that
 * one's list. So it is fetched from the server's own route, once per server for
 * a few minutes at a time, and appended to the grid when it arrives rather than
 * waited for: the picker draws its 1396 vanilla pictures immediately either way.
 *
 * The pictures are kept in a map beside the catalogue because two different
 * screens draw them and only one of them knows which server it is looking at. The
 * picker asks for the catalogue; the inventory grid just has item ids in its slots
 * and needs a picture for each. Rather than thread the install through every slot,
 * the map is shared and the icons subscribe to it, so a bag full of SecurityCraft
 * fills in as soon as the catalogue lands.
 *
 * Keyed by item id alone. Two servers running different builds of the same mod
 * would share an entry, which is the same picture drawn from a different build -
 * and both builds' pictures stay addressable, so nothing breaks either way.
 */

import {
    ITEM_CATALOG_URL,
    itemName,
    modCatalogItems,
    modItemPicture,
    readItemCatalog,
    readModItems,
    type CatalogItem,
    type ItemPicture
} from "../../lib/minecraft/items";

/** The vanilla manifest never changes between deploys, so it is fetched once per
 *  tab and every later picker opens against what is already in memory. */
let vanilla: Promise<CatalogItem[]> | null = null;

export function loadVanillaItems(): Promise<CatalogItem[]> {
    vanilla ??= fetch(ITEM_CATALOG_URL)
        .then((response) => {
            if (!response.ok) throw new Error(`The item list answered ${response.status}`);
            return response.json();
        })
        .then(readItemCatalog)
        .catch((caught: unknown) => {
            // Not cached as a failure: the picker degrades to a typed id, and the
            // next open should be allowed to try again rather than inherit this.
            vanilla = null;
            throw caught;
        });
    return vanilla;
}

/** What one server's mods add, and what could not be read. */
export interface ModItemsLoad {
    readonly items: CatalogItem[];
    /** A sentence for the picker, or null when there is nothing to say. */
    readonly note: string | null;
}

/**
 * How long one server's answer is reused.
 *
 * The picker is opened over and over while somebody fills a bag, and re-asking
 * every time would be a request per open for a list that changes when the mod
 * list does. Short enough that a mod added on the other screen shows up without
 * a reload.
 */
const TTL_MS = 5 * 60_000;

const loads = new Map<string, { at: number; load: Promise<ModItemsLoad> }>();
const pictures = new Map<string, ItemPicture>();
const listeners = new Set<() => void>();

/** Bumped whenever pictures arrive, which is what the icons watch. */
let filled = 0;

/**
 * The modded items for one server.
 *
 * Reading the server's mod list means asking Modrinth for builds and reading
 * jars, so the first call on a modded server takes a few seconds and every call
 * after it is the cache.
 *
 * Never rejects. A server with no mods, a route that failed, a dashboard that
 * cannot reach Modrinth - all of them are no modded items, which leaves the
 * picker exactly as it was before this existed.
 */
export function loadModItems(installedAppId: string): Promise<ModItemsLoad> {
    const held = loads.get(installedAppId);
    if (held && Date.now() - held.at < TTL_MS) return held.load;
    const load = fetchModItems(installedAppId).catch(() => {
        // Not kept as a failure, for the reason the vanilla loader does not keep
        // one either: the next open should be allowed to try rather than inherit
        // this one. It still resolves - a picker with no modded items is where
        // this started, and not something to fail a grid over.
        loads.delete(installedAppId);
        return { items: [], note: null };
    });
    loads.set(installedAppId, { at: Date.now(), load });
    return load;
}

async function fetchModItems(installedAppId: string): Promise<ModItemsLoad> {
    const [known, response] = await Promise.all([
        loadVanillaItems().catch(() => [] as CatalogItem[]),
        fetch(`/api/apps/installed/${encodeURIComponent(installedAppId)}/minecraft/items`, {
            cache: "no-store"
        })
    ]);
    if (!response.ok) throw new Error(`The mod items answered ${response.status}`);
    const payload: unknown = await response.json();
    const items = readModItems(payload);
    const names = new Set(known.map((item) => itemName(item.id)));

    for (const item of items) {
        const picture = modItemPicture(item, installedAppId, names);
        if (picture !== null) pictures.set(item.id, picture);
    }
    if (items.length > 0) {
        filled += 1;
        for (const listener of listeners) listener();
    }

    // A half-read answer is kept only until the next open: the server reads what
    // it did not reach then, and a five-minute cache would be the rest of the
    // server's mods missing until somebody reloaded the tab.
    if ((payload as { complete?: unknown } | null)?.complete === false) {
        loads.delete(installedAppId);
    }

    return { items: modCatalogItems(items), note: noteFor(payload, items.length) };
}

/**
 * The line under the grid.
 *
 * Which says the modded items are there at all, and that is the point of it: they
 * are ranked behind the vanilla ones, so an operator who types nothing sees the
 * same 120 vanilla tiles they saw before and concludes their mods are still
 * missing. Naming the mod to type is what turns the catalogue into something
 * findable rather than something that has to be guessed at.
 *
 * Nothing at all on a server with no mods, which is where this started.
 */
export function noteFor(payload: unknown, found: number): string | null {
    const lines: string[] = [];
    if (found > 0) {
        lines.push(
            `Also searching ${found} items this server's mods add. Type a mod's name for just those.`
        );
    }
    const answer = payload as { unread?: unknown; skipped?: unknown; complete?: unknown } | null;
    const unread = namesIn(answer?.unread);
    if (unread !== null) {
        lines.push(`Could not read the items ${unread} adds. They can still be typed as ids.`);
    }
    const skipped = namesIn(answer?.skipped);
    if (skipped !== null) {
        lines.push(
            `Not searching ${skipped}: only the first mods on a long list are read. They can still be typed as ids.`
        );
    }
    if (answer?.complete === false) {
        lines.push("Some mods are still being read. Open the picker again to see their items.");
    }
    return lines.length > 0 ? lines.join(" ") : null;
}

/** Up to four names from a list in the answer, and how many more there are. */
function namesIn(list: unknown): string | null {
    const names = Array.isArray(list)
        ? list.filter((name): name is string => typeof name === "string")
        : [];
    if (names.length === 0) return null;
    const shown = names.slice(0, 4).join(", ");
    return names.length > 4 ? `${shown} and ${names.length - 4} more` : shown;
}

/** Drop everything held, so a test starts from the state a fresh tab is in. */
export function forgetModItems(): void {
    loads.clear();
    pictures.clear();
}

/** The picture for a modded item, once its server's catalogue has been read. */
export function modItemPictureFor(id: string): ItemPicture | null {
    return pictures.get(id) ?? null;
}

export function subscribeModItems(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function modItemsVersion(): number {
    return filled;
}

/** Nothing has been fetched while the markup is being rendered on the server, and
 *  saying so keeps the first client render identical to it. */
export function noModItems(): number {
    return 0;
}
