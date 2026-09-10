/**
 * The two database sources: Polaris' own, and the ones it runs for your services.
 *
 * They share a file because they share the hard part. A dump is produced by the
 * engine's own tool - pg_dump, mysqldump, mongodump - and those tools live
 * inside the database's container, not inside Polaris. So the shape is always:
 * run the dump inside a container to a file, stream that file out as bytes, then
 * delete it. Streaming rather than collecting matters more here than anywhere
 * else: a database dump is exactly the artifact that does not fit in a string.
 *
 * The Polaris database is the exception and is much simpler - it is read through
 * Prisma, which is already connected to it - so it needs no container at all.
 */

import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { buildSelector } from "../schemas";
import { createWriteStream } from "node:fs";
import { prisma, Prisma } from "@polaris/db";
import { pipeline } from "node:stream/promises";
import { getPorts } from "@/lib/deploy/runtime";
import { SHARDED_DUMP_REFUSAL } from "@polaris/core";
import { restoreDumpInto } from "@/lib/database-ops/restore";
import { createZipStream, type ZipSource } from "@/lib/zip-stream";
import { instanceContext, startOperation } from "@/lib/database-ops/ops";
import { databaseClusterNodes, databaseConnection } from "@/lib/database-service";
import {
    SourceUnavailableError,
    shellQuote,
    stageDir,
    stagedFrom,
    stamp,
    type BackupSource,
    type DiscoveredTarget,
    type SourceResource,
    type StagedArtifact
} from "./types";

/** How the engines are dumped, and what the result is called. */
const DUMPERS = {
    postgres: {
        extension: "sql.gz",
        argv: (db: string, user: string) => [
            "pg_dump",
            "--no-owner",
            "--no-acl",
            "-U",
            user,
            "-d",
            db
        ]
    },
    mysql: {
        extension: "sql.gz",
        argv: (db: string, user: string, password: string) => [
            "mysqldump",
            "--single-transaction",
            "--set-gtid-purged=OFF",
            "--routines",
            "--triggers",
            `-u${user}`,
            `-p${password}`,
            db
        ]
    },
    mariadb: {
        extension: "sql.gz",
        argv: (db: string, user: string, password: string) => [
            "mariadb-dump",
            "--single-transaction",
            "--routines",
            "--triggers",
            `-u${user}`,
            `-p${password}`,
            db
        ]
    },
    mongo: {
        extension: "archive.gz",
        // A dedicated instance's account is root, in `admin`; a database hosted on
        // an instance has its account created inside itself - see `authDatabase`.
        //
        // A replica set of several members is read from a secondary, so a backup
        // does not load the primary: the set is named by its seed list and reads
        // prefer a secondary, falling back to the primary only when none answers.
        // Without `--oplog`: that option needs a dump of the whole instance, and
        // replaying one refuses any namespace filter, while a copy here is of one
        // database and is restored into one.
        argv: (db: string, user: string, password: string, authDb = "admin", seeds?: string) => [
            "mongodump",
            ...(seeds ? [`--host=${seeds}`, "--readPreference=secondaryPreferred"] : []),
            `--db=${db}`,
            `--username=${user}`,
            `--password=${password}`,
            `--authenticationDatabase=${authDb}`,
            "--archive",
            "--gzip"
        ]
    },
    redis: {
        // Redis has no dump-to-stdout: what exists is the snapshot file it keeps.
        extension: "rdb",
        argv: () => ["redis-cli", "--no-auth-warning", "SAVE"]
    }
} as const;

type Engine = keyof typeof DUMPERS;

function isEngine(value: unknown): value is Engine {
    return typeof value === "string" && value in DUMPERS;
}

/**
 * Polaris' own database.
 *
 * A gzipped JSON snapshot of every table read through Prisma, which needs no
 * external tool and works the same on Postgres and on the SQLite dev database.
 * BigInt columns are tagged so they round-trip; Bytes keep Prisma's Buffer JSON
 * shape.
 */
