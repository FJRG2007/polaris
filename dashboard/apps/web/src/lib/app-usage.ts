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
 */

import { resolveActiveApp } from "@/lib/apps";
import { readRecentPlaces } from "@/lib/overview/recent-places";
import { parseAppUsage, recordAppOpen, type AppUsage } from "@/lib/app-launcher";

const STORE_KEY = "polaris.apps.usage";

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
