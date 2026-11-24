/**
 * The ways to an installed add-on's own page that the app offers outside it:
 * a launcher row for every installed add-on, and a tray item for each one whose
 * device is plugged in now. Pure, for the tests.
 */

import type { LocalAddonRow } from "@/shared/bridge";
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

type RunView =
    | { readonly state: "starting" | "running" | "restarting" | "failed"; readonly status: { readonly state: "connected" | "sleeping" | "busy" | "error"; readonly detail?: string; } | null; }
    | { readonly state: "disabled" | "sleeping" | "missing"; };

const RUN_WORDS = {
    starting: "Starting",
    running: "Running",
    restarting: "Restarting",
    failed: "Stopped after crashing",
    disabled: "Turned off",
    sleeping: "Unplugged",
    missing: "Files missing, reinstall it"
} as const;

const STATUS_WORDS = { connected: "Connected", sleeping: "Unplugged", busy: "In use elsewhere", error: "Not working" } as const;

/** The words for how an add-on runs: what it said about its device while it runs, else the run's own state. */
export function addonStatusWords(run: RunView): string {
    if ("status" in run && run.status && (run.state === "running" || run.state === "starting")) {
        const words = STATUS_WORDS[run.status.state];
        return run.status.detail ? `${words} - ${run.status.detail}` : words;
    }
    return RUN_WORDS[run.state];
}

export function localAddonRows(
    installed: readonly { readonly id: string; readonly version: string; readonly enabled: boolean; readonly manifest: Pick<AddonManifest, "name"> | null; readonly run: RunView; }[]
): LocalAddonRow[] {
    return installed
        .map((addon) => ({ id: addon.id, name: addon.manifest?.name ?? addon.id, version: addon.version, enabled: addon.enabled, status: addonStatusWords(addon.run) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
