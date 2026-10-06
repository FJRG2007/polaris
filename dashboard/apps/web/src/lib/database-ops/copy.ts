/**
 * Copying a database into another: from a managed database, or from one
 * somewhere else given by its connection string.
 *
 * Either way the data travels as a dump in the engine's own format and is
 * loaded by the same steps a restore uses, so the destination's contents are
 * replaced, not merged. From a managed database, the dump is taken in the
 * source's container, streamed out through Polaris and into the destination's.
 * From a connection string, the dump is taken by the destination's own
 * container - which has the engine's client tools and can reach the network -
 * straight into a file inside it, and nothing passes through Polaris at all.
 *
 * From a connection saved in Databases, the same as a connection string - and
 * when that connection reaches its database through SSH, the tunnel is opened
 * here, in the dashboard, and served on the container network the dashboard
 * and the destination share, to the destination's own address alone
 * (`relay.ts`); the dump in the destination's container dials that. The rows
 * pass through Polaris then, and nothing is typed into a terminal anywhere.
 *
 * The destination gets a backup first when it is protected, like a restore.
 */

import { networkInterfaces } from "node:os";
import { prisma } from "@polaris/db";
import { addressOf, DataConnectionError } from "@/lib/data/connections";
import { openTunnel, TunnelError, type DataTunnel } from "@/lib/data/tunnel";
import type { DataAddress } from "@/lib/data/driver";
import { containerNetworks, sharedNetwork } from "./relay";
import { restoreDumpInto } from "./restore";
import { buildSelector } from "@/lib/backups/schemas";
import { dumpInContainer, isDumpableEngine } from "@/lib/backups/sources/databases";
import { externalDumpCommand, parseExternalSource, SHARDED_DUMP_REFUSAL, type ManagedEngine } from "@polaris/core";
import {
    DatabaseOperationError,
    instanceContext,
    lastLine,
    stagedPath,
    startOperation,
    unstage,
    withPorts,
    type InstanceContext,
    type OperationHandle
} from "./ops";

/** Engines whose dumps load into each other. */
function family(engine: string): string {
    return engine === "mariadb" ? "mysql" : engine;
}

/**
 * Start a copy into `databaseId`. Refusals that can be known up front - the
 * wrong engine, an unreadable connection string - are thrown here; the copy
 * itself runs on, followed on the destination's operations.
 */
export async function copyInto(
    databaseId: string,
    ownerId: string,
    actorId: string,
    source: { fromDatabaseId: string } | { fromUrl: string } | { fromConnectionId: string }
): Promise<{ operationId: string }> {
    const into = await instanceContext(databaseId, ownerId);
    if (!isDumpableEngine(into.engine)) throw new DatabaseOperationError("Data cannot be copied into an object store this way.");
    if (into.cluster) throw new DatabaseOperationError("Data cannot be copied into a Redis cluster: each master holds its own share of the keys.");

    let from: InstanceContext | null = null;
    let external: ReturnType<typeof parseExternalSource> = null;
    let saved: SavedSource | null = null;
    if ("fromConnectionId" in source) {
        saved = await savedSource(actorId, source.fromConnectionId, into);
    } else if ("fromDatabaseId" in source) {
        if (source.fromDatabaseId === databaseId) throw new DatabaseOperationError("A database cannot be copied into itself.");
        from = await instanceContext(source.fromDatabaseId, ownerId);
        // A dump of one node would be a copy of that node's share of the keys.
        if (from.cluster) throw new DatabaseOperationError(`${from.name} is a Redis cluster; it cannot be copied from as one database.`);
        if (family(from.engine) !== family(into.engine)) {
            throw new DatabaseOperationError(`${from.name} runs a different engine from ${into.name}.`);
        }
        if (from.topology.kind === "sharded") throw new DatabaseOperationError(SHARDED_DUMP_REFUSAL);
    } else {
        external = parseExternalSource(source.fromUrl, into.engine as ManagedEngine);
        if (!external) {
            throw new DatabaseOperationError(
                "That is not a connection string Polaris can read. Use postgresql://, mysql://, mongodb:// or redis:// with a host name."
            );
        }
        if (family(external.engine) !== family(into.engine)) {
            throw new DatabaseOperationError(`That connection string is for a different engine from ${into.name}.`);
        }
        if (external.engine !== "redis" && !external.database) {
            throw new DatabaseOperationError("Name the database to copy at the end of the connection string.");
        }
    }

    const operation = await startOperation(databaseId, "copy", actorId);
    void (async () => {
        try {
            await safetyCopy(databaseId, actorId, operation);
            if (from) await copyFromManaged(from, into, ownerId, operation);
            else if (external) await copyFromExternal(external, into, operation);
            else if (saved) await copyFromSaved(saved, into, operation);
            await operation.succeed();
        } catch (error) {
            await operation.fail(error);
        }
    })();
    return { operationId: operation.id };
}

