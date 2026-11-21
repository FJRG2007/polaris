/**
 * The Minecraft release a server actually runs, for the checks that depend on it.
 *
 * The install records `mcRelease` when it is built, and that is very often the
 * literal `LATEST` the server was created with - a modpack installed over it
 * then pins a real release in the `VERSION` setting without the record moving.
 * Read on its own, `LATEST` is not a number and a version check fails on it, so a
 * 1.20.1 server was told the side panel needs 1.16 or newer. Whichever of the two
 * names a real release wins; neither naming one is "unknown", never a release.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { wantsLatest } from "./blueprint-version";

/** The first of these that names a real release, or null. */
export function concreteRelease(...candidates: readonly (string | null | undefined)[]): string | null {
    for (const candidate of candidates) {
        const value = (candidate ?? "").trim();
        if (!wantsLatest(value)) return value;
    }
    return null;
}

/** The release recorded on the install, or else the one its `VERSION` setting names. */
export async function installRelease(
    install: { config: Record<string, unknown>; applicationId: string | null; ownerId: string }
): Promise<string | null> {
    const recorded = typeof install.config.mcRelease === "string" ? install.config.mcRelease : null;
    if (concreteRelease(recorded) || !install.applicationId) return concreteRelease(recorded);
    const vars = await host.envVarService.listEnvVars("application", install.applicationId, install.ownerId).catch(() => []);
    const setting = vars.find((entry: { key: string }) => entry.key === "VERSION")?.value ?? null;
    return concreteRelease(recorded, setting);
}

/** The same, read by the install's id. */
export async function installReleaseById(installedAppId: string): Promise<string | null> {
    const row = await prisma.installedApp.findUnique({
        where: { id: installedAppId },
        select: { config: true, applicationId: true, ownerId: true }
    });
    if (!row) return null;
    const config =
        typeof row.config === "object" && row.config !== null && !Array.isArray(row.config)
            ? (row.config as Record<string, unknown>)
            : {};
    return installRelease({ config, applicationId: row.applicationId, ownerId: row.ownerId });
}
