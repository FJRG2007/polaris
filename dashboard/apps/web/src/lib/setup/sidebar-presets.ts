/**
 * Named starting points for the Overview's app rail, by what somebody uses
 * Polaris for.
 *
 * A preset is not a new kind of preference: picking one writes the favorites the
 * rail and the app menu already read (see `app-launcher`), so whatever somebody
 * arranges or pins afterwards simply changes them, and nothing has to decide
 * which of the two wins. "Default" clears both, which is the rail every account
 * had before presets existed - an account that never picks one sees no change.
 *
 * Which preset is "current" is derived rather than stored: the one whose apps are
 * exactly the favorites, "default" when nothing is chosen, and "custom" once the
 * list was edited by hand.
 *
 * Pure and safe in the browser.
 */

import { POLARIS_APPS } from "@/lib/apps";
import { NO_LAUNCHER_PREFS, type LauncherPrefs } from "@/lib/app-launcher";

export const SIDEBAR_PRESET_IDS = ["default", "hosting", "team", "games", "homelab"] as const;

export type SidebarPresetId = (typeof SIDEBAR_PRESET_IDS)[number];

/** What a preset puts in the rail, in rail order. Empty for "default". Every id
 *  is an app the switcher lists; one the reader cannot open is skipped where the
 *  rail is drawn, like any other favorite. */
export const SIDEBAR_PRESETS: Readonly<Record<SidebarPresetId, readonly string[]>> = {
    default: [],
    hosting: ["apps", "watch", "status-pages", "drive"],
    team: ["chat", "tasks", "drive", "mail", "calendar", "notes", "office"],
    games: ["games", "chat", "apps", "watch", "drive"],
    homelab: ["home", "apps", "watch", "drive", "vault", "tools"]
};

/** The stored preferences a preset stands for. Applying one starts the app menu
 *  over from its order too, so the rail draws exactly the preset. */
export function presetPrefs(id: SidebarPresetId): LauncherPrefs {
    const apps = SIDEBAR_PRESETS[id];
    return apps.length === 0 ? NO_LAUNCHER_PREFS : { favorites: [...apps], order: [] };
}

/** The preset these preferences are, or "custom" when they are none of them. */
export function matchPreset(prefs: LauncherPrefs): SidebarPresetId | "custom" {
    if (prefs.favorites.length === 0 && prefs.order.length === 0) return "default";
    if (prefs.order.length > 0) return "custom";
    const found = SIDEBAR_PRESET_IDS.find((id) => {
        const apps = SIDEBAR_PRESETS[id];
        return (
            apps.length > 0 &&
            apps.length === prefs.favorites.length &&
            apps.every((app, index) => prefs.favorites[index] === app)
        );
    });
    return found ?? "custom";
}

/** Whether every app a preset names is one the switcher lists - asserted in a
 *  test so a renamed app cannot quietly empty a preset. */
export function presetAppsListed(): boolean {
    const listed = new Set(POLARIS_APPS.filter((app) => !app.hidden).map((app) => app.id));
    return SIDEBAR_PRESET_IDS.every((id) => SIDEBAR_PRESETS[id].every((app) => listed.has(app)));
}
