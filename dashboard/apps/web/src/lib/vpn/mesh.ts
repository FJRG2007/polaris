/**
 * Whether this Polaris has the VPN's device mesh switched on (`meshOn` in
 * `settings.ts`), read straight off the app's install row.
 *
 * Kept apart from `service.ts` so the install probe the shell asks on every
 * screen (`install-presence`) can answer for it without loading the control
 * server's client and everything behind it.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { meshOn, readVpnSettings, VPN_APP } from "./settings";
import { readInstallConfig } from "@/lib/apps/install-config-value";

/** The key the settings live under on the app's install row. */
export const VPN_CONFIG_KEY = "vpn";

/** Whether the mesh is on; false while the VPN app is not installed. */
export async function vpnMeshOn(): Promise<boolean> {
    const row = await prisma.installedApp.findFirst({
        where: { catalogId: VPN_APP, status: { not: "removed" } },
        select: { config: true },
        orderBy: { createdAt: "asc" }
    });
    if (!row) return false;
    return meshOn(readVpnSettings(readInstallConfig(row.config)[VPN_CONFIG_KEY]));
}
