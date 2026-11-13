/**
 * Marketplace apps Polaris no longer ships. An install made before one was
 * retired is taken down here, through the same uninstall every reader uses, so an
 * update is all it takes: its containers and volumes go and its install row is
 * deleted. What it did now happens inside Polaris itself.
 */

import { prisma } from "@polaris/db";
import { uninstallApp } from "@/lib/apps/install-service";

/** The messaging bridge: channels now send from the web process (channel-runtime). */
export const RETIRED_APPS: readonly string[] = ["messaging-bridge"];

/** Uninstall every retired app still installed, and forget the rows of ones
 *  already removed. A failure is logged and retried on the next pass. */
export async function retireRetiredApps(): Promise<{ retired: number }> {
    const rows = await prisma.installedApp.findMany({
        where: { catalogId: { in: [...RETIRED_APPS] }, status: { not: "removed" } },
        select: { id: true, ownerId: true, catalogId: true }
    });
    let retired = 0;
    for (const row of rows) {
        try {
            await uninstallApp(row.ownerId, row.id, { deleteData: true });
            retired++;
        } catch (error) {
            console.error(`polaris: could not retire ${row.catalogId} (${row.id}):`, error);
        }
    }
    // Nothing reinstalls a retired app, so a row kept for that has no use.
    await prisma.installedApp.deleteMany({
        where: { catalogId: { in: [...RETIRED_APPS] }, status: "removed" }
    });
    return { retired };
}
