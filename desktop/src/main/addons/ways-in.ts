/**
 * The ways to an installed add-on's own page that the app offers outside it:
 * a launcher row for every installed add-on, and a tray item for each one whose
 * device is plugged in now. Pure, for the tests.
 */

import { addonDevicePresent, type AddonManifest, type UsbDevice } from "@polaris/core/device-addons";

export interface AddonShortcut {
    readonly id: string;
    readonly name: string;
    /** The add-on's page in the host's Settings. */
    readonly path: string;
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
    installed: readonly { readonly id: string; readonly enabled: boolean; readonly manifest: Pick<AddonManifest, "name" | "claims"> | null; }[],
    devices: readonly UsbDevice[] | null
): AddonShortcuts {
    const all: AddonShortcut[] = [];
    const plugged: AddonShortcut[] = [];
    for (const addon of installed) {
        if (!addon.manifest) continue;
        const shortcut = { id: addon.id, name: addon.manifest.name, path: addonPagePath(addon.id) };
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
