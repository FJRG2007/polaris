/**
 * What a database's Manage panel shows: its version and the ones it can move
 * to, an upgrade scheduled or last run, the settings its engine has, its
 * point-in-time window, and the operations run on it. One read, no secrets.
 */

import { pitrWindow } from "./pitr";
import { prisma } from "@polaris/db";
import { listOperations, DatabaseOperationError } from "./ops";
import { isStorageEngine, upgradeTargets, type ManagedEngine } from "@polaris/core";

export async function databaseOverview(databaseId: string, ownerId: string) {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        include: { parent: { select: { name: true } } }
    });
    if (!row) throw new DatabaseOperationError("That database is not there any more.");
    const engine = row.engine as ManagedEngine;
    const hosted = row.parentId !== null;
    const dedicated = !hosted && !row.recoveryBase;
    const recoveredFrom = row.recoveredFromId
        ? await prisma.managedDatabase.findUnique({ where: { id: row.recoveredFromId }, select: { name: true } })
        : null;
    return {
        id: row.id,
        name: row.name,
        engine,
        version: row.version,
        status: row.status,
        deployed: Boolean(row.containerName),
        hosted,
        hostName: row.parent?.name ?? null,
        storage: isStorageEngine(engine),
        upgrade: dedicated
            ? {
                  versions: upgradeTargets(engine, row.version),
                  state: row.upgradeState,
                  to: row.upgradeTo,
                  at: row.upgradeAt?.toISOString() ?? null,
                  error: row.upgradeError,
                  previousVersion: row.previousVolumeName ? row.previousVersion : null,
                  previousVolume: row.previousVolumeName
              }
            : null,
        redis: engine === "redis" && !hosted ? { mode: row.mode, maxMemoryMb: row.maxMemoryMb } : null,
        mongo: engine === "mongo" && !hosted ? { replicaSet: row.replicaSet } : null,
        pitr: engine === "postgres" && dedicated ? await pitrWindow(databaseId, ownerId) : null,
        recovery: row.recoveryTarget
            ? { from: recoveredFrom?.name ?? null, target: row.recoveryTarget.toISOString() }
            : null,
        operations: await listOperations(databaseId, ownerId)
    };
}

export type DatabaseOverview = Awaited<ReturnType<typeof databaseOverview>>;

/** The managed databases whose data could be copied into this one: the same
 *  engine (MySQL and MariaDB load each other's dumps), deployed, not itself. */
export async function copySources(databaseId: string, ownerId: string) {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        select: { engine: true, environment: { select: { projectId: true } } }
    });
    if (!row) throw new DatabaseOperationError("That database is not there any more.");
    const engines = row.engine === "mysql" || row.engine === "mariadb" ? ["mysql", "mariadb"] : [row.engine];
    // The same project: access was checked for it, and for nothing wider.
    const rows = await prisma.managedDatabase.findMany({
        where: {
            id: { not: databaseId },
            engine: { in: engines },
            environment: { projectId: row.environment.projectId, project: { ownerId } },
            OR: [{ containerName: { not: "" } }, { parent: { containerName: { not: "" } } }]
        },
        orderBy: { name: "asc" },
        take: 200,
        select: {
            id: true,
            name: true,
            environment: { select: { name: true, project: { select: { name: true } } } }
        }
    });
    return rows.map((source) => ({
        id: source.id,
        name: source.name,
        where: `${source.environment.project.name} / ${source.environment.name}`
    }));
}
