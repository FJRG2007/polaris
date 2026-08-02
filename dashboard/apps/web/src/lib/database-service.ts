/**
 * Managed databases: one-click PostgreSQL/MySQL/MariaDB/MongoDB/Redis.
 *
 * A database is created one of two ways. A dedicated instance is a container
 * plus a schema row and an auto-named volume; its container name is its DNS
 * hostname on the proxy network, so other services reach it by name. A database
 * on an existing instance is a logical database created inside a container that
 * is already running - no image, no volume, no container of its own - which is
 * how several small apps share one engine process instead of paying for one
 * each. `parentId` is what tells the two apart, and every step below branches on
 * it: provisioning runs statements instead of a deploy, and removal drops the
 * database instead of tearing a container down.
 *
 * Credentials are generated at create time (or taken from the request) and
 * stored envelope-encrypted. Deploys reuse the exact same runner and per-target
 * queue as applications.
 */

import { prisma } from "@polaris/db";
import { randomBytes } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { getPorts, type TargetRow } from "./deploy/runtime";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";
import { serviceName, shortHash, slugify, type DbDeployPlan } from "@polaris/deploy";
import { deployLogPath, enqueueOnTarget, executeDeployment } from "./deploy-service";
import {
    createDatabaseCommands,
    databaseCreateSchema,
    DB_ENGINE_INFO,
    dropDatabaseCommands,
    type ContainerCommand,
    type DatabaseCreate,
    type DatabaseGrant,
    type DbEngine,
    type DbPrivilege
} from "@polaris/core";

export type { DbEngine };

interface DbCredentials {
    username: string;
    password: string;
    database: string;
}

interface EngineSpec {
    readonly defaultVersion: string;
    readonly dataPath: string;
    readonly port: number;
    image(version: string): string;
    env(creds: DbCredentials): Record<string, string>;
    /** Entrypoint arguments, for an engine that is not configured by environment. */
    command?(creds: DbCredentials): string[];
}

const ENGINES: Record<DbEngine, EngineSpec> = {
    postgres: {
        defaultVersion: "16",
        dataPath: "/var/lib/postgresql/data",
        port: 5432,
        image: (version) => `postgres:${version}-alpine`,
        env: (creds) => ({
            POSTGRES_USER: creds.username,
            POSTGRES_PASSWORD: creds.password,
            POSTGRES_DB: creds.database
        })
    },
    mysql: {
        defaultVersion: "8",
        dataPath: "/var/lib/mysql",
        port: 3306,
        image: (version) => `mysql:${version}`,
        env: (creds) => ({
            MYSQL_ROOT_PASSWORD: creds.password,
            MYSQL_DATABASE: creds.database,
            MYSQL_USER: creds.username,
            MYSQL_PASSWORD: creds.password
        })
    },
    mariadb: {
        defaultVersion: "11",
        dataPath: "/var/lib/mysql",
        port: 3306,
        image: (version) => `mariadb:${version}`,
        env: (creds) => ({
            MARIADB_ROOT_PASSWORD: creds.password,
            MARIADB_DATABASE: creds.database,
            MARIADB_USER: creds.username,
            MARIADB_PASSWORD: creds.password
        })
    },
    mongo: {
        defaultVersion: "7",
        dataPath: "/data/db",
        port: 27017,
        image: (version) => `mongo:${version}`,
        env: (creds) => ({
            MONGO_INITDB_ROOT_USERNAME: creds.username,
            MONGO_INITDB_ROOT_PASSWORD: creds.password,
            MONGO_INITDB_DATABASE: creds.database
        })
    },
    redis: {
        defaultVersion: "7",
        dataPath: "/data",
        port: 6379,
        image: (version) => `redis:${version}-alpine`,
        // The official image reads no password from the environment at all, so
        // REDIS_PASSWORD alone left the server open to anything on the proxy
        // network. `--requirepass` is how the image documents enabling auth, and
        // is what actually makes the stored password mean something.
        env: () => ({}),
        command: (creds) => ["redis-server", "--requirepass", creds.password]
    }
};

/** A URL-safe generated secret for database credentials. The alphabet is
 *  base64url, so it never contains a quote or a backslash and always satisfies
 *  what the statement builder accepts. */
function generatePassword(): string {
    return randomBytes(24).toString("base64url");
}

/**
 * A name the engine will accept, derived from what the user typed. Slugs use
 * dashes, which are legal in a quoted identifier but a nuisance in every client
 * that does not quote, so they become underscores; a leading digit gets a prefix
 * because no engine allows one unquoted.
 */
