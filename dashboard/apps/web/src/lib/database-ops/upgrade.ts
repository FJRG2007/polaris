/**
 * Moving an instance to another version.
 *
 * The same tag again is an in-place update: the instance is deployed again,
 * which pulls the newest patch release of the tag it runs (see
 * `isInPlaceUpgrade`). Any other version is moved by the one path that works
 * for every engine: dump what the instance holds, start the new version on a
 * NEW data volume, and load the dumps into it. The old volume is not touched,
 * which is what makes the whole thing reversible - a failure at any step points
 * the instance back at its previous version and volume and deploys that again,
 * and after a success the previous version stays one button away until its
 * volume is removed.
 *
 * What an upgrade carries is what Polaris knows the instance holds: its own
 * database, and each database hosted on it. One made by hand inside the
 * instance would be left behind on the old volume, so the upgrade refuses and
 * names it instead. Accounts made by hand inside the engine are not carried
 * either; for PostgreSQL, where they can be listed reliably, the upgrade
 * refuses on those too.
 *
 * An object store is upgraded in place, on its own volume: SeaweedFS reads the
 * data of the versions before it, and a store has no dump to move it by.
 */

import { prisma } from "@polaris/db";
import { shortHash } from "@polaris/deploy";
import { restoreDumpInto } from "./restore";
import { ensureMongoReplicaSet } from "./provision";
import { buildSelector } from "@/lib/backups/schemas";
import { dumpInContainer, isDumpableEngine } from "@/lib/backups/sources/databases";
import { deployDatabaseAndWait, engineImage, provisionInInstance } from "@/lib/database-service";
import {
    DatabaseOperationError,
    instanceContext,
    runStep,
    startOperation,
    waitReady,
    withPorts,
    type InstanceContext,
    type OperationHandle
} from "./ops";
import {
    isInPlaceUpgrade,
    listDatabasesCommand,
    listRolesCommand,
    unknownNames,
    upgradeTargets,
    MANAGED_ENGINE_INFO,
    type ManagedEngine
} from "@polaris/core";

/** A dedicated instance the owner holds, that can be upgraded. */
async function upgradable(databaseId: string, ownerId: string) {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } }
    });
    if (!row) throw new DatabaseOperationError("That database is not there any more.");
    if (row.parentId) {
        throw new DatabaseOperationError("This database lives inside another instance; it moves when the instance is upgraded.");
    }
    if (!row.containerName) throw new DatabaseOperationError("Deploy this instance before upgrading it.");
    // An upgrade moves data by dumping it and loading it into the new version,
    // and a cluster cannot be loaded that way (see `restoreDumpInto`).
    if (row.clusterMasters) {
        throw new DatabaseOperationError("A Redis cluster cannot be upgraded in place. Create a new cluster on the version you want.");
    }
    if (row.recoveryBase) {
        // Its command unpacks a base backup on an empty data folder; on a new
        // volume that would be a second recovery, not an upgrade.
        throw new DatabaseOperationError(
            "A recovered instance cannot be upgraded in place. Copy its data into a new instance of the version you want."
        );
    }
    return row;
}

/** Check a requested version against what the engine offers. */
function checkVersion(engine: ManagedEngine, current: string, version: string): void {
    const offered = MANAGED_ENGINE_INFO[engine]?.versions ?? [];
    if (!offered.includes(version)) throw new DatabaseOperationError(`Polaris does not offer version ${version}.`);
    if (!isInPlaceUpgrade(current, version) && !upgradeTargets(engine, current).includes(version)) {
        throw new DatabaseOperationError("Only newer versions can be moved to - a dump from a newer version may not load into an older one.");
    }
}

/**
 * Upgrade now. Returns once the operation is recorded; the work runs on, and is
 * followed on the instance's operations.
 */
export async function upgradeDatabase(
    databaseId: string,
    ownerId: string,
    actorId: string | null,
    version: string
): Promise<{ operationId: string }> {
    const row = await upgradable(databaseId, ownerId);
    const engine = row.engine as ManagedEngine;
    checkVersion(engine, row.version, version);
    const operation = await startOperation(databaseId, "upgrade", actorId);
    await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: { upgradeTo: version, upgradeState: "running", upgradeError: null }
    });
    void runUpgrade(databaseId, ownerId, actorId, version, operation);
    return { operationId: operation.id };
}

