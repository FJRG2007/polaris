/**
 * How much this browser opens each app, for the order of the app menu.
 *
 * Kept in the browser, beside the "Recently visited" history (`recent-places`)
 * and for the same reason: an app is opened every few minutes, and a database
 * write behind each of them to order one menu is not worth it. One entry per
 * app the catalogue lists, so it can never grow past the catalogue.
 *
 * Read back through the same validation as anything else a tab, an extension or
 * an older build can write: a value that does not parse is no history at all.
 * A browser with no history yet starts from its recent visits, so the order is
 * not blank for everybody on the day this arrives.
 *
 * The menu does not read the live history: an app that jumped up the moment it
 * was opened moved every other tile with it, and nobody finds anything in a
 * grid that rearranges itself on each click. It reads a copy taken at most once
 * a day (`readMenuUsage`), so the order follows use the way a phone's does -
 * from one day to the next - and holds still in between.
 */

import { resolveActiveApp } from "@/lib/apps";
import { readRecentPlaces } from "@/lib/overview/recent-places";
import { parseAppUsage, recordAppOpen, type AppUsage } from "@/lib/app-launcher";

export const STORE_KEY = "polaris.apps.usage";

/** The copy of the history the menu is ordered by, and when it was taken. */
export const MENU_KEY = "polaris.apps.usage.menu";

/** How long the menu keeps one order before it follows use again. */
export const MENU_ORDER_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * The history the menu orders by: a copy taken at most once a day, with the
 * moment it was taken, which is what its decay is measured from - so the same
 * copy always gives the same order. A missing, unreadable or stale copy is
 * taken again from the live history.
 */
export function readMenuUsage(now = Date.now()): { usage: AppUsage; at: number } {
    if (typeof window === "undefined") return { usage: {}, at: now };
    try {
        const raw = window.localStorage.getItem(MENU_KEY);
        if (raw !== null) {
            const held = JSON.parse(raw) as { usage?: unknown; at?: unknown };
            const at = typeof held.at === "number" && Number.isFinite(held.at) ? held.at : -1;
            if (at >= 0 && at <= now && now - at < MENU_ORDER_HOLD_MS)
                return { usage: parseAppUsage(held.usage), at };
        }
    } catch {
        // Unreadable copy or refused storage: take a fresh one below.
    }
    const fresh = { usage: readAppUsage(), at: now };
    try {
        window.localStorage.setItem(MENU_KEY, JSON.stringify(fresh));
    } catch {
        // Not kept: the order still holds for this page, only not past it.
    }
    return fresh;
}

/** The history this browser holds, or the one its recent visits suggest. */
export function readAppUsage(): AppUsage {
    if (typeof window === "undefined") return {};
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(STORE_KEY);
    } catch {
        // Storage refused (private mode, blocked site data): no history, and
        // the menu falls back to favorites and the catalogue's order.
        return {};
    }
    if (raw === null) return fromRecentPlaces();
    try {
        return parseAppUsage(JSON.parse(raw));
    } catch {
        return {};
    }
}

/** Note one open of `appId` now. */
export function rememberAppOpen(appId: string): void {
    if (typeof window === "undefined") return;
    const next = recordAppOpen(readAppUsage(), appId, Date.now());
    try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
        // A full or refused storage costs the order, not the navigation.
    }
}

/** One open per recent visit, oldest first, at the time it was made. */
function fromRecentPlaces(): AppUsage {
    let usage: AppUsage = {};
    for (const place of readRecentPlaces().slice().reverse()) {
        const at = Date.parse(place.visitedAt);
        if (Number.isFinite(at) && at >= 0)
            usage = recordAppOpen(usage, resolveActiveApp(place.href).id, at);
    }
    return usage;
}
