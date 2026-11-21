/**
 * Spawn protection off on the Minecraft servers made while Polaris wrote the
 * game's 16 for them.
 *
 * The owner is an operator on every Polaris server, and with an operator on
 * the list the game keeps everybody else from building within 16 blocks of
 * spawn. New servers start at 0 (`catalog.ts`); this carries that to the ones
 * made before. Written for the next start, never forced into a running one.
 * Once written, the marker says Polaris did it, so an owner who sets the
 * radius back is never undone.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";

const { setEnvVars } = host.envVarService;

export const SPAWN_PROTECTION_KEY = "SPAWN_PROTECTION";
/** Set once Polaris has turned it off on a server; never cleared. */
export const SPAWN_PROTECTION_BY_KEY = "POLARIS_SPAWN_PROTECTION";
/** What Polaris wrote by default before, and what the game uses when unset. */
const OLD_DEFAULT = "16";

/** The writes that turn it off on this server, or null when it is not Polaris's to change. Pure. */
export function spawnProtectionWrites(env: ReadonlyMap<string, string>): Map<string, string> | null {
    if ((env.get(SPAWN_PROTECTION_BY_KEY) ?? "").trim() !== "") return null;
    const radius = (env.get(SPAWN_PROTECTION_KEY) ?? "").trim();
    if (radius !== "" && radius !== OLD_DEFAULT) return null;
    return new Map([
        [SPAWN_PROTECTION_KEY, "0"],
        [SPAWN_PROTECTION_BY_KEY, "off"]
    ]);
}

export async function adoptSpawnProtectionOff(): Promise<{ changed: number }> {
    const installs = await prisma.installedApp.findMany({
        where: { catalogId: "minecraft", status: { not: "removed" }, applicationId: { not: null } },
        select: { id: true, ownerId: true, applicationId: true }
    });
    if (installs.length === 0) return { changed: 0 };
    const rows = await prisma.envVar.findMany({
        where: {
            scopeType: "application",
            scopeId: { in: installs.map((install) => install.applicationId!) },
            key: { in: [SPAWN_PROTECTION_KEY, SPAWN_PROTECTION_BY_KEY] }
        },
        select: { scopeId: true, key: true, value: true }
    });
    const envs = new Map<string, Map<string, string>>();
    for (const row of rows) {
        const env = envs.get(row.scopeId) ?? new Map<string, string>();
        env.set(row.key, row.value ?? "");
        envs.set(row.scopeId, env);
    }
    let changed = 0;
    for (const install of installs) {
        const writes = spawnProtectionWrites(envs.get(install.applicationId!) ?? new Map());
        if (!writes) continue;
        try {
            await setEnvVars(
                "application",
                install.applicationId!,
                install.ownerId,
                [...writes].map(([key, value]) => ({ key, value, isSecret: false }))
            );
            changed += 1;
        } catch (caught) {
            // One server that cannot be written is not a reason to skip the rest.
            console.error(`[minecraft-spawn-protection] could not turn it off for ${install.id}:`, caught);
        }
    }
    return { changed };
}
