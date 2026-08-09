/**
 * Taking over what the old backup feature left behind.
 *
 * Two things existed before this: gzipped dumps of the Polaris database sitting
 * in the data dir with nothing recording them, and world archives inside each
 * game server's container with their schedule stored as JSON in that app's
 * config column. Neither is thrown away. An instance that upgrades finds its
 * history already in the console, and one that never had any loses nothing.
 *
 * Idempotent and best-effort: it runs on the first console load, adopts what it
 * recognises, and stays quiet about anything it does not. A failure here must
 * never be the reason the screen does not open.
 */

import { join } from "node:path";
import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { buildSelector } from "./schemas";
import { readdir, stat } from "node:fs/promises";
import { isBackupEvery, type BackupEvery } from "./policy";
import { readInstallConfig } from "@/lib/apps/install-config";
import { DEFAULT_LOCAL_DESTINATION, DEFAULT_SOURCE_LOCAL_DESTINATION } from "./kinds";

/** The marker Setting that says this owner has already been through it. */
function adoptedKey(ownerId: string): string {
    return `backups.adopted.${ownerId}`;
}

/**
 * Adopt everything that predates the rebuild, once per owner.
 *
 * The marker is a Setting rather than a column so this needs no migration of its
 * own, and so re-running it after a restore is a no-op rather than a second set
 * of duplicate rows.
 */
export async function adoptLegacyBackups(ownerId: string): Promise<{ adopted: number }> {
    const key = adoptedKey(ownerId);
    const marker = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
    if (marker) return { adopted: 0 };

    let adopted = 0;
    adopted += await adoptPolarisDumps(ownerId).catch(() => 0);
    adopted += await adoptWorldPolicies(ownerId).catch(() => 0);

    await prisma.setting.upsert({
        where: { key },
        create: { key, value: new Date().toISOString() },
        update: { value: new Date().toISOString() }
    });
    return { adopted };
}

/**
 * The loose `polaris-*.json.gz` files in the data dir.
 *
 * They are already where the default local destination points, so adopting one
 * is recording that it exists - the bytes do not move. The timestamp comes from
 * the filename when it parses and from the file's own mtime when it does not,
 * because a copy with the wrong date sorts to the wrong end of the table and
 * retention would then delete the wrong one.
 */
async function adoptPolarisDumps(ownerId: string): Promise<number> {
    const destination = await prisma.backupDestination.findFirst({
        where: { ownerId, name: DEFAULT_LOCAL_DESTINATION },
        select: { id: true, basePath: true }
    });
    if (!destination) return 0;

    const dir = join(loadEnv().POLARIS_DATA_DIR, destination.basePath || "backups");
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        return 0;
    }
    const dumps = names.filter((name) => name.startsWith("polaris-") && name.endsWith(".json.gz"));
    if (dumps.length === 0) return 0;

    const resource = await prisma.protectedResource.upsert({
        where: { ownerId_selector: { ownerId, selector: buildSelector("polaris-database") } },
        create: {
            ownerId,
            kind: "polaris-database",
            selector: buildSelector("polaris-database"),
            name: "Polaris database",
            config: "{}"
        },
        update: {},
        select: { id: true }
    });

    let adopted = 0;
    for (const name of dumps) {
        const existing = await prisma.recoveryPointCopy.findFirst({
            where: { destinationId: destination.id, path: name, point: { resourceId: resource.id } },
            select: { id: true }
        });
        if (existing) continue;

        const info = await stat(join(dir, name)).catch(() => null);
        if (!info) continue;
        const takenAt = timestampFromName(name) ?? info.mtime;

        await prisma.recoveryPoint.create({
            data: {
                resourceId: resource.id,
                takenAt,
                status: "available",
                sizeBytes: BigInt(info.size),
                metadata: JSON.stringify({ format: "polaris-backup", adopted: true, fileName: name }),
                copies: {
                    create: {
                        destinationId: destination.id,
                        path: name,
                        sizeBytes: BigInt(info.size),
                        status: "available"
                    }
                }
            }
        });
        adopted += 1;
    }
    return adopted;
}

/** `polaris-2026-07-19T14-45-58-757.json.gz` back into a Date, or null. */
function timestampFromName(name: string): Date | null {
    const match = /^polaris-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})/.exec(name);
    if (!match) return null;
    const [, day, hour, minute, second, ms] = match;
    const parsed = new Date(`${day}T${hour}:${minute}:${second}.${ms}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Every game server that carried a `backupPolicy` in its config.
 *
 * The policy becomes a plan, and identical policies collapse into one - an
 * operator who set the same daily schedule on four servers gets one plan named
 * for it, not four they then have to keep in step by hand.
 *
 * The archives themselves are left where they are. They live inside each
 * container and are listed from there, so adopting them means the resource and
 * its beside-the-source destination; the first sweep records the copies.
 */
async function adoptWorldPolicies(ownerId: string): Promise<number> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" } },
        select: { id: true, name: true, config: true }
    });
    if (installs.length === 0) return 0;

    const sourceLocal = await prisma.backupDestination.findFirst({
        where: { ownerId, name: DEFAULT_SOURCE_LOCAL_DESTINATION },
        select: { id: true }
    });

    let adopted = 0;
    const plansByShape = new Map<string, string>();

    for (const install of installs) {
        const config = readInstallConfig(install.config);
        const legacy = config.backupPolicy;
        if (typeof legacy !== "object" || legacy === null || Array.isArray(legacy)) continue;
        const held = legacy as Record<string, unknown>;
        const every: BackupEvery = isBackupEvery(held.every) ? held.every : "off";
        const keepLast = typeof held.keepLast === "number" ? Math.max(0, Math.floor(held.keepLast)) : 7;
        const maxBytes = typeof held.maxBytes === "number" ? Math.max(0, Math.floor(held.maxBytes)) : 0;
        const notify = typeof held.notifyOnFailure === "boolean" ? held.notifyOnFailure : true;

        let planId: string | null = null;
        if (every !== "off" && sourceLocal) {
            const shape = `${every}|${keepLast}|${maxBytes}|${notify}`;
            planId = plansByShape.get(shape) ?? null;
            if (!planId) {
                const label = `Worlds - ${every}`;
                const plan = await prisma.backupPlan.upsert({
                    where: { ownerId_name: { ownerId, name: label } },
                    create: {
                        ownerId,
                        name: label,
                        every,
                        keepLast,
                        keepDays: 0,
                        maxBytes: BigInt(maxBytes),
                        notifyOnFailure: notify,
                        destinations: { create: { destinationId: sourceLocal.id, position: 0 } }
                    },
                    update: {},
                    select: { id: true }
                });
                planId = plan.id;
                plansByShape.set(shape, plan.id);
            }
        }

        const selector = buildSelector("minecraft-world", [install.id]);
        await prisma.protectedResource.upsert({
            where: { ownerId_selector: { ownerId, selector } },
            create: {
                ownerId,
                kind: "minecraft-world",
                selector,
                name: install.name,
                config: "{}",
                planId
            },
            update: {}
        });
        adopted += 1;
    }
    return adopted;
}
