/**
 * What the app switcher puts in its top row, and how the pins behind it are
 * stored.
 *
 * The row is the apps somebody reaches for, the way Google's launcher opens on
 * the ones you use: first the apps they pinned, in their order; then, while there
 * is room, the ones they opened most recently; and for somebody who has neither -
 * a new account, a new browser - the first apps they can open, in the order the
 * registry lists them. Everything else sits below it, each app once.
 *
 * Pure and safe in the browser: the switcher computes the row where the recent
 * history lives, and the server validates a save against the same schema.
 */

import { z } from "zod";
import { POLARIS_APPS } from "@/lib/apps";

/** Two rows of three: enough to hold what somebody uses daily, short enough that
 *  the rest of the list is still in view. */
export const LAUNCHER_ROW_SIZE = 6;

/** How many apps can be pinned. Every app there is, and not one more. */
export const MAX_FAVORITE_APPS = POLARIS_APPS.length;

/** The ids an app can be pinned by: every app the switcher can list. */
const PINNABLE = new Set(POLARIS_APPS.filter((app) => !app.hidden).map((app) => app.id));

export const favoriteAppsSchema = z
    .array(z.string().trim().refine((id) => PINNABLE.has(id), "That app does not exist."))
    .max(MAX_FAVORITE_APPS)
    .refine((ids) => new Set(ids).size === ids.length, "An app can only be pinned once.");

/** Read a stored list back. Anything unparseable is nothing pinned: a preference
 *  is not worth failing a page load over. */
export function parseFavoriteApps(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = favoriteAppsSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

export interface LauncherLayout {
    /** The top row, in order. */
    featured: string[];
    /** Whether anything in it was pinned, which is what the row is called by. */
    pinned: boolean;
    /** Every other app this account can open, in registry order. */
    rest: string[];
}

/**
 * Split the apps somebody can open into the top row and the rest.
 *
 * `available` is what they may open, in registry order, and is applied to
 * everything else: a pin kept from when the account held a permission, or a
 * recent visit from before an app was uninstalled, is not a door to draw. Pins
 * are never cut to the row size - somebody who pinned eight apps asked for eight.
 */
export function launcherLayout({
    available,
    favorites,
    recent
}: {
    available: readonly string[];
    favorites: readonly string[];
    /** App ids, most recent first. Repeats are fine. */
    recent: readonly string[];
}): LauncherLayout {
    const open = new Set(available);
    const featured: string[] = [];
    const add = (id: string) => {
        if (open.has(id) && !featured.includes(id)) featured.push(id);
    };
    favorites.forEach(add);
    const pinned = featured.length > 0;
    for (const id of [...recent, ...available]) {
        if (featured.length >= LAUNCHER_ROW_SIZE) break;
        add(id);
    }
    return { featured, pinned, rest: available.filter((id) => !featured.includes(id)) };
}