function toIdentifier(slug: string): string {
    const base = slug.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return /^[a-zA-Z]/.test(base) ? base.slice(0, 63) : `db_${base}`.slice(0, 63);
}

export type CreateDatabaseInput = Omit<DatabaseCreate, "serverId"> & { targetId: string };

export async function createDatabase(ownerId: string, input: CreateDatabaseInput) {
    // Re-validated here rather than trusted from the action: this is the last
    // place before the values reach a statement builder. The server has already
    // been resolved to a target by now, so it is dropped from what is checked.
    const parsed: DatabaseCreate = databaseCreateSchema.parse({ ...input, serverId: undefined });

    const environment = await prisma.environment.findFirst({
        where: { id: parsed.environmentId, project: { ownerId } }
    });
    if (!environment) throw new Error("Environment not found");
    const target = await prisma.deployTarget.findFirst({ where: { id: input.targetId, ownerId } });
    if (!target) throw new Error("Deploy target not found");

    const spec = ENGINES[parsed.engine];
    const slug = slugify(parsed.name);
    if (!slug) throw new Error("Database name must contain letters or digits");
    // The slug identifies the service in its environment. Saying so beats the
    // constraint violation the insert would otherwise answer with.
    const clash = await prisma.managedDatabase.findFirst({
        where: { environmentId: parsed.environmentId, slug },
        select: { name: true }
    });
    if (clash) throw new Error(`This environment already has a database called ${clash.name}`);

    // Placing a database on an instance means inheriting where it runs and what
    // it runs, so the instance is resolved first and decides both.
    const parent = parsed.instanceId ? await instanceFor(parsed.instanceId, ownerId) : null;
    if (parsed.instanceId && !parent) throw new Error("The selected instance was not found");
    if (parent && parent.engine !== parsed.engine) {
        throw new Error(`That instance runs ${DB_ENGINE_INFO[parent.engine as DbEngine]?.label ?? parent.engine}`);
    }
    if (parent?.parentId) throw new Error("That database is itself hosted on an instance");

    const version = parent ? parent.version : parsed.version?.trim() || spec.defaultVersion;
    const creds: DbCredentials = {
        username: parsed.username ?? (parent ? toIdentifier(slug) : "polaris"),
        password: parsed.password ?? generatePassword(),
        database: parsed.databaseName ?? toIdentifier(slug)
    };
    const blob = encryptCredentials(creds, loadEnv().POLARIS_MASTER_KEY);

    return prisma.managedDatabase.create({
        data: {
            environmentId: parsed.environmentId,
            // A hosted database has to sit on the same server as the container it
            // lives inside, whatever the request asked for.
            targetId: parent ? parent.targetId : input.targetId,
            name: parsed.name,
            slug,
            engine: parsed.engine,
            image: parent ? "" : spec.image(version),
            version,
            volumeName: "",
            containerName: "",
            exposePort: parsed.exposePort ?? null,
            parentId: parent?.id ?? null,
            privileges: parsed.privileges,
            encryptedCredential: blob.ciphertext,
            credentialNonce: blob.nonce,
            credentialKeyId: blob.keyId
        }
    });
}

/** An instance the caller owns that can host more databases. */
async function instanceFor(id: string, ownerId: string) {
    return prisma.managedDatabase.findFirst({
        where: { id, environment: { project: { ownerId } } },
        select: { id: true, engine: true, version: true, targetId: true, parentId: true, containerName: true }
    });
}

/**
 * Instances in an environment that a new database of `engine` could be created
 * inside: same engine, already provisioned (a container that was never deployed
 * has nothing to run a statement in), and not themselves hosted on another.
 */
export async function listDatabaseInstances(environmentId: string, engine: DbEngine, ownerId: string) {
    if (!DB_ENGINE_INFO[engine].namedDatabases) return [];
    const rows = await prisma.managedDatabase.findMany({
        where: {
            environmentId,
            engine,
            parentId: null,
            containerName: { not: "" },
            environment: { project: { ownerId } }
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, version: true, status: true, _count: { select: { children: true } } }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        version: row.version,
        status: row.status,
        databases: row._count.children + 1
    }));
}

