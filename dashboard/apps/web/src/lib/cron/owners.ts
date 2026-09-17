/**
 * Who the instance-wide sweeps walk.
 *
 * Shared by core's jobs and the apps' own, which is why it is not inside either.
 */

import { prisma } from "@polaris/db";

/** Every owner with an installed app. A blocklist and a schedule are instance-wide
 *  and run on nobody's behalf in particular, so the walk starts from the owners
 *  rather than from a session. */
export async function ownersWithApps(): Promise<string[]> {
    const rows = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { ownerId: true },
        distinct: ["ownerId"]
    });
    return rows.map((row) => row.ownerId);
}
