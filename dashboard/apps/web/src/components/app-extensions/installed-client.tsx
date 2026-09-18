"use client";

/**
 * Draws what an installable app puts inside a core screen.
 *
 * The client half of the app extension registry. A slot was built on the server
 * by the app (`AppExtension.firewallSlot`, `installedPanelSlot`), with where the
 * app's component that draws it is in its bundle; this loads and draws it.
 */

import type { Permission } from "@polaris/core";
import type { AppSlot } from "@/lib/app-extensions/types";
import { AppBundleMount } from "@/components/app-bundles/mount";
import type { InstalledAppDetail, InstalledAppSetting } from "@/lib/apps/install-service";

/** What an installed-app page hands the panel it draws. */
export interface InstalledSlotHost {
    readonly app: InstalledAppDetail;
    readonly settings: InstalledAppSetting[];
    readonly running: boolean;
    /** What the viewer holds on this install. */
    readonly held: readonly Permission[];
    /** For a panel that polls, so what it learns reaches the page header. */
    readonly onStatus: (label: string | null) => void;
}

export function AppSlotView({ slot, host }: { slot: AppSlot; host?: InstalledSlotHost }) {
    // The app draws it, with the component its bundle names for its slots.
    if (!slot.bundle) return null;
    return <AppBundleMount src={slot.bundle.src} name={slot.bundle.name} props={{ slot, host }} />;
}