export const polarisDatabaseSource: BackupSource = {
    kind: "polaris-database",

    async discover(): Promise<DiscoveredTarget[]> {
        return [
            {
                kind: "polaris-database",
                selector: buildSelector("polaris-database"),
                name: "Polaris database",
                context: "This deployment",
                target: { kind: "polaris-database" }
            }
        ];
    },

    async resolveName(): Promise<string> {
        return "Polaris database";
    },

    async produce(): Promise<StagedArtifact> {
        const dir = await stageDir();
        const at = new Date();
        const fileName = `polaris-${stamp(at)}.json.gz`;
        const target = join(dir, fileName);

        const client = prisma as unknown as Record<
            string,
            { findMany?: (args?: unknown) => Promise<unknown[]> }
        >;
        const tables: Record<string, unknown[]> = {};
        for (const model of Prisma.dmmf.datamodel.models) {
            const key = model.name.charAt(0).toLowerCase() + model.name.slice(1);
            const delegate = client[key];
            if (delegate?.findMany) tables[model.name] = await delegate.findMany();
        }
        const payload = JSON.stringify(
            { format: "polaris-backup", version: 1, createdAt: at.toISOString(), tables },
            (_key, value) => (typeof value === "bigint" ? `__bigint__${value.toString()}` : value)
        );
        await pipeline(Readable.from([payload]), createGzip(), createWriteStream(target));
        return stagedFrom(dir, target, fileName, {
            format: "polaris-backup",
            version: 1,
            models: Object.keys(tables).length
        });
    }
};

