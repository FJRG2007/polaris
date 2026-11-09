/**
 * Analytics and Telemetry became apps to install, and nobody lost them by it.
 *
 * Both used to be part of every Polaris. Making them installable means a new
 * Polaris starts without them - and an existing one must not wake up from the
 * update that did it with two screens gone that it was using. So, once per
 * instance, the first boot of this version installs them on a Polaris that was
 * already set up, recorded against its oldest administrator, and does nothing on
 * one being set up for the first time. Either way it never runs again, so an
 * administrator who then uninstalls one is not overruled at the next restart.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { findApp } from "@/lib/apps/catalog";
import { swapSetting } from "@/lib/setting-store";
import { invalidateInstallPresence } from "@/lib/apps/install-presence";

/** The apps that were built in until they were not. */
export const FORMERLY_BUILT_IN = ["analytics", "telemetry"] as const;

/** Set once the carry has been decided for this instance. */
export const CARRY_MARK = "apps.carry.analyticsTelemetry";

/**
 * Install the formerly built-in apps on an instance that already existed.
 * Returns the catalog ids it installed, empty when it had nothing to do.
 */
export async function carryFormerlyBuiltInApps(): Promise<string[]> {
    // Claimed before anything is written, so two dashboards starting together
    // cannot both carry: the one that sets the mark does it, the other returns.
    if (!(await swapSetting(CARRY_MARK, null, new Date().toISOString()))) return [];
    // An instance with nobody on it yet is being set up now, under this version:
    // it starts like any new Polaris, without them.
    const admin = await prisma.user.findFirst({
        where: { isAdmin: true },
        orderBy: { createdAt: "asc" },
        select: { id: true }
    });
    const installed: string[] = [];
    if (admin) {
        for (const catalogId of FORMERLY_BUILT_IN) {
            const existing = await prisma.installedApp.findFirst({
                where: { catalogId, status: { not: "removed" } },
                select: { id: true }
            });
            if (existing) continue;
            await prisma.installedApp.create({
                data: {
                    catalogId,
                    ownerId: admin.id,
                    name: findApp(catalogId)?.name ?? catalogId,
                    status: "running",
                    installedById: admin.id
                },
                select: { id: true }
            });
            invalidateInstallPresence(catalogId);
            installed.push(catalogId);
        }
    }
    return installed;
}
