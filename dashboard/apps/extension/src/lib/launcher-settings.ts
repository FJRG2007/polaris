/**
 * The on-page launcher's settings (`src/entrypoints/launcher.ts`): on or off,
 * its keys, and the sites it skips or keeps to. One key in the browser's local
 * area, read straight from it like `page-filling.ts` so the settings screen can
 * be drawn in a test with no WXT. The rules live in `@polaris/core/launcher`,
 * shared with the dashboard and Polaris Desktop.
 */

import { readLauncherSettings, type LauncherSettings } from "@polaris/core/launcher";

export const LAUNCHER_KEY = "local:launcher.settings";

interface LocalArea {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}

const NAME = LAUNCHER_KEY.slice("local:".length);
const localArea = (api: unknown): LocalArea | undefined =>
    (api as { storage?: { local?: LocalArea } }).storage?.local;

export async function readLauncher(api: unknown): Promise<LauncherSettings> {
    const area = localArea(api);
    return readLauncherSettings(area ? (await area.get(NAME))[NAME] : undefined);
}

export async function saveLauncher(api: unknown, settings: LauncherSettings): Promise<void> {
    await localArea(api)?.set({ [NAME]: readLauncherSettings(settings) });
}

/**
 * The match patterns the worker registers the launcher under: every page it
 * holds access to, minus the Polaris instance (its own palette answers there)
 * and minus the skipped sites - or only the kept sites in include-only mode.
 */
export function launcherPatterns(
    held: readonly string[],
    settings: LauncherSettings,
    home: string | null
): { matches: string[]; excludeMatches: string[] } {
    const web = held.filter((origin) => origin === "<all_urls>" || /^(https?|\*):\/\//.test(origin));
    const site = (host: string): string[] => [`*://${host}/*`, `*://*.${host}/*`];
    const own = home ? [`${home}/*`] : [];
    if (!settings.enabled || web.length === 0) return { matches: [], excludeMatches: [] };
    if (settings.mode === "only") return { matches: settings.sites.flatMap(site), excludeMatches: own };
    return { matches: web, excludeMatches: [...own, ...settings.sites.flatMap(site)] };
}