/** A database Polaris runs for one of your services. */
export const managedDatabaseSource: BackupSource = {
    kind: "managed-database",

    async discover(ownerId: string): Promise<DiscoveredTarget[]> {
        const rows = await prisma.managedDatabase.findMany({
            where: { environment: { project: { ownerId } }, status: { not: "removed" } },
            select: {
                id: true,
                name: true,
                engine: true,
                topology: true,
                parent: { select: { topology: true } },
                environment: { select: { name: true, project: { select: { name: true } } } }
            },
            take: 500
        });
        return (
            rows
                // A sharded cluster cannot be copied consistently yet, so it is not
                // offered; its Manage panel says so.
                .filter((row) => isEngine(row.engine) && (row.parent ?? row).topology !== "sharded")
                .map((row) => ({
                    kind: "managed-database" as const,
                    selector: buildSelector("managed-database", [row.id]),
                    name: row.name,
                    context: `${row.environment.project.name} / ${row.environment.name}`,
                    target: { kind: "managed-database", databaseId: row.id }
                }))
        );
    },

    async resolveName(resource: SourceResource): Promise<string | null> {
        const id = resource.selector.split(":")[1];
        if (!id) return null;
        const row = await prisma.managedDatabase.findUnique({
            where: { id },
            select: { name: true }
        });
        return row?.name ?? null;
    },

    async produce(resource: SourceResource): Promise<StagedArtifact> {
        const id = resource.selector.split(":")[1];
        if (!id) throw new SourceUnavailableError("This database's id is missing from its record");
        const row = await prisma.managedDatabase.findUnique({
            where: { id },
            select: {
                engine: true,
                containerName: true,
                targetId: true,
                parentId: true,
                name: true,
                topology: true,
                clusterMasters: true,
                parent: { select: { topology: true } }
            }
        });
        if (!row) throw new SourceUnavailableError("That database no longer exists");
        if (!isEngine(row.engine)) {
            throw new SourceUnavailableError(`Polaris cannot dump a ${row.engine} database yet`);
        }
        if ((row.parent ?? row).topology === "sharded")
            throw new SourceUnavailableError(SHARDED_DUMP_REFUSAL);
        const connection = await databaseConnection(id, resource.ownerId);
        const nodes = databaseClusterNodes(row);
        if (nodes && row.clusterMasters) {
            return dumpRedisCluster({
                ownerId: resource.ownerId,
                targetId: row.targetId,
                nodes,
                masters: row.clusterMasters,
                password: connection.password,
                label: resource.name || row.name
            });
        }
        // A logical database inside another instance is reached through its
        // parent's container; it has none of its own, so the connection's host -
        // which IS the container name on the proxy network - is what to exec in.
        const container = row.containerName || connection.host;
        if (!container) {
            throw new SourceUnavailableError("That database has no container to run the dump in");
        }
        return dumpInContainer({
            ownerId: resource.ownerId,
            targetId: row.targetId,
            container,
            engine: row.engine,
            database: connection.database,
            username: connection.username,
            password: connection.password,
            authDatabase: row.parentId ? connection.database : "admin",
            label: resource.name || row.name,
            ...(connection.replicaSet && connection.hosts.length > 1
                ? { mongoSeeds: seedsOf(connection) }
                : {})
        });
    },

    /**
     * Put a copy back into the running instance.
     *
     * A copy of what is there NOW is taken first, through the ordinary backup
     * engine, so it lands in the same destinations and the same history as any
     * other - and if it cannot be taken, nothing is restored: replacing a
     * database with no way back is not something to do on a button press.
     * Then the dump is applied by the same path an upgrade and a copy use.
     */
    async restore(
        resource: SourceResource,
        body: ReadableStream<Uint8Array>,
        metadata: Record<string, unknown>,
        actorId: string
    ): Promise<void> {
        const id = resource.selector.split(":")[1];
        if (!id) throw new SourceUnavailableError("This database's id is missing from its record");
        // Refused before the safety copy: neither can go anywhere, and a copy
        // taken for a restore that never happens is only noise in the history.
        const row = await prisma.managedDatabase.findUnique({
            where: { id },
            select: { clusterMasters: true }
        });
        if (row?.clusterMasters) {
            throw new SourceUnavailableError(
                "A Redis cluster cannot be restored in place: each master holds its own share of the keys. Nothing was changed."
            );
        }
        if (metadata.cluster || String(metadata.fileName ?? "").endsWith(".redis-cluster.zip")) {
            throw new SourceUnavailableError(
                "This backup is of a Redis cluster: it holds each master's snapshot separately, and cannot be loaded into a single instance. Nothing was changed."
            );
        }
        const { runBackup } = await import("../service");
        const safety = await runBackup(resource.id, {
            trigger: "pre-restore",
            actorUserId: actorId
        });
        if (safety.status === "failed") {
            const why = safety.failures
                .map((failure) => `${failure.destination}: ${failure.reason}`)
                .join("; ");
            throw new SourceUnavailableError(
                `Nothing was restored: a copy of what is there now could not be taken first${why ? ` (${why})` : ""}.`
            );
        }

        const dir = await stageDir();
        const staged = join(dir, "restore");
        try {
            await pipeline(
                Readable.fromWeb(body as import("node:stream/web").ReadableStream),
                createWriteStream(staged)
            );
            const context = await instanceContext(id, resource.ownerId);
            const operation = await startOperation(id, "restore", actorId);
            try {
                await restoreDumpInto(
                    context,
                    { local: staged },
                    {
                        operation,
                        // Only MongoDB names the database inside the dump; a copy of
                        // the same database restores into itself either way.
                        ...(typeof metadata.database === "string" && metadata.database
                            ? { sourceDatabase: metadata.database }
                            : {})
                    }
                );
                await operation.succeed();
            } catch (error) {
                throw new SourceUnavailableError(await operation.fail(error));
            }
        } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
};

export interface DumpRequest {
    readonly ownerId: string;
    readonly targetId: string;
    readonly engine: Engine;
    readonly database: string;
    readonly username: string;
    readonly password: string;
    readonly label: string;
    /** Dump inside a container that is already running. */
    readonly container: string;
    /** MongoDB only: where the account signs in - `admin` for a dedicated
     *  instance's root account, the database itself for a hosted one. */
    readonly authDatabase?: string;
    /** MongoDB only: a replica set of several members as a seed list, so the
     *  dump is read from a secondary. */
    readonly mongoSeeds?: string;
}

/** A replica set connection as the seed list the database tools' `--host` reads. */
function seedsOf(connection: {
    hosts: readonly string[];
    replicaSet: string | null;
    port: number;
}): string {
    return `${connection.replicaSet}/${connection.hosts.map((host) => `${host}:${connection.port}`).join(",")}`;
}

/** The engines a dump can be taken of. */
export function isDumpableEngine(value: unknown): value is Engine {
    return isEngine(value);
}

/**
 * Run the engine's dump tool and stage what it produced.
 *
 * The dump is written to a file inside the container and then streamed out,
 * rather than piped through the exec channel: the channel collects into a
 * string, and a string is the one thing a dump must never become. The temporary
 * file is removed whether the read succeeded or not - a failed backup that fills
 * the database's own disk is worse than no backup.
 */
export async function dumpInContainer(request: DumpRequest): Promise<StagedArtifact> {
    const dumper = DUMPERS[request.engine];
    const at = new Date();
    const safeLabel = request.label.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "database";
    const fileName = `${safeLabel}-${stamp(at)}.${dumper.extension}`;
    const inContainer = `/tmp/polaris-backup-${stamp(at)}.dump`;

    const target = await prisma.deployTarget.findFirst({
        where: { id: request.targetId },
        select: { id: true, kind: true, hostId: true, runtime: true, proxyNetwork: true }
    });
    if (!target)
        throw new SourceUnavailableError("The server this database runs on is not registered");

    const ports = await getPorts(target, request.ownerId);
    const container = request.container;
    try {
        const argv =
            request.engine === "mongo"
                ? [
                      ...DUMPERS.mongo.argv(
                          request.database,
                          request.username,
                          request.password,
                          request.authDatabase,
                          request.mongoSeeds
                      )
                  ]
                : [...dumper.argv(request.database, request.username, request.password)];
        // redis-cli exits 0 on an error reply, so the answer itself is checked:
        // a refused SAVE must not be followed by copying a stale snapshot.
        const command =
            request.engine === "redis"
                ? [
                      "sh",
                      "-c",
                      `[ "$(redis-cli --no-auth-warning SAVE)" = "OK" ] && cp /data/dump.rdb ${inContainer}`
                  ]
                : ["sh", "-c", `${argv.map(shellQuote).join(" ")} > ${inContainer}`];
        // Redis is started with `--requirepass`, so an unauthenticated SAVE was
        // refused and the copy that followed was whatever snapshot Redis had last
        // written on its own schedule - or nothing at all.
        const environment =
            request.engine === "postgres"
                ? { PGPASSWORD: request.password }
                : request.engine === "redis"
                  ? { REDISCLI_AUTH: request.password }
                  : {};
        const result = await ports.runIn(
            container,
            Object.keys(environment).length > 0
                ? [
                      "env",
                      ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
                      ...command
                  ]
                : command
        );
        if (result.code !== 0) {
            throw new SourceUnavailableError(
                `The dump failed inside ${container}: ${result.output.trim().slice(0, 400) || `exit ${result.code}`}`
            );
        }

        const dir = await stageDir();
        const staged = join(dir, fileName);
        const bytes = await ports.readFile(container, inContainer);
        const source = Readable.fromWeb(bytes as import("node:stream/web").ReadableStream);
        // Mongo gzips its own archive; everything else is compressed on the way
        // through, so a SQL dump does not land as tens of gigabytes of text.
        if (dumper.extension.endsWith(".gz") && request.engine !== "mongo") {
            await pipeline(source, createGzip(), createWriteStream(staged));
        } else {
            await pipeline(source, createWriteStream(staged));
        }
        return stagedFrom(dir, staged, fileName, {
            engine: request.engine,
            database: request.database,
            takenAt: at.toISOString()
        });
    } finally {
        await ports.runIn(container, ["rm", "-f", "--", inContainer]).catch(() => undefined);
        await ports.dispose();
    }
}

export interface ClusterDumpRequest {
    readonly ownerId: string;
    readonly targetId: string;
    /** Every node of the cluster, the first node first. */
    readonly nodes: readonly string[];
    /** How many masters the cluster was created with. */
    readonly masters: number;
    readonly password: string;
    readonly label: string;
}

/**
 * Back a Redis Cluster up: every master's snapshot, in one zip.
 *
 * Each master holds its own share of the keys, and a replica only a copy of its
 * master's, so the backup is one RDB file per master - written by SAVE on that
 * master, one master after another - beside `nodes.txt`, the cluster's own
 * account of which node served which slots when it was taken. Refused unless
 * every master answers: a backup of part of a cluster looks whole and is not.
 */
export async function dumpRedisCluster(request: ClusterDumpRequest): Promise<StagedArtifact> {
    const at = new Date();
    const safeLabel = request.label.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "database";
    const fileName = `${safeLabel}-${stamp(at)}.redis-cluster.zip`;
    const inContainer = `/tmp/polaris-backup-${stamp(at)}.rdb`;
    const first = request.nodes[0];
    if (!first) throw new SourceUnavailableError("That cluster has no nodes to take a backup of");

    const target = await prisma.deployTarget.findFirst({
        where: { id: request.targetId },
        select: { id: true, kind: true, hostId: true, runtime: true, proxyNetwork: true }
    });
    if (!target)
        throw new SourceUnavailableError("The server this database runs on is not registered");

    const ports = await getPorts(target, request.ownerId);
    const auth = `REDISCLI_AUTH=${request.password}`;
    const written: string[] = [];
    try {
        // Which node is a master is the cluster's to decide, and moves when one
        // fails over, so it is asked rather than assumed.
        const masters: string[] = [];
        for (const node of request.nodes) {
            const role = await ports
                .runIn(node, ["env", auth, "redis-cli", "--no-auth-warning", "ROLE"])
                .catch(() => null);
            if (role?.code === 0 && role.output.trim().split(/\r?\n/)[0]?.trim() === "master")
                masters.push(node);
        }
        if (masters.length !== request.masters) {
            throw new SourceUnavailableError(
                `${masters.length} of the cluster's ${request.masters} masters answered, so no backup was taken: a copy of part of a cluster is not a backup of it.`
            );
        }
        for (const node of masters) {
            // redis-cli exits 0 on an error reply, so the answer itself is checked.
            const result = await ports.runIn(node, [
                "env",
                auth,
                "sh",
                "-c",
                `[ "$(redis-cli --no-auth-warning SAVE)" = "OK" ] && cp /data/dump.rdb ${inContainer}`
            ]);
            written.push(node);
            if (result.code !== 0) {
                throw new SourceUnavailableError(
                    `The snapshot failed on ${node}: ${result.output.trim().slice(0, 400) || `exit ${result.code}`}`
                );
            }
        }
        const topology = await ports.runIn(first, [
            "env",
            auth,
            "redis-cli",
            "--no-auth-warning",
            "CLUSTER",
            "NODES"
        ]);
        const nodesText = Buffer.from(topology.code === 0 ? topology.output : "");

        const sources: ZipSource[] = [
            ...masters.map((node) => ({
                name: `${node}.rdb`,
                kind: "file" as const,
                size: 0n,
                mtime: at,
                body: () => ports.readFile(node, inContainer)
            })),
            {
                name: "nodes.txt",
                kind: "file",
                size: BigInt(nodesText.length),
                mtime: at,
                body: async () => new Blob([nodesText]).stream()
            }
        ];
        const dir = await stageDir();
        const staged = join(dir, fileName);
        await pipeline(
            Readable.fromWeb(createZipStream(sources) as import("node:stream/web").ReadableStream),
            createWriteStream(staged)
        );
        return stagedFrom(dir, staged, fileName, {
            engine: "redis",
            // What a restore reads to know this is not one instance's snapshot.
            cluster: { masters: masters.length, files: masters.map((node) => `${node}.rdb`) },
            takenAt: at.toISOString()
        });
    } finally {
        for (const node of written)
            await ports.runIn(node, ["rm", "-f", "--", inContainer]).catch(() => undefined);
        await ports.dispose();
    }
}
