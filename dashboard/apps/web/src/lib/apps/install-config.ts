/**
 * The non-secret settings an install carries, as one JSON column.
 *
 * Several things write into it - the address a game server answers to, whether its
 * player list is bound to an address, when its port was last seen reachable - and
 * they are written at different moments by different screens. So nothing replaces
 * the object: a write merges, because the alternative is the last writer quietly
 * deleting what the previous one recorded.
 */

import { prisma } from "@polaris/db";

import { readInstallConfig, type InstallConfig } from "./install-config-value";

export { readInstallConfig, type InstallConfig } from "./install-config-value";

/** Merge keys into an install's config, leaving the rest of it alone. */
export async function patchInstallConfig(installedAppId: string, patch: InstallConfig): Promise<void> {
    const row = await prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } });
    const config = { ...readInstallConfig(row?.config), ...patch };
    await prisma.installedApp.update({ where: { id: installedAppId }, data: { config: JSON.stringify(config) } });
}
