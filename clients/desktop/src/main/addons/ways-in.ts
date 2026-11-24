/**
 * The ways to an installed add-on's own page that the app offers outside it:
 * a launcher row for every installed add-on, and a tray item for each one whose
 * device is plugged in now. Pure, for the tests.
 */

import { addonDevicePresent, addonSettingTargets, type AddonManifest, type UsbDevice } from "@polaris/core/device-addons";

export interface AddonShortcut {
    readonly id: string;
    readonly name: string;
    /** The add-on's page in the host's Settings. */
    readonly path: string;
    /** Its groups of settings and its settings, each a place on that page, for the launcher. */
    readonly places: readonly AddonPlace[];
}

/** One group or setting on an add-on's page, labelled in English like the rest of the app. */
export interface AddonPlace {
    readonly label: string;
    /** The page with the place's anchor, so the host scrolls to it. */
    readonly path: string;
    /** Other words that find it. */
    readonly words: readonly string[];
}

export interface AddonShortcuts {
    /** Every installed add-on whose files are there, for the launcher. */
    readonly installed: readonly AddonShortcut[];
    /** The enabled ones whose device is plugged in now, for the tray. Empty where plugs cannot be heard. */
    readonly plugged: readonly AddonShortcut[];
}

/** The add-on's page in Settings, as the store links to it. */
export function addonPagePath(id: string): string {
    return `/account/addons/${encodeURIComponent(id)}`;
}

export function addonShortcuts(
    installed: readonly { readonly id: string; readonly enabled: boolean; readonly manifest: Pick<AddonManifest, "name" | "claims" | "settings" | "groups"> | null; }[],
    devices: readonly UsbDevice[] | null
): AddonShortcuts {
    const all: AddonShortcut[] = [];
    const plugged: AddonShortcut[] = [];
    for (const addon of installed) {
        if (!addon.manifest) continue;
        const path = addonPagePath(addon.id);
        const places = addonSettingTargets(addon.manifest, "en-US").map((target) => ({
            label: target.section ? `${target.section} - ${target.label}` : target.label,
            path: `${path}#${target.anchor}`,
            words: target.words
        }));
        const shortcut = { id: addon.id, name: addon.manifest.name, path, places };
        all.push(shortcut);
        if (addon.enabled && devices && addonDevicePresent(addon.manifest, devices)) plugged.push(shortcut);
    }
    const byName = (a: AddonShortcut, b: AddonShortcut) => a.name.localeCompare(b.name);
    return { installed: all.sort(byName), plugged: plugged.sort(byName) };
}

/** Whether two lists name the same add-ons in the same order, so an unchanged tray is not rebuilt. */
export function sameShortcuts(a: readonly AddonShortcut[], b: readonly AddonShortcut[]): boolean {
    return a.length === b.length && a.every((item, index) => item.id === b[index]?.id && item.name === b[index]?.name);
}