/** Decrypt a database's stored credentials (for a connection string display). */
export async function databaseCredentials(databaseId: string, ownerId: string): Promise<DbCredentials> {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } }
    });
    if (!row || !row.encryptedCredential || !row.credentialNonce) throw new Error("Database not found");
    return decryptCredentials<DbCredentials>(
        {
            ciphertext: Buffer.from(row.encryptedCredential),
            nonce: Buffer.from(row.credentialNonce),
            keyId: row.credentialKeyId ?? ""
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

export interface DatabaseConnection {
    /** Hostname on the proxy network - the container's name, which is its DNS. */
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly username: string;
    readonly password: string;
    /** The URI an application's client library takes as-is. */
    readonly uri: string;
    /** Set when the database is published on the host as well, so it can be
     *  reached from outside the proxy network. */
    readonly exposedPort: number | null;
}

/**
 * How to connect to a database: the address other services on the environment
 * use, and the URI to paste into a client. A database hosted on an instance
 * answers on that instance's container and port with its own account.
 *
 * This is the thing anyone who just created a database needs next, so it is
 * served as one value rather than leaving five fields to be assembled by hand.
 */
export async function databaseConnection(databaseId: string, ownerId: string): Promise<DatabaseConnection> {
    const row = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        include: { parent: { select: { containerName: true, exposePort: true } } }
    });
    if (!row) throw new Error("Database not found");
    const host = row.parent ? row.parent.containerName : row.containerName;
    if (!host) throw new Error("This database has not been provisioned yet");

    const creds = await databaseCredentials(databaseId, ownerId);
    const engine = row.engine as DbEngine;
    const port = ENGINES[engine].port;
    const user = encodeURIComponent(creds.username);
    const secret = encodeURIComponent(creds.password);
    const uri =
        engine === "redis"
            ? `redis://:${secret}@${host}:${port}`
            : engine === "mongo"
              ? `mongodb://${user}:${secret}@${host}:${port}/${creds.database}?authSource=${creds.database}`
              : engine === "postgres"
                ? `postgresql://${user}:${secret}@${host}:${port}/${creds.database}`
                : `mysql://${user}:${secret}@${host}:${port}/${creds.database}`;

    return {
        host,
        port,
        database: creds.database,
        username: creds.username,
        password: creds.password,
        uri,
        exposedPort: (row.parent ? row.parent.exposePort : row.exposePort) ?? null
    };
}

/**
 * Run the statements that create a database inside an instance that is already
 * up, using the instance's own administrative credentials. Returns nothing on
 * success and throws with what the engine said otherwise - a half-created
 * database (a role but no database) is worth reporting rather than leaving to be
 * discovered by the first connection.
 */
async function provisionInInstance(databaseId: string, ownerId: string): Promise<void> {
    const db = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        include: { parent: { include: { target: true } } }
    });
    if (!db?.parent) throw new Error("Database not found");
    if (!db.parent.containerName) throw new Error("The instance has not been provisioned yet");

    const own = await databaseCredentials(db.id, ownerId);
    const admin = await databaseCredentials(db.parent.id, ownerId);
    const grant: DatabaseGrant = {
        database: own.database,
        username: own.username,
        password: own.password,
        privileges: (db.privileges as DbPrivilege) ?? "owner",
        adminUser: admin.username,
        adminPassword: admin.password
    };

    const ports = await getPorts(db.parent.target as TargetRow, ownerId);
    try {
        await runCommands(ports, db.parent.containerName, createDatabaseCommands(db.engine as DbEngine, grant));
    } finally {
        await ports.dispose();
    }
}

/** Run each command in order, stopping at the first the engine refuses. */
async function runCommands(
    ports: Awaited<ReturnType<typeof getPorts>>,
    container: string,
    commands: ContainerCommand[]
): Promise<void> {
    for (const command of commands) {
        const result = await ports.runIn(container, command.argv);
        if (result.code !== 0) {
            const reason = result.output.trim().split("\n").filter(Boolean).at(-1);
            throw new Error(`${command.describe} failed: ${reason ?? `exit status ${result.code}`}`);
        }
    }
}

