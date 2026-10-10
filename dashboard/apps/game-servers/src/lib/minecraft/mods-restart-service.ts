/**
 * Recording a mod change that waits for a restart, and reading whether it still
 * does. The rule is in `mods-restart.ts`.
 */

import { prisma } from "@polaris/db";
import { runSince } from "./run-since";
import { host } from "@polaris/app-host";
import { MODS_CHANGED_KEY, modsAwaitRestart, modsChangedAt } from "./mods-restart";

const { patchInstallConfig, readInstallConfig } = host.appsInstallConfig;

/** Note that this server's mods changed and nothing restarted it. */
export async function markModsChanged(
    installedAppId: string,
    now: Date = new Date()
): Promise<void> {
    await patchInstallConfig(installedAppId, { [MODS_CHANGED_KEY]: now.toISOString() });
}

/** Whether the server is running on a list older than its last mod change. */
export async function modsRestartPending(
    installedAppId: string,
    applicationId: string
): Promise<boolean> {
    const [install, deployment] = await Promise.all([
        prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } }),
        prisma.deployment.findFirst({
            where: { deployableType: "application", deployableId: applicationId },
            orderBy: { createdAt: "desc" },
            select: { finishedAt: true }
        })
    ]);
    const config = install?.config ?? null;
    const upSince = runSince(config, deployment ? (deployment.finishedAt ?? new Date()) : null);
    return modsAwaitRestart(modsChangedAt(readInstallConfig(config)), upSince);
}
