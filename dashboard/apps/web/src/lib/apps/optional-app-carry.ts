/**
 * Analytics and Telemetry are apps to install, and nobody installed them for you.
 *
 * When they stopped being part of every Polaris, one release installed both on
 * every instance that was already set up, so the screens would not vanish with
 * the update. That read as Polaris installing apps nobody asked for: the store
 * showed them as installed on instances whose administrator never had. This
 * takes those installs back, once per instance, and leaves alone any install a
 * person made themselves.
 *
 * Only the rows that release wrote are touched: recorded against one person as
 * both owner and installer, and created in the minutes after its mark. They are
 * set aside the way an uninstall that keeps data does, so whatever was collected
 * is still there when somebody installs the app on purpose.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { getSetting, swapSetting } from "@/lib/setting-store";
import { invalidateInstallPresence } from "@/lib/apps/install-presence";

/** The apps that were built in until they were not. */
export const FORMERLY_BUILT_IN = ["analytics", "telemetry"] as const;

/** Written by the release that installed them, with the moment it did. */
export const CARRY_MARK = "apps.carry.analyticsTelemetry";

/** Set once the automatic installs have been taken back on this instance. */
export const UNDO_MARK = "apps.carry.analyticsTelemetry.undone";

/** How long after its mark the carry could still have been writing its rows. */
const CARRY_WINDOW_MS = 10 * 60_000;

/**
 * Remove the installs the carry made on its own. Returns the catalog ids it
 * removed, empty when there was nothing of its to take back.
 */
export async function undoFormerlyBuiltInCarry(): Promise<string[]> {
    // Claimed before anything is written, so two dashboards starting together
    // cannot both run it, and it never runs again after an install made later.
    if (!(await swapSetting(UNDO_MARK, null, new Date().toISOString()))) return [];
    const mark = await getSetting(CARRY_MARK);
    const carriedAt = mark ? new Date(mark) : null;
    if (!carriedAt || Number.isNaN(carriedAt.getTime())) return [];
    const rows = await prisma.installedApp.findMany({
        where: {
            catalogId: { in: [...FORMERLY_BUILT_IN] },
            status: { not: "removed" },
            createdAt: { gte: carriedAt, lte: new Date(carriedAt.getTime() + CARRY_WINDOW_MS) }
        },
        select: { id: true, catalogId: true, ownerId: true, installedById: true }
    });
    const carried = rows.filter((row) => row.installedById === row.ownerId);
    if (carried.length === 0) return [];
    await prisma.installedApp.updateMany({
        where: { id: { in: carried.map((row) => row.id) } },
        data: { status: "removed" }
    });
    const removed = [...new Set(carried.map((row) => row.catalogId))];
    for (const catalogId of removed) invalidateInstallPresence(catalogId);
    return removed;
}