/** Provision (or re-provision) a managed database. */
export async function deployDatabase(databaseId: string, ownerId: string, userId: string): Promise<string> {
    const db = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true }
    });
    if (!db) throw new Error("Database not found");

    // A database inside another instance has no container to bring up; it is
    // provisioned by statements, which is fast enough to do inline instead of
    // through the deploy queue.
    if (db.parentId) {
        const deployment = await prisma.deployment.create({
            data: {
                targetId: db.targetId,
                deployableType: "database",
                deployableId: db.id,
                status: "deploying",
                triggeredById: userId
            }
        });
        try {
            await provisionInInstance(db.id, ownerId);
            await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "running" } });
            await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: "running" } });
        } catch (error) {
            await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "failed" } });
            await prisma.managedDatabase.update({ where: { id: db.id }, data: { status: "failed" } });
            throw error;
        }
        return deployment.id;
    }

    const spec = ENGINES[db.engine as DbEngine];
    const creds = await databaseCredentials(databaseId, ownerId);
    const name = serviceName(db.environment.project.slug, db.slug, db.id);
    const volumeName = `${db.engine}-data-${shortHash(db.id, 8)}`;
    const project = `polaris-db-${shortHash(db.id, 8)}`;

    // Persist the resolved container name and volume so later reads/connections
    // use the same identifiers the deploy created.
    await prisma.managedDatabase.update({
        where: { id: db.id },
        data: { containerName: name, volumeName, status: "provisioning" }
    });

    const plan: DbDeployPlan = {
        ref: { name, project },
        image: db.image,
        env: spec.env(creds),
        command: spec.command?.(creds),
        volumeName,
        dataPath: spec.dataPath,
        exposePort: db.exposePort ?? undefined
    };

    const deployment = await prisma.deployment.create({
        data: {
            targetId: db.targetId,
            deployableType: "database",
            deployableId: db.id,
            status: "queued",
            triggeredById: userId
        }
    });

    enqueueOnTarget(db.targetId, async () => {
        await executeDeployment(
            deployment.id,
            db.target,
            ownerId,
            (ctx, driver) => driver.deployDatabase(plan, ctx),
            undefined,
            plan.image ? [plan.image] : []
        );
        const final = await prisma.deployment.findUnique({ where: { id: deployment.id }, select: { status: true } });
        await prisma.managedDatabase.update({
            where: { id: db.id },
            data: { status: final?.status === "running" ? "running" : "failed" }
        });
    });
    // Reference kept for symmetry with app deploys (log path is by deployment id).
    void deployLogPath(deployment.id);
    return deployment.id;
}

/**
 * Delete a managed database: bring its compose project down, then remove the row
 * and the deploy history pointing at it.
 *
 * The named volume is deliberately left on the host. A database is the one
 * service whose data is the whole point of it, and an operator who removes the
 * container by mistake can still get it back - `docker volume rm` is one command
 * away when they mean it, and unrecoverable when Polaris runs it for them.
 */
export async function deleteDatabase(databaseId: string, ownerId: string): Promise<void> {
    const db = await prisma.managedDatabase.findFirst({
        where: { id: databaseId, environment: { project: { ownerId } } },
        include: { environment: { include: { project: true } }, target: true, parent: { include: { target: true } } }
    });
    if (!db) throw new Error("Database not found");

    // A database inside another instance is removed by dropping it there. The
    // container it lived in belongs to the instance and stays exactly as it was.
    if (db.parent) {
        if (db.parent.containerName) {
            const own = await databaseCredentials(db.id, ownerId).catch(() => null);
            const admin = await databaseCredentials(db.parent.id, ownerId).catch(() => null);
            if (own && admin) {
                const ports = await getPorts(db.parent.target as TargetRow, ownerId);
                try {
                    await runCommands(
                        ports,
                        db.parent.containerName,
                        dropDatabaseCommands(db.engine as DbEngine, {
                            database: own.database,
                            username: own.username,
                            password: own.password,
                            privileges: (db.privileges as DbPrivilege) ?? "owner",
                            adminUser: admin.username,
                            adminPassword: admin.password
                        })
                    );
                } catch (error) {
                    // The instance is gone or refused the drop. The row still goes:
                    // keeping it would show a database nobody can reach or remove.
                    console.error(`database: could not drop ${db.slug} in its instance:`, error);
                } finally {
                    await ports.dispose();
                }
            }
        }
        await prisma.deployment.deleteMany({ where: { deployableType: "database", deployableId: databaseId } });
        await prisma.managedDatabase.delete({ where: { id: databaseId } });
        return;
    }

    // A database that never deployed has no compose project to tear down, and
    // `containerName` is only written once one has - so derive the project the
    // same way the deploy did rather than trusting an empty column.
    const project = `polaris-db-${shortHash(db.id, 8)}`;
    const ports = await getPorts(db.target as TargetRow, ownerId);
    try {
        await ports.composeDown(project);
    } catch {
        // Already gone, or the host is unreachable. The record still goes: leaving
        // a row behind for a container nobody can reach helps no one.
    } finally {
        await ports.dispose();
    }

    await prisma.deployment.deleteMany({ where: { deployableType: "database", deployableId: databaseId } });
    await prisma.managedDatabase.delete({ where: { id: databaseId } });
}