/** A backup of the destination first, when it is protected - its contents are
 *  about to be replaced. */
async function safetyCopy(databaseId: string, actorId: string, operation: OperationHandle): Promise<void> {
    const resource = await prisma.protectedResource.findFirst({
        where: { selector: buildSelector("managed-database", [databaseId]) },
        select: { id: true }
    });
    if (!resource) return;
    await operation.step("Taking a backup of what is there now");
    const { runBackup } = await import("@/lib/backups/service");
    const copy = await runBackup(resource.id, { trigger: "pre-restore", actorUserId: actorId });
    if (copy.status === "failed") {
        throw new DatabaseOperationError("The backup of what is there now failed, so nothing was copied.");
    }
}

async function copyFromManaged(
    from: InstanceContext,
    into: InstanceContext,
    ownerId: string,
    operation: OperationHandle
): Promise<void> {
    if (!isDumpableEngine(from.engine)) throw new DatabaseOperationError("That source cannot be dumped.");
    await operation.step(`Copying out ${from.name}`);
    const artifact = await dumpInContainer({
        ownerId,
        targetId: from.target.id,
        container: from.container,
        engine: from.engine,
        database: from.own.database,
        username: from.own.username,
        password: from.own.password,
        authDatabase: from.hosted ? from.own.database : "admin",
        label: from.slug,
        ...(from.mongoSeeds ? { mongoSeeds: from.mongoSeeds } : {})
    }).catch((error: unknown) => {
        throw new DatabaseOperationError(`Copying out ${from.name} failed${error instanceof Error ? `: ${error.message}` : ""}`);
    });
    try {
        await operation.progress(0, artifact.sizeBytes);
        await restoreDumpInto(into, { local: artifact.path }, { operation, sourceDatabase: from.own.database });
    } finally {
        await artifact.cleanup();
    }
}

/**
 * Dump a database somewhere else from inside the destination's container,
 * reporting how much has arrived while it runs - the dump is one long command,
 * so its file is measured beside it every few seconds.
 */
async function copyFromExternal(
    source: NonNullable<ReturnType<typeof parseExternalSource>>,
    into: InstanceContext,
    operation: OperationHandle,
    /** What the step is called, when the address is not something to show. */
    describe?: string
): Promise<void> {
    const file = stagedPath(operation.id, into.engine === "redis" ? "rdb" : "dump");
    // Only the engine's client tools are used here, so the destination does not
    // have to be answering yet; the load that follows waits for it.
    await withPorts(into, async (ports) => {
        const command = externalDumpCommand(source, file);
        await operation.step(describe ?? command.describe);
        let running = true;
        const measuring = (async () => {
            while (running) {
                await new Promise((resolve) => setTimeout(resolve, 3000));
                if (!running) break;
                const size = await ports.runIn(into.container, ["sh", "-c", 'wc -c < "$1" 2>/dev/null || echo 0', "polaris", file]).catch(() => null);
                const bytes = Number.parseInt(size?.output.trim() ?? "", 10);
                if (Number.isFinite(bytes) && bytes > 0) await operation.progress(bytes).catch(() => undefined);
            }
        })();
        try {
            const result = await ports.runIn(into.container, command.argv);
            if (result.code !== 0) {
                throw new DatabaseOperationError(
                    `${command.describe} failed: ${lastLine(result.output, [source.password]) || `exit status ${result.code}`}`
                );
            }
        } catch (error) {
            await unstage(ports, into.container, file);
            throw error;
        } finally {
            running = false;
            await measuring;
        }
    });
    await restoreDumpInto(into, { inside: file }, { operation, sourceDatabase: source.database || undefined });
}

/** A saved connection, resolved to what the dump needs. */
interface SavedSource {
    readonly name: string;
    readonly external: NonNullable<ReturnType<typeof parseExternalSource>>;
    /** The SSH tunnel it is reached through, with where it leads. */
    readonly tunnel: { readonly via: DataTunnel; readonly host: string; readonly port: number } | null;
}