async function runUpgrade(
    databaseId: string,
    ownerId: string,
    actorId: string | null,
    version: string,
    operation: OperationHandle
): Promise<void> {
    const staged: { cleanup(): Promise<void> }[] = [];
    let switched = false;
    try {
        const row = await upgradable(databaseId, ownerId);
        const engine = row.engine as ManagedEngine;
        const userId = actorId ?? (await projectOwnerUser(databaseId));

        if (isInPlaceUpgrade(row.version, version)) {
            // The same tag, pulled again. Nothing to go back to if it fails -
            // the tag is what it was - so what the instance was pointed at stays.
            await operation.step(`Pulling the newest ${version} release`);
            const failure = await deployDatabaseAndWait(databaseId, ownerId, userId);
            if (failure) throw new DatabaseOperationError(`The newest ${version} release did not start: ${failure}`);
            await finish(databaseId, operation);
            return;
        }

        if (engine === "seaweedfs") {
            await operation.step(`Starting version ${version} on the same data`);
            await prisma.managedDatabase.update({
                where: { id: databaseId },
                data: {
                    previousVersion: row.version,
                    previousImage: row.image,
                    // Same volume: there is no separate copy to go back to later.
                    previousVolumeName: null,
                    version,
                    image: engineImage(engine, version)
                }
            });
            switched = true;
            const failure = await deployDatabaseAndWait(databaseId, ownerId, userId);
            if (failure) throw new DatabaseOperationError(`Version ${version} did not start: ${failure}`);
            await finish(databaseId, operation);
            return;
        }

        if (!isDumpableEngine(engine)) throw new DatabaseOperationError(`A ${engine} instance cannot be moved by a dump.`);
        const context = await instanceContext(databaseId, ownerId);
        const children = await prisma.managedDatabase.findMany({
            where: { parentId: databaseId },
            select: { id: true, name: true }
        });
        const childContexts = await Promise.all(children.map((child) => instanceContext(child.id, ownerId)));

        await operation.step("Checking what the instance holds");
        await refuseUnknown(context, childContexts);

        const resource = await prisma.protectedResource.findFirst({
            where: { selector: buildSelector("managed-database", [databaseId]) },
            select: { id: true }
        });
        if (resource) {
            await operation.step("Taking a backup first");
            const { runBackup } = await import("@/lib/backups/service");
            const copy = await runBackup(resource.id, { trigger: "pre-upgrade", actorUserId: userId });
            if (copy.status === "failed") {
                throw new DatabaseOperationError("The backup before the upgrade failed, so nothing was changed.");
            }
        }

        const dumps: { context: InstanceContext; path: string }[] = [];
        for (const each of [context, ...childContexts]) {
            await operation.step(`Copying out ${each.name}`);
            const artifact = await dumpInContainer({
                ownerId,
                targetId: context.target.id,
                container: context.container,
                engine,
                database: each.own.database,
                username: each.own.username,
                password: each.own.password,
                authDatabase: each.hosted ? each.own.database : "admin",
                label: each.slug
            }).catch((error: unknown) => {
                throw new DatabaseOperationError(
                    `Copying out ${each.name} failed, so nothing was changed${error instanceof Error ? `: ${error.message}` : ""}`
                );
            });
            staged.push(artifact);
            dumps.push({ context: each, path: artifact.path });
        }

        await operation.step(`Starting version ${version} on a new volume`);
        const suffix = `${version.replace(/[^A-Za-z0-9]+/g, "-")}-${Date.now().toString(36)}`;
        await prisma.managedDatabase.update({
            where: { id: databaseId },
            data: {
                previousVersion: row.version,
                previousImage: row.image,
                previousVolumeName: row.volumeName || `${row.engine}-data-${shortHash(row.id, 8)}`,
                version,
                image: engineImage(engine, version),
                volumeName: `${row.engine}-data-${shortHash(row.id, 8)}-${suffix}`
            }
        });
        switched = true;
        const failure = await deployDatabaseAndWait(databaseId, ownerId, userId);
        if (failure) throw new DatabaseOperationError(`Version ${version} did not start: ${failure}`);

        const fresh = await instanceContext(databaseId, ownerId);
        if (engine === "mongo" && row.replicaSet) {
            await withPorts(fresh, (ports) => ensureMongoReplicaSet(ports, fresh));
        }
        for (const dump of dumps) {
            if (dump.context.hosted) {
                await operation.step(`Creating ${dump.context.name} again`);
                await provisionInInstance(dump.context.id, ownerId);
            }
            const into = dump.context.hosted ? await instanceContext(dump.context.id, ownerId) : fresh;
            await operation.step(`Loading ${dump.context.name}`);
            await restoreDumpInto(into, { local: dump.path }, { operation });
        }
        if (engine === "postgres" && row.pitr) {
            await operation.step("Starting the recovery window again");
            const { restartArchive } = await import("./pitr");
            await restartArchive(databaseId, ownerId);
        }
        await finish(databaseId, operation);
    } catch (error) {
        const reason = await operation.fail(error);
        if (switched) await rollBack(databaseId, ownerId, actorId).catch((cause: unknown) => {
            console.error(`database: rolling back the upgrade of ${databaseId} failed:`, cause);
        });
        await prisma.managedDatabase
            .update({ where: { id: databaseId }, data: { upgradeState: "failed", upgradeError: reason } })
            .catch(() => undefined);
    } finally {
        for (const artifact of staged) await artifact.cleanup().catch(() => undefined);
    }
}

