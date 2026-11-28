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
import {
    registerAppEvents,
    registerAppMcpTools,
    retainAppMcpTools,
    registerAppNotificationKinds,
    registerAppSteps,
    registerAppPermissions,
    retainAppEvents,
    retainAppNotificationKinds,
    retainAppSteps,
    retainAppPermissions,
    type Permission
} from "@polaris/core";

const RAIL_CATEGORIES: ReadonlySet<string> = new Set(APP_CATEGORIES.map((category) => category.id));

/** Ids this module put on the rail, so a later registration replaces them rather than adding twice. */
const railed = new Set<string>();

let last = "";

/** Register `views`; a repeat of the same list does nothing. */
export function registerRuntimeApps(views: readonly RuntimeAppView[]): void {
    const key = JSON.stringify(views);
    if (key === last) return;
    last = key;
    setRuntimeApps(views.map(({ nav: _nav, permissionDefs: _permissions, events: _events, notificationKinds: _kinds, automationSteps: _steps, mcpTools: _tools, ...view }) => ({ ...view, icon: Package })));
    // Its automation triggers: a withdrawn app's go with it, and a trigger naming one is refused with the reason.
    retainAppEvents(views.filter((view) => view.events).map((view) => view.id));
    for (const view of views) if (view.events) registerAppEvents(view.id, view.events, view.name);
    // Its automation steps, offered in the editor under the app and run through its bundle.
    // Its MCP tools: their shape and gate known before its bundle loads.
    retainAppMcpTools(views.filter((view) => view.mcpTools).map((view) => view.id));
    for (const view of views) if (view.mcpTools) registerAppMcpTools(view.id, view.mcpTools);
    retainAppSteps(views.filter((view) => view.automationSteps).map((view) => view.id));
    for (const view of views) if (view.automationSteps) registerAppSteps(view.id, view.name, view.automationSteps);
    // Its kinds of alert, under "apps" in Account > Notifications; a withdrawn app's are refused like any undeclared one.
    retainAppNotificationKinds(views.filter((view) => view.notificationKinds).map((view) => view.id));
    for (const view of views) if (view.notificationKinds) registerAppNotificationKinds(view.id, view.name, view.notificationKinds);
    // Each app's own permissions, filed under its name; a withdrawn app's go with it.
    retainAppPermissions(views.filter((view) => view.permissionDefs).map((view) => view.id));
    for (const view of views) if (view.permissionDefs) registerAppPermissions(view.id, view.name, view.permissionDefs);
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
