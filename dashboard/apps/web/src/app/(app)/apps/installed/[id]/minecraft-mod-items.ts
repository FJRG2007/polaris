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
} from "@/lib/apps/minecraft/items";

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
    const load = fetchModItems(installedAppId).catch(() => ({ items: [], note: null }));
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

    return { items: modCatalogItems(items), note: unreadNote(payload) };
}

/** What to say about the mods whose jars could not be read. Nothing at all when
 *  they all were, which is the ordinary case. */
function unreadNote(payload: unknown): string | null {
    const unread = (payload as { unread?: unknown } | null)?.unread;
    const names = Array.isArray(unread)
        ? unread.filter((name): name is string => typeof name === "string").slice(0, 4)
        : [];
    if (names.length === 0) return null;
    return `Could not read the items ${names.join(", ")} adds. They can still be typed as ids.`;
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
