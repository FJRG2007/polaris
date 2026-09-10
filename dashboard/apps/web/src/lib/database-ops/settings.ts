/**
 * Settings that change how an instance runs: how Redis keeps what it holds,
 * whether MongoDB runs as a replica set, and the CPU and memory its container may
 * use. Each is stored on the instance and applied by deploying it again, so the
 * setting and what the container does can never disagree.
 */

import { prisma } from "@polaris/db";
import { ensureMongoReplicaSet } from "./provision";
import type { RuntimePorts } from "@polaris/deploy";
import type { RedisMode, ResourceLimitsInput } from "@polaris/core";
import { deployDatabase, deployDatabaseAndWait } from "@/lib/database-service";
import { DatabaseOperationError, instanceContext, lastLine, runStep, waitReady, withPorts } from "./ops";

async function dedicated(databaseId: string, ownerId: string, engine: string) {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        select: {
            id: true,
            engine: true,
            parentId: true,
            mode: true,
            maxMemoryMb: true,
            replicaSet: true,
            containerName: true,
            topology: true
        }
    });
    if (!row) throw new DatabaseOperationError("That database is not there any more.");
    if (row.engine !== engine) throw new DatabaseOperationError("That setting does not apply to this engine.");
    if (row.parentId) throw new DatabaseOperationError("This database lives inside another instance; change the instance.");
    return row;
}

/** How long Redis is given to write its append-only file for the first time. */
const AOF_WAIT_MS = 10 * 60_000;

/**
 * Switch how Redis keeps its data.
 *
 * Going to `persistent` is the one switch that can lose data if done naively:
 * a Redis started with the append-only file on and no such file yet starts
 * EMPTY rather than from its snapshot. So the running instance is told to turn
 * the log on first - it then writes the whole dataset into a new log - and the
 * redeploy waits until that has finished. Going the other way, a snapshot is
 * written first so the restart loads what is there now.
 *
 * A cluster's nodes each keep their own share of the keys, so each is switched
 * the same way before the cluster is deployed again.
 */
export async function setRedisMode(
    databaseId: string,
    ownerId: string,
    userId: string,
    input: { mode: RedisMode; maxMemoryMb?: number }
): Promise<{ deploymentId: string }> {
    const row = await dedicated(databaseId, ownerId, "redis");
    if (row.containerName && row.mode !== input.mode) {
        const context = await instanceContext(databaseId, ownerId);
        const auth = `REDISCLI_AUTH=${context.admin.password}`;
        await withPorts(context, async (ports) => {
            await waitReady(ports, context);
            for (const container of context.cluster ?? [context.container]) {
                await prepareRedisMode(ports, container, auth, input.mode, context.admin.password);
            }
        });
    }
    await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: { mode: input.mode, maxMemoryMb: input.mode === "cache" ? (input.maxMemoryMb ?? 256) : row.maxMemoryMb }
    });
    return { deploymentId: await deployDatabase(databaseId, ownerId, userId) };
}

/** Get one Redis ready to restart in `mode` without losing what it holds. */
async function prepareRedisMode(
    ports: RuntimePorts,
    container: string,
    auth: string,
    mode: RedisMode,
    password: string
): Promise<void> {
    if (mode !== "persistent") {
        const saved = await ports.runIn(container, ["env", auth, "redis-cli", "SAVE"]);
        if (saved.code !== 0 || lastLine(saved.output) !== "OK") {
            throw new DatabaseOperationError(
                `Redis could not write a snapshot first, so nothing was changed: ${lastLine(saved.output, [password])}`
            );
        }
        return;
    }
    await runStep(ports, container, {
        argv: ["env", auth, "redis-cli", "CONFIG", "SET", "appendonly", "yes"],
        describe: "Turning the append-only log on"
    });
    const deadline = Date.now() + AOF_WAIT_MS;
    for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const info = await runStep(ports, container, {
            argv: ["env", auth, "redis-cli", "INFO", "persistence"],
            describe: "Checking the log"
        });
        const field = (name: string) =>
            info
                .split(/\r?\n/)
                .find((line) => line.startsWith(`${name}:`))
                ?.slice(name.length + 1)
                .trim();
        if (field("aof_last_bgrewrite_status") === "err") {
            throw new DatabaseOperationError("Redis could not write its append-only log; nothing was changed.");
        }
        if (field("aof_enabled") === "1" && field("aof_rewrite_in_progress") === "0" && field("aof_rewrite_scheduled") === "0") {
            return;
        }
        if (Date.now() > deadline) {
            throw new DatabaseOperationError("Redis did not finish writing its append-only log in ten minutes.");
        }
    }
}

/**
 * Run a MongoDB instance as a single-member replica set, or stop.
 *
 * Turning it on redeploys with `--replSet` and a key file, then initiates the
 * set and waits for its member to be elected; turning it off redeploys without,
 * which MongoDB supports - the member simply starts as a standalone server
 * with its data, and the replication log it kept is left unused.
 */
export async function setMongoReplicaSet(
    databaseId: string,
    ownerId: string,
    userId: string,
    enabled: boolean
): Promise<void> {
    const row = await dedicated(databaseId, ownerId, "mongo");
    if (row.topology !== "single") {
        throw new DatabaseOperationError("This database is already laid out over several members; that is chosen when it is created.");
    }
    if (row.replicaSet === enabled) return;
    await prisma.managedDatabase.update({ where: { id: databaseId }, data: { replicaSet: enabled } });
    const failure = await deployDatabaseAndWait(databaseId, ownerId, userId);
    if (failure) {
        await prisma.managedDatabase.update({ where: { id: databaseId }, data: { replicaSet: row.replicaSet } });
        await deployDatabaseAndWait(databaseId, ownerId, userId);
        throw new DatabaseOperationError(`The instance did not start that way, so it was put back: ${failure}`);
    }
    if (enabled) {
        const context = await instanceContext(databaseId, ownerId);
        await withPorts(context, (ports) => ensureMongoReplicaSet(ports, context));
    }
}

/**
 * The most CPU and memory an instance's container may use. Applied by deploying
 * it again when it is running; stored for its first start otherwise.
 */
export async function setDatabaseLimits(
    databaseId: string,
    ownerId: string,
    userId: string,
    limits: ResourceLimitsInput
): Promise<{ deploymentId: string | null }> {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        select: { parentId: true, containerName: true, cpuLimit: true, memoryLimitMb: true }
    });
    if (!row) throw new DatabaseOperationError("That database is not there any more.");
    if (row.parentId) throw new DatabaseOperationError("This database lives inside another instance; change the instance.");
    if (row.cpuLimit === limits.cpus && row.memoryLimitMb === limits.memoryMb) return { deploymentId: null };
    await prisma.managedDatabase.update({
        where: { id: databaseId },
        data: { cpuLimit: limits.cpus, memoryLimitMb: limits.memoryMb }
    });
    if (!row.containerName) return { deploymentId: null };
    return { deploymentId: await deployDatabase(databaseId, ownerId, userId) };
}