async function finish(databaseId: string, operation: OperationHandle): Promise<void> {
    await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: { upgradeState: "done", upgradeTo: null, upgradeAt: null, upgradeError: null }
    });
    await operation.succeed();
}

/** Point a failed upgrade back at the version and volume it ran before. */
async function rollBack(databaseId: string, ownerId: string, actorId: string | null): Promise<void> {
    const row = await prisma.managedDatabase.findUnique({
        where: { id: databaseId },
        select: { previousVersion: true, previousImage: true, previousVolumeName: true, volumeName: true }
    });
    if (!row?.previousVersion || !row.previousImage) return;
    await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: {
            version: row.previousVersion,
            image: row.previousImage,
            volumeName: row.previousVolumeName ?? row.volumeName,
            previousVersion: null,
            previousImage: null,
            previousVolumeName: null
        }
    });
    const failure = await deployDatabaseAndWait(databaseId, ownerId, actorId ?? (await projectOwnerUser(databaseId)));
    if (failure) throw new Error(failure);
}

/**
 * Go back to the version before the last upgrade, on the data it had then.
 * Anything written since the upgrade is on the newer volume, which is kept.
 */
export async function revertUpgrade(databaseId: string, ownerId: string, actorId: string): Promise<void> {
    const row = await upgradable(databaseId, ownerId);
    if (!row.previousVersion || !row.previousImage || !row.previousVolumeName) {
        throw new DatabaseOperationError("There is no earlier version kept to go back to.");
    }
    const operation = await startOperation(databaseId, "upgrade", actorId);
    const current = { version: row.version, image: row.image, volumeName: row.volumeName };
    await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: {
            version: row.previousVersion,
            image: row.previousImage,
            volumeName: row.previousVolumeName,
            previousVersion: current.version,
            previousImage: current.image,
            previousVolumeName: current.volumeName
        }
    });
    await operation.step(`Starting version ${row.previousVersion} on its own data`);
    const failure = await deployDatabaseAndWait(databaseId, ownerId, actorId);
    if (failure) {
        await prisma.managedDatabase.update({
            where: { id: databaseId },
            data: {
                ...current,
                previousVersion: row.previousVersion,
                previousImage: row.previousImage,
                previousVolumeName: row.previousVolumeName
            }
        });
        await deployDatabaseAndWait(databaseId, ownerId, actorId);
        throw new DatabaseOperationError(await operation.fail(new DatabaseOperationError(`It did not start: ${failure}`)));
    }
    await operation.succeed();
}

