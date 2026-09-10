/**
 * Putting a dump back into a running instance.
 *
 * One path for everything that loads data - a backup restored from the console,
 * the reload half of a version upgrade, a copy from another database - so the
 * three can never disagree about how a dump is applied. The dump is staged
 * inside the instance's container (the engine's own client tools live there)
 * and applied by the steps `restoreCommands` builds; Redis, which only reads a
 * snapshot at startup, is loaded by replication instead so it never stops.
 */

import type { RuntimePorts } from "@polaris/deploy";
import {
    redisReplicateFrom,
    redisReplicationInfo,
    redisRestoreFinish,
    redisRestoreStart,
    redisSyncDone,
    restoreCommands,
    type DbPrivilege
} from "@polaris/core";
import {
    DatabaseOperationError,
    runStep,
    stagedPath,
    stageInto,
    unstage,
    waitReady,
    withPorts,
    type InstanceContext,
    type OperationHandle
} from "./ops";

/** How long a Redis load by replication may take before it is abandoned. */
const REDIS_SYNC_WAIT_MS = 30 * 60_000;

/**
 * Replace a database's contents with a dump: one staged on this machine
 * (`local`), which is copied into the container first, or one already written
 * inside the container (`inside`) - a copy from a database somewhere else is
 * dumped straight there. Either way the file inside is removed afterwards.
 *
 * `sourceDatabase` names the database a MongoDB dump was taken from when it is
 * not the one being restored into - a copy between databases.
 */
export async function restoreDumpInto(
    context: InstanceContext,
    file: { readonly local: string } | { readonly inside: string },
    options: { operation: OperationHandle; sourceDatabase?: string }
): Promise<void> {
    const engine = context.engine;
    if (engine === "seaweedfs") {
        throw new DatabaseOperationError(
            "An object store is restored from its own bucket copies, not from a dump."
        );
    }
    const { operation } = options;
    await withPorts(context, async (ports) => {
        await operation.step("Waiting for the database to answer");
        await waitReady(ports, context);
        let inside: string;
        if ("inside" in file) {
            inside = file.inside;
        } else {
            inside = stagedPath(operation.id, context.engine === "redis" ? "rdb" : "dump");
            await operation.step("Copying the data into the container");
            await stageInto(ports, context.container, file.local, inside, (done, total) => {
                void operation.progress(done, total).catch(() => undefined);
            });
        }
        try {
            if (engine === "redis") {
                await loadRedis(ports, context, inside, operation);
                return;
            }
            const steps = restoreCommands({
                engine,
                database: context.own.database,
                username: context.own.username,
                password: context.own.password,
                privileges: context.privileges as DbPrivilege,
                adminUser:
                    engine === "mysql" || engine === "mariadb" ? "root" : context.admin.username,
                adminPassword: context.admin.password,
                hosted: context.hosted,
                file: inside,
                ...(options.sourceDatabase ? { sourceDatabase: options.sourceDatabase } : {})
            });
            for (const step of steps) {
                await operation.step(step.describe);
                await runStep(ports, context.container, step, [
                    context.admin.password,
                    context.own.password
                ]);
            }
        } finally {
            await unstage(ports, context.container, inside);
        }
    });
}

/**
 * Load a Redis snapshot through a private replica source (see
 * `redisRestoreStart`): the instance keeps answering, refuses writes for the
 * moment the load takes, and comes back as its own primary.
 */
async function loadRedis(
    ports: RuntimePorts,
    context: InstanceContext,
    file: string,
    operation: OperationHandle
): Promise<void> {
    const dir = `/tmp/polaris-restore-${operation.id}`;
    const password = context.admin.password;
    for (const step of redisRestoreStart(file, dir)) {
        await operation.step(step.describe);
        await runStep(ports, context.container, step, [password]);
    }
    try {
        const replicate = redisReplicateFrom(password);
        await operation.step(replicate.describe);
        await runStep(ports, context.container, replicate, [password]);
        const deadline = Date.now() + REDIS_SYNC_WAIT_MS;
        const probe = redisReplicationInfo(password);
        for (;;) {
            // A second before the first read: the replica has to connect and ask
            // for the sync before INFO says anything about it.
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const info = await runStep(ports, context.container, probe, [password]);
            if (redisSyncDone(info)) break;
            if (Date.now() > deadline) {
                throw new DatabaseOperationError(
                    "Redis did not finish loading the snapshot in 30 minutes."
                );
            }
        }
    } finally {
        // Promoted back whatever happened, so a failed load never leaves the
        // instance following a server that is about to be stopped.
        for (const step of redisRestoreFinish(password, dir)) {
            await ports.runIn(context.container, step.argv).catch(() => undefined);
        }
    }
}
