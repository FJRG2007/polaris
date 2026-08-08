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

export type InstallConfig = Record<string, unknown>;

/** The config as an object. A column that is not readable JSON reads as empty -
 *  it is a settings blob, and no caller should fail to render over one. */
export function readInstallConfig(raw: string | null | undefined): InstallConfig {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as InstallConfig)
            : {};
    } catch {
        return {};
    }
}

/** Merge keys into an install's config, leaving the rest of it alone. */
export async function patchInstallConfig(installedAppId: string, patch: InstallConfig): Promise<void> {
    const row = await prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } });
    const config = { ...readInstallConfig(row?.config), ...patch };
    await prisma.installedApp.update({ where: { id: installedAppId }, data: { config: JSON.stringify(config) } });
}
