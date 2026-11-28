/**
 * Registers the apps of the published catalogue with the screens that list
 * apps: the catalog every screen reads (`findApp`, the marketplace) and the rail
 * (`POLARIS_APPS`). The same on the server and in the browser, so both agree.
 *
 * Client-safe: plain data in, no server import.
 */

import { Package } from "lucide-react";
import { setRuntimeApps } from "./catalog";
import { APP_CATEGORIES, POLARIS_APPS, type AppEntry } from "@/lib/apps";
import type { RuntimeAppView } from "./runtime-catalog-schema";
import type { Permission } from "@polaris/core";

const RAIL_CATEGORIES: ReadonlySet<string> = new Set(APP_CATEGORIES.map((category) => category.id));

/** Ids this module put on the rail, so a later registration replaces them rather than adding twice. */
const railed = new Set<string>();

let last = "";

/** Register `views`; a repeat of the same list does nothing. */
export function registerRuntimeApps(views: readonly RuntimeAppView[]): void {
    const key = JSON.stringify(views);
    if (key === last) return;
    last = key;
    setRuntimeApps(views.map(({ nav: _nav, ...view }) => ({ ...view, icon: Package })));
    for (let index = POLARIS_APPS.length - 1; index >= 0; index--) {
        if (railed.has(POLARIS_APPS[index]?.id ?? "")) POLARIS_APPS.splice(index, 1);
    }
    railed.clear();
    const baked = new Set(POLARIS_APPS.map((app) => app.id));
    for (const view of views) {
        if (!view.nav || baked.has(view.id)) continue;
        const entry: AppEntry = {
            id: view.id,
            label: view.name,
            description: view.summary,
            icon: Package,
            href: view.opensAt ?? `/x/${view.id}`,
            category: (RAIL_CATEGORIES.has(view.nav.category) ? view.nav.category : "work") as AppEntry["category"],
            // Checked against this dashboard's permissions by `appEntryFit` before a nav is handed over.
            permission: view.nav.permission as Permission,
            requiresApp: view.id
        };
        POLARIS_APPS.push(entry);
        railed.add(view.id);
    }
}
