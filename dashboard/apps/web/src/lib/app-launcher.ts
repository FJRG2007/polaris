/**
 * What the app menu draws, in what order, and how the favorites behind it are
 * stored.
 *
 * Built for the account with thirty apps as much as for the one with three. The
 * menu opens on the apps somebody reaches for - their favorites, in the order
 * they arranged them, then the few they opened most recently - and files every
 * other app on a shelf by what it is for (`APP_CATEGORIES`), so a long list reads
 * as six short ones. Each app is drawn once. Typing narrows all of it to what
 * matches instead (see the switcher).
 *
 * Pure and safe in the browser: the switcher computes the layout where the
 * recent history lives, and the server validates a save against the same schema.
 */

import { z } from "zod";
import { APP_CATEGORIES, OVERVIEW_APP_ID, POLARIS_APPS, type AppCategory } from "@/lib/apps";

/** How many apps the Overview rail lists for somebody with no favorites yet:
 *  enough to hold what most people use daily, short enough to stay a rail. */
export const LAUNCHER_ROW_SIZE = 6;

/** How many recently opened apps get a row of their own: one row of the grid. */
export const RECENT_APPS = 3;

/** How many apps can be favorites. Every app there is, and not one more. */
export const MAX_FAVORITE_APPS = POLARIS_APPS.length;

/** The ids an app can be a favorite by: every app the switcher can list. */
const PINNABLE = new Set(POLARIS_APPS.filter((app) => !app.hidden).map((app) => app.id));

const REGISTRY_CATEGORY = new Map<string, AppCategory>(
    POLARIS_APPS.map((app) => [app.id, app.category])
);

export const favoriteAppsSchema = z
    .array(
        z
            .string()
            .trim()
            .refine((id) => PINNABLE.has(id), "That app does not exist.")
    )
    .max(MAX_FAVORITE_APPS)
    .refine((ids) => new Set(ids).size === ids.length, "An app can only be pinned once.");

/** Read a stored list back. Anything unparseable is nothing pinned: a preference
 *  is not worth failing a page load over. An app that can no longer be pinned -
 *  renamed, removed, hidden - drops out on its own, and the rest stay pinned. */
export function parseFavoriteApps(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = z.array(z.unknown()).safeParse(JSON.parse(raw));
        if (!parsed.success) return [];
        const ids = parsed.data.flatMap((id) =>
            typeof id === "string" && PINNABLE.has(id.trim()) ? [id.trim()] : []
        );
        return [...new Set(ids)].slice(0, MAX_FAVORITE_APPS);
    } catch {
        return [];
    }
}

export interface LauncherShelf {
    readonly category: AppCategory;
    readonly ids: readonly string[];
}

export interface LauncherLayout {
    /** The favorites this account can open, in the order they were arranged. */
    readonly favorites: readonly string[];
    /** Opened lately and not already a favorite, most recent first. */
    readonly recent: readonly string[];
    /** Everything else, on its shelf, shelves in `APP_CATEGORIES` order and each
     *  shelf in registry order. Empty shelves are left out. */
    readonly shelves: readonly LauncherShelf[];
}

/**
 * Split the apps somebody can open into favorites, recent and the shelves.
 *
 * `available` is what they may open, in registry order, and is applied to
 * everything else: a favorite kept from when the account held a permission, or a
 * recent visit from before an app was uninstalled, is not a door to draw.
 * Favorites are never cut short - somebody who chose twelve asked for twelve.
 */
export function launcherLayout({
    available,
    favorites,
    recent,
    categoryOf = (id) => REGISTRY_CATEGORY.get(id)
}: {
    available: readonly string[];
    favorites: readonly string[];
    /** App ids, most recent first. Repeats are fine. */
    recent: readonly string[];
    /** Which shelf an id goes on. The registry's answer unless a caller lists
     *  apps the registry does not hold. Unknown ids go on the last shelf. */
    categoryOf?: (id: string) => AppCategory | undefined;
}): LauncherLayout {
    const open = new Set(available);
    const placed = new Set<string>();
    const take = (ids: readonly string[], limit = Infinity) => {
        const out: string[] = [];
        for (const id of ids) {
            if (out.length >= limit) break;
            if (!open.has(id) || placed.has(id)) continue;
            placed.add(id);
            out.push(id);
        }
        return out;
    };
    const pinned = take(favorites);
    const lately = take(recent, RECENT_APPS);
    const fallback = APP_CATEGORIES[APP_CATEGORIES.length - 1]!.id;
    const shelves = APP_CATEGORIES.map((category) => ({
        category: category.id,
        ids: available.filter(
            (id) => !placed.has(id) && (categoryOf(id) ?? fallback) === category.id
        )
    })).filter((shelf) => shelf.ids.length > 0);
    return { favorites: pinned, recent: lately, shelves };
}

/**
 * The apps the Overview's rail lists: the favorites, or for somebody who has
 * none yet the first few they can open. The Overview itself is left out - it is
 * the screen the rail is drawn on.
 */
export function railApps({
    available,
    favorites
}: {
    available: readonly string[];
    favorites: readonly string[];
}): string[] {
    const open = available.filter((id) => id !== OVERVIEW_APP_ID);
    const chosen = favorites.filter((id, at) => open.includes(id) && favorites.indexOf(id) === at);
    return chosen.length > 0 ? chosen : open.slice(0, LAUNCHER_ROW_SIZE);
}

/** `ids` with `id` moved `by` places, clamped to the ends. The same list when
 *  it would not move, so a caller can tell a no-op by identity. */
export function moveFavorite(ids: readonly string[], id: string, by: number): readonly string[] {
    const from = ids.indexOf(id);
    if (from < 0) return ids;
    const to = Math.max(0, Math.min(ids.length - 1, from + by));
    if (to === from) return ids;
    const next = ids.filter((other) => other !== id);
    next.splice(to, 0, id);
    return next;
}

/**
 * The stored favorites rearranged to the order somebody sees.
 *
 * What is on screen is only the favorites this account can open today; the
 * stored list can hold more (an app taken away for a week stays a favorite for
 * when it comes back). So the visible ones are put in their new order in the
 * slots they already occupied, and every other entry keeps its place.
 */
export function arrangeFavorites(stored: readonly string[], visible: readonly string[]): string[] {
    const shown = new Set(visible);
    let next = 0;
    return stored.map((id) => (shown.has(id) ? (visible[next++] ?? id) : id));
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((id, at) => id === right[at]);
}