/**
 * A connection saved in Databases, read the way Databases opens it - as the
 * person, with their access, the egress rules and the pinned SSH keys - and
 * refused here for what a copy cannot do with it.
 */
async function savedSource(
    actorId: string,
    connectionId: string,
    into: InstanceContext
): Promise<SavedSource> {
    const row = await prisma.dataConnection.findFirst({
        where: { id: connectionId, ownerId: actorId, managedDatabaseId: null },
        select: { name: true }
    });
    if (!row) throw new DatabaseOperationError("That connection is not there any more.");
    let address: DataAddress;
    try {
        address = await addressOf(actorId, connectionId);
    } catch (error) {
        throw readableRefusal(error, DataConnectionError, "That connection could not be opened.");
    }
    if (family(address.engine) !== family(into.engine))
        throw new DatabaseOperationError(`${row.name} runs a different engine from ${into.name}.`);
    if (address.engine !== "redis" && !address.database)
        throw new DatabaseOperationError(`${row.name} names no database to copy. Set one on the connection in Databases.`);
    if (address.tls.mode === "verify-ca" || address.tls.mode === "verify-full" || address.tls.clientCert)
        throw new DatabaseOperationError(
            `${row.name} checks the database's certificate or signs in with one, which a copy cannot do yet, so nothing was sent to it.`
        );
    if (address.tunnel && into.target.kind !== "local")
        throw new DatabaseOperationError(
            `${row.name} is reached through SSH, which only a database on the machine Polaris runs on can be copied into. ${into.name} runs on another server.`
        );
    return {
        name: row.name,
        external: {
            engine: address.engine === "mysql" && into.engine === "mariadb" ? "mariadb" : address.engine,
            host: address.host,
            port: address.port,
            database: address.engine === "redis" ? "" : (address.database ?? ""),
            username: address.username ?? "",
            password: address.password ?? "",
            tls: address.tls.mode !== "disable",
            authSource: address.authSource ?? "admin"
        },
        tunnel: address.tunnel ? { via: address.tunnel, host: address.host, port: address.port } : null
    };
}

/**
 * Dump a saved connection's database into this one. Straight from the
 * destination's container when it can dial it; through a tunnel opened here
 * and served to that container alone when the database is behind SSH.
 */
async function copyFromSaved(
    saved: SavedSource,
    into: InstanceContext,
    operation: OperationHandle
): Promise<void> {
    const describe = saved.external.database
        ? `Copying ${saved.external.database} from ${saved.name}`
        : `Copying the dataset from ${saved.name}`;
    if (!saved.tunnel) {
        await copyFromExternal(saved.external, into, operation, describe);
        return;
    }
    await operation.step(`Opening the SSH tunnel to ${saved.name}`);
    const relay = await withPorts(into, async (ports) =>
        sharedNetwork(
            Object.values(networkInterfaces()).flatMap((faces) => faces ?? []),
            containerNetworks(await ports.inspect(into.container).catch(() => null))
        )
    );
    if (!relay)
        throw new DatabaseOperationError(
            `${into.name} is not on a network Polaris can reach it on, so the SSH tunnel to ${saved.name} cannot be handed to it. Redeploy ${into.name} and try again.`
        );
    const tunnel = await openTunnel(saved.tunnel.via, saved.tunnel.host, saved.tunnel.port, undefined, {
        bindHost: relay.bindHost,
        allowFrom: relay.containerIp
    }).catch((error: unknown) => {
        throw readableRefusal(error, TunnelError, `The SSH tunnel to ${saved.name} did not open.`);
    });
    try {
        await copyFromExternal(
            { ...saved.external, host: tunnel.host, port: tunnel.port },
            into,
            operation,
            describe
        );
    } finally {
        tunnel.close();
    }
}

/** A refusal written for the reader, said as itself; anything else is logged
 *  and replaced, because it can name internals and addresses. */
function readableRefusal(
    error: unknown,
    readable: abstract new (...args: never[]) => Error,
    fallback: string
): DatabaseOperationError {
    if (error instanceof readable) return new DatabaseOperationError(error.message);
    console.error("database: a saved connection could not be copied from:", error);
    return new DatabaseOperationError(fallback);
}
