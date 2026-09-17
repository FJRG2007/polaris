"use client";

/**
 * Draws what an installable app puts inside a core screen.
 *
 * The client half of the app extension registry, and the one client-side place
 * allowed to name an app's components. A slot was built on the server by the
 * app (`AppExtension.firewallSlot`, `installedPanelSlot`); this hands it to the
 * app's own component.
 */

import type { Permission } from "@polaris/core";
import type { AppSlot } from "@/lib/app-extensions/types";
import { GAME_SERVERS_APP_ID } from "@/lib/apps/games-catalog";
import { GameServersSlot } from "@/app/(app)/apps/games/extension-slot";
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
    switch (slot.app) {
        case GAME_SERVERS_APP_ID:
            return <GameServersSlot slot={slot} host={host} />;
        default:
            return null;
    }
}
