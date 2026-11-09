/**
 * Where an app's administrator settings are, for the app's menu and page under
 * Management > Platform > Polaris apps. An app has them by naming the screen in
 * its catalog entry (`settingsAt`); this is the one place that reads it.
 */

import type { AppManifest } from "@/lib/apps/catalog";

/** The path every app's settings are reached by, whichever screen draws them. */
export function appSettingsPath(appId: string): string {
    return `/admin/apps/${encodeURIComponent(appId)}/settings`;
}

/** The settings link for an app that has settings, or null. */
export function appSettingsHref(app: Pick<AppManifest, "id" | "settingsAt">): string | null {
    return app.settingsAt ? appSettingsPath(app.id) : null;
}

/**
 * The apps every Polaris comes with that have administrator settings.
 *
 * Nothing installs these, so they have no catalog entry to name `settingsAt`;
 * they are always installed, and their settings are drawn by the same settings
 * page as an installed app's.
 */
const BUILT_IN_SETTINGS: ReadonlySet<string> = new Set(["chat", "polar"]);

/** Whether a built-in app draws settings on the shared settings page. */
export function builtInHasSettings(appId: string): boolean {
    return BUILT_IN_SETTINGS.has(appId);
}

/** The settings link for a built-in app that has settings, or null. */
export function builtInSettingsHref(appId: string): string | null {
    return builtInHasSettings(appId) ? appSettingsPath(appId) : null;
}

/** Where the chat administrator settings are: Polaris apps > Chat > Settings. */
export const CHAT_SETTINGS_PATH = appSettingsPath("chat");