/** Refuse when the instance holds databases (or PostgreSQL accounts) nobody
 *  told Polaris about - they would stay behind on the old volume. */
async function refuseUnknown(context: InstanceContext, children: readonly InstanceContext[]): Promise<void> {
    if (context.engine === "redis" || context.engine === "seaweedfs") return;
    const engine = context.engine;
    await withPorts(context, async (ports) => {
        await waitReady(ports, context);
        const known = [context.own.database, ...children.map((child) => child.own.database)];
        const listed = await runStep(
            ports,
            context.container,
            listDatabasesCommand(engine, context.admin.username, context.admin.password),
            [context.admin.password]
        );
        const strangers = unknownNames(engine, listed, known);
        if (strangers.length > 0) {
            throw new DatabaseOperationError(
                `The instance also holds ${strangers.join(", ")}, which Polaris did not create and would not carry over. Move or drop ${strangers.length === 1 ? "it" : "them"} first.`
            );
        }
        if (engine === "postgres") {
            const roles = await runStep(ports, context.container, listRolesCommand(context.admin.username, context.admin.password), [
                context.admin.password
            ]);
            const accounts = unknownNames("", roles, [context.own.username, ...children.map((child) => child.own.username)]);
            if (accounts.length > 0) {
                throw new DatabaseOperationError(
                    `The instance also has the account${accounts.length === 1 ? "" : "s"} ${accounts.join(", ")}, which Polaris did not create and would not carry over. Drop ${accounts.length === 1 ? "it" : "them"} first.`
                );
            }
        }
    });
}

/** Someone to attribute a scheduled upgrade's deploys to: the project's owner. */
async function projectOwnerUser(databaseId: string): Promise<string> {
    const row = await prisma.managedDatabase.findUnique({
        where: { id: databaseId },
        select: { environment: { select: { project: { select: { ownerId: true } } } } }
    });
    if (!row) throw new DatabaseOperationError("That database is not there any more.");
    return row.environment.project.ownerId;
}

/** Schedule an upgrade for a maintenance window. */
export async function scheduleUpgrade(databaseId: string, ownerId: string, version: string, at: Date): Promise<void> {
    const row = await upgradable(databaseId, ownerId);
    checkVersion(row.engine as ManagedEngine, row.version, version);
    if (at.getTime() < Date.now() + 60_000) throw new DatabaseOperationError("Pick a time at least a minute from now.");
    if (row.upgradeState === "running") throw new DatabaseOperationError("An upgrade is already running.");
    await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: { upgradeTo: version, upgradeAt: at, upgradeState: "scheduled", upgradeError: null }
    });
}

export async function cancelScheduledUpgrade(databaseId: string, ownerId: string): Promise<void> {
    await upgradable(databaseId, ownerId);
    await prisma.managedDatabase.updateMany({
        where: { id: databaseId, upgradeState: "scheduled" },
        data: { upgradeTo: null, upgradeAt: null, upgradeState: "" }
    });
}

/** Start every scheduled upgrade whose time has come - the scheduled job. */
export async function sweepDueUpgrades(): Promise<{ started: number; failed: number }> {
    const due = await prisma.managedDatabase.findMany({
        where: { upgradeState: "scheduled", upgradeAt: { lte: new Date() } },
        select: { id: true, upgradeTo: true, environment: { select: { project: { select: { ownerId: true } } } } }
    });
    let started = 0;
    let failed = 0;
    for (const row of due) {
        // Claimed first, so a second runner finds nothing to start.
        const claimed = await prisma.managedDatabase.updateMany({
            where: { id: row.id, upgradeState: "scheduled" },
            data: { upgradeState: "starting" }
        });
        if (claimed.count !== 1 || !row.upgradeTo) continue;
        try {
            await upgradeDatabase(row.id, row.environment.project.ownerId, null, row.upgradeTo);
            started += 1;
        } catch (error) {
            failed += 1;
            await prisma.managedDatabase.update({
                where: { id: row.id },
                data: {
                    upgradeState: "failed",
                    upgradeError: error instanceof DatabaseOperationError ? error.message : "The scheduled upgrade could not start."
                }
            });
        }
    }
    return { started, failed };
}
