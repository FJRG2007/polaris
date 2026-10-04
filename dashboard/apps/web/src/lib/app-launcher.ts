/**
 * What the app menu draws, in what order, and how the choices behind it are
 * stored.
 *
 * One grid, the way Google's launcher is one grid: no shelves, no headings. The
 * order is the reader's if they arranged it themselves; otherwise their
 * favorites lead, then the apps they use most, then everything else in the
 * catalogue's order. "Use most" is a decayed count of opens - an open today
 * weighs more than one a month ago - so the order follows what somebody does
 * now rather than what they did once. Typing narrows all of it to what matches
 * instead (see the switcher).
 *
 * Pure and safe in the browser: the switcher computes the order where the usage
 * history lives, and the server validates a save against the same schema.
 */

import { z } from "zod";
import { OVERVIEW_APP_ID, POLARIS_APPS } from "@/lib/apps";

/** How many apps the Overview rail lists for somebody with no favorites yet:
 *  enough to hold what most people use daily, short enough to stay a rail. */
export const LAUNCHER_ROW_SIZE = 6;

/** How many apps can be favorites, or arranged. Every app there is, and not one
 *  more. */
export const MAX_FAVORITE_APPS = POLARIS_APPS.length;

/** How long it takes an open to count half as much as it did. Two weeks: an app
 *  used daily this week outranks one used daily last month within days. */
export const USAGE_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** The ids an app can be a favorite by: every app the switcher can list. */
const PINNABLE = new Set(POLARIS_APPS.filter((app) => !app.hidden).map((app) => app.id));

/** A list of apps in an order: real, listed apps, each once. */
const appListSchema = z
    .array(
        z
            .string()
            .trim()
            .refine((id) => PINNABLE.has(id), "That app does not exist.")
    )
    .max(MAX_FAVORITE_APPS)
    .refine((ids) => new Set(ids).size === ids.length, "An app can only be pinned once.");

/** What an account keeps about its app menu: the favorites, and the order it
 *  arranged the menu in - empty until it arranges it. */
export interface LauncherPrefs {
    readonly favorites: readonly string[];
    readonly order: readonly string[];
}

export const NO_LAUNCHER_PREFS: LauncherPrefs = { favorites: [], order: [] };

/** A save: both lists. A bare list is the favorites alone, which is what a tab
 *  loaded before the menu could be arranged still sends. */
export const launcherPrefsSchema = z.union([
    z.object({ favorites: appListSchema, order: appListSchema }),
    appListSchema
]);

/** The ids of a stored list worth keeping: real apps, each once. */
function keepApps(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const ids = value.flatMap((id) =>
        typeof id === "string" && PINNABLE.has(id.trim()) ? [id.trim()] : []
    );
    return [...new Set(ids)].slice(0, MAX_FAVORITE_APPS);
}

/** Read the stored preferences back. Two shapes are stored: a bare list of
 *  favorites, which is what every account saved before the menu could be
 *  arranged and what one that never arranged it still saves, and an object with
 *  both lists. Anything unparseable is nothing chosen: a preference is not worth
 *  failing a page load over. An app that can no longer be listed - renamed,
 *  removed, hidden - drops out on its own, and the rest keep their order. */
export function parseLauncherPrefs(raw: string | null | undefined): LauncherPrefs {
    if (!raw) return NO_LAUNCHER_PREFS;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) return { favorites: keepApps(parsed), order: [] };
        if (!parsed || typeof parsed !== "object") return NO_LAUNCHER_PREFS;
        const stored = parsed as { favorites?: unknown; order?: unknown };
        return { favorites: keepApps(stored.favorites), order: keepApps(stored.order) };
    } catch {
        return NO_LAUNCHER_PREFS;
    }
}

/** The stored form: the old bare list while nothing has been arranged, so an
 *  account that never arranged its menu stores exactly what it always did, and
 *  nothing at all when there is nothing to keep. */
export function serializeLauncherPrefs(prefs: LauncherPrefs): string | null {
    if (prefs.order.length === 0)
        return prefs.favorites.length > 0 ? JSON.stringify(prefs.favorites) : null;
    return JSON.stringify({ favorites: prefs.favorites, order: prefs.order });
}

/** How much one app has been used: a decayed count of opens as of `at`. */
export interface AppUsageEntry {
    readonly score: number;
    /** When it was last opened, in milliseconds since the epoch. */
    readonly at: number;
}

export type AppUsage = Readonly<Record<string, AppUsageEntry>>;

const appUsageSchema = z.record(
    z.string(),
    z.object({
        score: z.number().finite().nonnegative(),
        at: z.number().int().nonnegative()
    })
);

/** Read a stored usage history back: only real apps, only sane numbers.
 *  Anything else is no history - never a broken page. */
