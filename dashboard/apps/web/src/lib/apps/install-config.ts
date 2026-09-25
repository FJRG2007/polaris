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

/** Writes that found the config changed under them, merged again into the new one. */
const PATCH_TRIES = 5;

/** Merge keys into an install's config, leaving the rest of it alone - including
 *  whatever another writer changed between the read and the write. */
export async function patchInstallConfig(installedAppId: string, patch: InstallConfig): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
        const row = await prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } });
        const data = { config: JSON.stringify({ ...readInstallConfig(row?.config), ...patch }) };
        if (!row || attempt >= PATCH_TRIES) {
            await prisma.installedApp.update({ where: { id: installedAppId }, data });
            return;
        }
        const written = await prisma.installedApp.updateMany({ where: { id: installedAppId, config: row.config }, data });
        if (written.count > 0) return;
    }
}
