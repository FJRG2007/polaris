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