export function parseAppUsage(raw: unknown): AppUsage {
    const parsed = appUsageSchema.safeParse(raw);
    if (!parsed.success) return {};
    return Object.fromEntries(Object.entries(parsed.data).filter(([id]) => PINNABLE.has(id)));
}

/** What an app's opens are worth at `now`: each halves every half-life. */
export function usageScore(entry: AppUsageEntry | undefined, now: number): number {
    if (!entry) return 0;
    const age = Math.max(0, now - entry.at);
    return entry.score * 0.5 ** (age / USAGE_HALF_LIFE_MS);
}

/** The history with one more open of `id` at `now`. Only listed apps are kept,
 *  so it never holds more entries than the catalogue has apps. */
export function recordAppOpen(usage: AppUsage, id: string, now: number): AppUsage {
    if (!PINNABLE.has(id)) return usage;
    return { ...usage, [id]: { score: usageScore(usage[id], now) + 1, at: now } };
}

/**
 * The apps somebody can open, in the order the menu draws them.
 *
 * `available` is what they may open, in registry order, and filters everything
 * else: an arranged or favorite app kept from when the account held a
 * permission is not a door to draw. The arranged order wins outright; whatever
 * it does not name - an app installed since, or every app for somebody who never
 * arranged anything - follows it: favorites in their order, then by use (the
 * decayed score, the latest open breaking a tie), then never-used apps in the
 * registry's order.
 */
export function launcherOrder({
    available,
    arranged = [],
    favorites,
    usage = {},
    now
}: {
    available: readonly string[];
    arranged?: readonly string[];
    favorites: readonly string[];
    usage?: AppUsage;
    now: number;
}): string[] {
    const open = new Set(available);
    const placed = new Set<string>();
    const out: string[] = [];
    const take = (ids: readonly string[]) => {
        for (const id of ids) {
            if (!open.has(id) || placed.has(id)) continue;
            placed.add(id);
            out.push(id);
        }
    };
    take(arranged);
    take(favorites);
    const rest = available
        .map((id, registry) => ({
            id,
            registry,
            score: usageScore(usage[id], now),
            at: usage[id]?.at ?? 0
        }))
        .filter((entry) => !placed.has(entry.id))
        .sort(
            (left, right) =>
                right.score - left.score || right.at - left.at || left.registry - right.registry
        );
    take(rest.map((entry) => entry.id));
    return out;
}

/**
 * The apps the Overview's rail lists: the favorites, in the order the menu
 * draws them, or for somebody who has none yet the first few. The Overview
 * itself is left out - it is the screen the rail is drawn on. Usage is not
 * read: it lives in one browser, and the rail is drawn on the server too.
 */
export function railApps({
    available,
    favorites,
    arranged = []
}: {
    available: readonly string[];
    favorites: readonly string[];
    arranged?: readonly string[];
}): string[] {
    const open = available.filter((id) => id !== OVERVIEW_APP_ID);
    const order = launcherOrder({ available: open, arranged, favorites, now: 0 });
    const pinned = new Set(favorites);
    const chosen = order.filter((id) => pinned.has(id));
    return chosen.length > 0 ? chosen : order.slice(0, LAUNCHER_ROW_SIZE);
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

/**
 * The stored arrangement after somebody put the menu in the order `visible`.
 *
 * Like the favorites, it keeps apps this account cannot open today in their
 * slots; the visible apps fill the slots they held, in their new order, and the
 * ones it did not name yet follow at the end.
 */
export function arrangeApps(stored: readonly string[], visible: readonly string[]): string[] {
    const shown = new Set(visible);
    const slots = stored.filter((id) => shown.has(id)).length;
    return [...arrangeFavorites(stored, visible), ...visible.slice(slots)];
}

/**
 * The preferences after somebody arranged the menu into `visible`.
 *
 * Arranging is the one way to say what comes first now that there is no star,
 * so the first arrangement folds the favorites into the order and retires them:
 * the order already drew them first, so nothing moves on screen. A favorite this
 * account cannot open today keeps its place in the stored order, and comes back
 * where it was. Until somebody arranges, favorites saved by an older menu are
 * kept exactly as they were - the menu and the Overview's rail read them the
 * same way they always did.
 */
export function arrangedPrefs(stored: LauncherPrefs, visible: readonly string[]): LauncherPrefs {
    const kept = [...stored.order, ...stored.favorites.filter((id) => !stored.order.includes(id))];
    const order = arrangeApps(kept, visible);
    // Nothing moved: nothing to save, and nothing to retire either.
    if (stored.order.length > 0 && sameOrder(order, kept)) return stored;
    return { favorites: [], order };
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((id, at) => id === right[at]);
}
