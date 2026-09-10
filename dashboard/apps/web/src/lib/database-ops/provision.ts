/**
 * What an instance needs once its container answers, that a compose file cannot
 * say: an object store's identities, a MongoDB replica set's initiation, and the
 * archive folder and first base backup of a PostgreSQL instance kept for
 * point-in-time recovery.
 *
 * Run after every successful deploy of a dedicated instance, so each step is
 * safe to repeat. A failure is recorded among the instance's operations - the
 * deploy itself succeeded, and the screen that shows operations is where
 * somebody looking at the instance will see it.
 */

import { prisma } from "@polaris/db";
import type { RuntimePorts } from "@polaris/deploy";
import { mongoInitiateCommand } from "@polaris/core";
import { DatabaseOperationError, instanceContext, runStep, waitReady, withPorts, type InstanceContext } from "./ops";

/** How long a new replica set is given to elect its only member. */
const PRIMARY_WAIT_MS = 60_000;

export async function afterProvision(databaseId: string, ownerId: string): Promise<void> {
    const row = await prisma.managedDatabase.findUnique({
        where: { id: databaseId },
        select: { engine: true, parentId: true, replicaSet: true, pitr: true, upgradeState: true }
    });
    if (!row || row.parentId) return;
    let step = "Setting up";
    try {
        if (row.engine === "seaweedfs") {
            step = "Writing the store's keys";
            const { ensureStoreIdentities, resumeStoreReplications } = await import("@/lib/object-storage/store");
            await ensureStoreIdentities(databaseId, ownerId);
            await resumeStoreReplications(databaseId);
        } else if (row.engine === "mongo" && row.replicaSet) {
            step = "Starting the replica set";
            const context = await instanceContext(databaseId, ownerId);
            await withPorts(context, (ports) => ensureMongoReplicaSet(ports, context));
        } else if (row.engine === "postgres" && row.pitr) {
            step = "Preparing point-in-time recovery";
            const { preparePitr } = await import("./pitr");
            // An upgrade in progress takes its own base backup once its data is
            // loaded; one taken here, of the empty new instance, would be removed
            // from under it.
            await preparePitr(databaseId, ownerId, { baseBackup: row.upgradeState !== "running" });
        }
    } catch (error) {
        const reason =
            error instanceof DatabaseOperationError
                ? error.message
                : "It stopped on something Polaris did not expect. The details are in the server log.";
        if (!(error instanceof DatabaseOperationError)) {
            console.error(`database: setting up ${databaseId} failed:`, error);
        }
        await prisma.databaseOperation.create({
            data: { databaseId, kind: "setup", status: "failed", step, error: reason, finishedAt: new Date() }
        });
    }
}

/**
 * Initiate the replica set, when it is not already, and wait until its member
 * is the primary - a set that is initiated but has not elected yet refuses
 * every write, which is what a restore right after an upgrade would hit.
 */
export async function ensureMongoReplicaSet(ports: RuntimePorts, context: InstanceContext): Promise<void> {
    await waitReady(ports, context);
    const secrets = [context.admin.password];
    await runStep(
        ports,
        context.container,
        mongoInitiateCommand(context.admin.username, context.admin.password, context.container),
        secrets
    );
    const probe = [
        "mongosh",
        "--quiet",
        "-u",
        context.admin.username,
        "-p",
        context.admin.password,
        "--authenticationDatabase",
        "admin",
        "--eval",
        "db.hello().isWritablePrimary"
    ];
    const deadline = Date.now() + PRIMARY_WAIT_MS;
    while (Date.now() < deadline) {
        const result = await ports.runIn(context.container, probe).catch(() => null);
        if (result?.code === 0 && result.output.trim().split(/\r?\n/).at(-1)?.trim() === "true") return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new DatabaseOperationError("The replica set did not elect a primary within a minute.");
}
