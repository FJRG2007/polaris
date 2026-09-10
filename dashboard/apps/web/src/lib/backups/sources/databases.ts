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
import { databaseConnection } from "@/lib/database-service";
import { restoreDumpInto } from "@/lib/database-ops/restore";
import { instanceContext, startOperation } from "@/lib/database-ops/ops";
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
        argv: (db: string, user: string, password: string, authDb = "admin") => [
            "mongodump",
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
                environment: { select: { name: true, project: { select: { name: true } } } }
            },
            take: 500
        });
        return rows
            .filter((row) => isEngine(row.engine))
            .map((row) => ({
                kind: "managed-database" as const,
                selector: buildSelector("managed-database", [row.id]),
                name: row.name,
                context: `${row.environment.project.name} / ${row.environment.name}`,
                target: { kind: "managed-database", databaseId: row.id }
            }));
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
                name: true
            }
        });
        if (!row) throw new SourceUnavailableError("That database no longer exists");
        if (!isEngine(row.engine)) {
            throw new SourceUnavailableError(`Polaris cannot dump a ${row.engine} database yet`);
        }
        const connection = await databaseConnection(id, resource.ownerId);
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
            label: resource.name || row.name
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
                          request.authDatabase
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
