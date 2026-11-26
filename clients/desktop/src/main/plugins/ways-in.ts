/**
 * The ways to an installed plugin's own page that the app offers outside it:
 * a launcher row for every installed plugin, and a tray item for each one whose
 * device is plugged in now. Pure, for the tests.
 */

import { HOST_PLUGINS_PATH } from "@/shared/settings-route";
import { pluginDevicePresent, pluginSettingTargets, type PluginManifest, type UsbDevice } from "@polaris/core/device-plugins";

export interface PluginShortcut {
    readonly id: string;
    readonly name: string;
    /** The plugin's page in the host's Settings. */
    readonly path: string;
    /** Its groups of settings and its settings, each a place on that page, for the launcher. */
    readonly places: readonly PluginPlace[];
}

/** One group or setting on a plugin's page, labelled in English like the rest of the app. */
export interface PluginPlace {
    readonly label: string;
    /** The page with the place's anchor, so the host scrolls to it. */
    readonly path: string;
    /** Other words that find it. */
    readonly words: readonly string[];
}

export interface PluginShortcuts {
    /** Every installed plugin whose files are there, for the launcher. */
    readonly installed: readonly PluginShortcut[];
    /** The enabled ones whose device is plugged in now, for the tray. Empty where plugs cannot be heard. */
    readonly plugged: readonly PluginShortcut[];
}

/** The plugin's page in Settings, as the store links to it. */
export function pluginPagePath(id: string): string {
    return `${HOST_PLUGINS_PATH}/${encodeURIComponent(id)}`;
}

export function pluginShortcuts(
    installed: readonly { readonly id: string; readonly enabled: boolean; readonly manifest: Pick<PluginManifest, "name" | "claims" | "settings" | "groups"> | null; }[],
    devices: readonly UsbDevice[] | null
): PluginShortcuts {
    const all: PluginShortcut[] = [];
    const plugged: PluginShortcut[] = [];
    for (const plugin of installed) {
        if (!plugin.manifest) continue;
        const path = pluginPagePath(plugin.id);
        const places = pluginSettingTargets(plugin.manifest, "en-US").map((target) => ({
            label: target.section ? `${target.section} - ${target.label}` : target.label,
            path: `${path}#${target.anchor}`,
            words: target.words
        }));
        const shortcut = { id: plugin.id, name: plugin.manifest.name, path, places };
        all.push(shortcut);
        if (plugin.enabled && devices && pluginDevicePresent(plugin.manifest, devices)) plugged.push(shortcut);
    }
    const byName = (a: PluginShortcut, b: PluginShortcut) => a.name.localeCompare(b.name);
    return { installed: all.sort(byName), plugged: plugged.sort(byName) };
}

/** Whether two lists name the same plugins in the same order, so an unchanged tray is not rebuilt. */
export function sameShortcuts(a: readonly PluginShortcut[], b: readonly PluginShortcut[]): boolean {
    return a.length === b.length && a.every((item, index) => item.id === b[index]?.id && item.name === b[index]?.name);
}
