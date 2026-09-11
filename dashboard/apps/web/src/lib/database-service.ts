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
import * as core from "@polaris/core";
import { randomBytes } from "node:crypto";
import { loadEnv } from "@polaris/config";
import { topologyMemberPlans } from "./database-topology";
import { getPorts, type TargetRow } from "./deploy/runtime";
import { networksForService } from "./deploy/service-networks";
import { decryptCredentials, encryptCredentials } from "@polaris/storage";
import { deployLogPath, enqueueOnTarget, executeDeployment, limitsOf } from "./deploy-service";
import { clusterNodeNames, dbPlanImages, serviceName, shortHash, slugify, type DbDeployPlan } from "@polaris/deploy";
import type {
    ContainerCommand,
    DatabaseCreate,
    DatabaseGrant,
    DbEngine,
    DbPrivilege,
    ManagedEngine,
    RedisMode
} from "@polaris/core";

export type { DbEngine };

export interface DbCredentials {
    username: string;
    password: string;
    database: string;
    /** MongoDB laid out over several containers: the key its members sign in to
     *  each other with (see `MONGO_KEY_ENV`). */
    clusterKey?: string;
    /** MySQL with read replicas: the replication account's password. */
    replicationPassword?: string;
}

/** What decides the command an instance runs with, beyond its credentials. */
interface EngineRow {
    readonly version: string;
    readonly mode: string;
    readonly maxMemoryMb: number | null;
    readonly clusterMasters: number | null;
    readonly replicaSet: boolean;
    readonly pitr: boolean;
    readonly recoveryBase: string | null;
    readonly recoveryTarget: Date | null;
    readonly topology: string;
}

interface EngineSpec {
    readonly defaultVersion: string;
    readonly port: number;
    image(version: string): string;
    env(creds: DbCredentials): Record<string, string>;
    /** Entrypoint arguments, for an engine that is not configured by environment
     *  or whose settings (a Redis mode, a replica set, archiving) live there. */
    command?(creds: DbCredentials, row: EngineRow): string[] | undefined;
}

const ENGINES: Record<ManagedEngine, EngineSpec> = {
    postgres: {
        defaultVersion: "16",
        port: 5432,
        image: (version) => `postgres:${version}-alpine`,
        env: (creds) => ({
            POSTGRES_USER: creds.username,
            POSTGRES_PASSWORD: creds.password,
            POSTGRES_DB: creds.database
        }),
        // A recovered instance starts by unpacking its base backup and replaying
        // the archive; an archiving one passes the archive settings. Neither is
        // stored in the data folder, so what the instance does is what its row
        // says on every start.
        command: (_creds, row) =>
            row.recoveryBase && row.recoveryTarget
                ? core.pitrRecoveryCommand(row.recoveryBase, row.recoveryTarget)
                : row.pitr
                  ? core.pitrServerCommand()
                  : undefined
    },
    mysql: {
        defaultVersion: "8",
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
        port: 27017,
        image: (version) => `mongo:${version}`,
        env: (creds) => ({
            MONGO_INITDB_ROOT_USERNAME: creds.username,
            MONGO_INITDB_ROOT_PASSWORD: creds.password,
            MONGO_INITDB_DATABASE: creds.database
        }),
        // A set of several members starts from `topologyMemberPlans` instead.
        command: (_creds, row) => (row.replicaSet && row.topology === "single" ? core.mongoReplicaSetCommand() : undefined)
    },
    redis: {
        defaultVersion: "7",
        port: 6379,
        image: (version) => `redis:${version}-alpine`,
        // The official image reads no password from the environment at all, so
        // REDIS_PASSWORD alone left the server open to anything on the proxy
        // network. `--requirepass` is how the image documents enabling auth, and
        // is what actually makes the stored password mean something.
        env: () => ({}),
        command: (creds, row) =>
            core.redisServerCommand(creds.password, row.mode as RedisMode, row.maxMemoryMb ?? undefined)
    },
    seaweedfs: {
        defaultVersion: "4.46",
        port: 8333,
        image: (version) => `chrislusf/seaweedfs:${version}`,
        // The gateway's own fallback identity: until a filer configuration
        // exists it is the only one, so the store never answers anonymously -
        // SeaweedFS allows everything when no identity is configured at all.
        // Provisioning then writes the same identity into the filer
        // configuration, where the per-bucket keys join it.
        env: (creds) => ({
            AWS_ACCESS_KEY_ID: creds.username,
            AWS_SECRET_ACCESS_KEY: creds.password
        }),
        // The image's entrypoint adds `-dir=/data` to `server`.
        command: () => ["server", "-s3", "-s3.port=8333"]
    }
};

/** The spec for a stored engine, or a clear refusal for one this build lacks. */
function engineSpec(engine: string): EngineSpec {
    const spec = ENGINES[engine as ManagedEngine];
    if (!spec) throw new Error(`Polaris cannot run a ${engine} instance`);
    return spec;
}

/** The image a version of an engine runs - what a new instance of it would get. */
export function engineImage(engine: string, version: string): string {
    return engineSpec(engine).image(version);
}

/**
 * The containers a Redis Cluster runs as - the database's own first - or null
 * for anything that is not one, or not deployed yet. Derived from the stored
 * container name the way the deploy names the nodes, so an operation, a backup
 * and the connection details all reach the same ones.
 */
export function databaseClusterNodes(row: {
    readonly engine: string;
    readonly containerName: string;
    readonly clusterMasters: number | null;
}): string[] | null {
    if (row.engine !== "redis" || !row.clusterMasters || !row.containerName) return null;
    return clusterNodeNames(row.containerName, core.redisClusterNodeCount(row.clusterMasters));
}

/** A URL-safe generated secret for database credentials. The alphabet is
 *  base64url, so it never contains a quote or a backslash and always satisfies
 *  what the statement builder accepts. */
function generatePassword(): string {
    return randomBytes(24).toString("base64url");
}

/** An S3 access key id: twenty upper-case letters and digits, the shape every
 *  client and log already expects one to have. */
export function generateAccessKey(): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const bytes = randomBytes(16);
    let key = "PLRS";
    for (const byte of bytes) key += alphabet[byte % alphabet.length];
    return key;
}

/** An S3 secret key: forty URL-safe characters. */
export function generateSecretKey(): string {
    return randomBytes(30).toString("base64url");
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

/** A create request with its server resolved. The layout may be left off, as
 *  in the request itself: it is a single instance then. */
export type CreateDatabaseInput = Omit<DatabaseCreate, "serverId" | "topology"> &
    Partial<Pick<DatabaseCreate, "topology">> & { targetId: string };

export async function createDatabase(ownerId: string, input: CreateDatabaseInput) {
    // Re-validated here rather than trusted from the action: this is the last
    // place before the values reach a statement builder. The server has already
    // been resolved to a target by now, so it is dropped from what is checked.
    const parsed: DatabaseCreate = core.databaseCreateSchema.parse({ ...input, serverId: undefined });
    const topology = core.topologyOf(parsed);

    const environment = await prisma.environment.findFirst({
        where: { id: parsed.environmentId, project: { ownerId } }
    });
    if (!environment) throw new Error("Environment not found");
    const target = await prisma.deployTarget.findFirst({ where: { id: input.targetId, ownerId } });
    if (!target) throw new Error("Deploy target not found");
    if ((topology.kind !== "single" || parsed.clusterMasters) && target.runtime === "swarm") {
        throw new Error(SWARM_REFUSAL);
    }

    const spec = engineSpec(parsed.engine);
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
        throw new Error(`That instance runs ${core.dbEngineLabel(parent.engine)}`);
    }
    if (parent?.parentId) throw new Error("That database is itself hosted on an instance");

    const version = parent ? parent.version : parsed.version?.trim() || spec.defaultVersion;
    // An object store's account is an S3 key pair: the access key id is the
    // "username" and the secret the "password", so everything that reads the
    // stored credentials reads a store's the same way.
    const creds: DbCredentials = core.isStorageEngine(parsed.engine)
        ? { username: generateAccessKey(), password: generateSecretKey(), database: "" }
        : {
              username: parsed.username ?? (parent ? toIdentifier(slug) : "polaris"),
              password: parsed.password ?? generatePassword(),
              database: parsed.databaseName ?? toIdentifier(slug),
              // 384 random bytes as hex: see `isClusterKey`.
              ...(topology.kind === "replicaSet" || topology.kind === "sharded"
                  ? { clusterKey: randomBytes(384).toString("hex") }
                  : {}),
              // 32 characters, the most `SOURCE_PASSWORD` takes.
              ...(topology.kind === "replicas" ? { replicationPassword: generatePassword() } : {})
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
            clusterMasters: parsed.clusterMasters ?? null,
            parentId: parent?.id ?? null,
            privileges: parsed.privileges,
            ...core.topologyColumns(topology),
            encryptedCredential: blob.ciphertext,
            credentialNonce: blob.nonce,
            credentialKeyId: blob.keyId
        }
    });
}

/** Why a database laid out over several containers is not put on a swarm: its
 *  members are joined by running commands in each one by its container name,
 *  and a swarm names its containers itself. */
const SWARM_REFUSAL =
    "That server deploys through a swarm, which names each container itself. A replica set, a sharded cluster, read replicas or a Redis cluster are joined by their names, so choose a server that runs plain containers.";

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
    if (!core.DB_ENGINE_INFO[engine].namedDatabases) return [];
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
    /** What a service's variable says to point at this database by name, so a
     *  copy of the environment points at the copy's database instead. */
    readonly reference: string;
    /** Set for a Redis Cluster: a client has to run in cluster mode, and is given
     *  every node as a seed. `host` and `uri` then name the first node. */
    readonly cluster: {
        readonly masters: number;
        /** Every node as `host:port`. */
        readonly nodes: readonly string[];
        /** The reference to the node list, beside the URL's. */
        readonly reference: string;
    } | null;
    /** Every host the URI lists - a replica set's members; otherwise `host`. */
    readonly hosts: readonly string[];
    /** The replica set the URI names, when it names one. */
    readonly replicaSet: string | null;
    /** MySQL with read replicas: a URI for reading from them, over the name
     *  they share. */
    readonly readUri: string | null;
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
        include: {
            parent: {
                select: {
                    containerName: true,
                    exposePort: true,
                    replicaSet: true,
                    topology: true,
                    members: true,
                    shards: true,
                    readReplicas: true
                }
            }
        }
    });
    if (!row) throw new Error("Database not found");
    const host = row.parent ? row.parent.containerName : row.containerName;
    if (!host) throw new Error("This database has not been provisioned yet");
    // A hosted database is reached the way its instance is.
    const address = core.topologyAddress(core.resolveTopology(row.parent ?? row), host);

    const creds = await databaseCredentials(databaseId, ownerId);
    const engine = row.engine as ManagedEngine;
    const port = engineSpec(engine).port;
    const user = encodeURIComponent(creds.username);
    const secret = encodeURIComponent(creds.password);
    // A dedicated MongoDB instance's account is the root account the image
    // creates, which lives in `admin`; a database hosted on an instance has its
    // account created inside itself. The URI used to name the database for
    // both, which a dedicated instance's own account could not sign in with.
    // A replica set of several members is named with all of them, so a client
    // finds the primary wherever it is; a single-member set with its one.
    const replicaSet =
        address.replicaSet ?? ((row.parent ? row.parent.replicaSet : row.replicaSet) ? core.MONGO_REPLICA_SET : null);
    const mongoParams = [`authSource=${row.parent ? creds.database : "admin"}`, ...(replicaSet ? [`replicaSet=${replicaSet}`] : [])].join(
        "&"
    );
    const mongoHosts = address.hosts.map((one) => `${one}:${port}`).join(",");
    const uri =
        engine === "seaweedfs"
            ? `http://${host}:${port}`
            : engine === "redis"
              ? `redis://:${secret}@${host}:${port}`
              : engine === "mongo"
                ? `mongodb://${user}:${secret}@${mongoHosts}/${creds.database}?${mongoParams}`
                : engine === "postgres"
                  ? `postgresql://${user}:${secret}@${host}:${port}/${creds.database}`
                  : `mysql://${user}:${secret}@${host}:${port}/${creds.database}`;

    const nodes = row.parent ? null : databaseClusterNodes(row);
    return {
        host,
        port,
        database: creds.database,
        username: creds.username,
        password: creds.password,
        uri,
        exposedPort: (row.parent ? row.parent.exposePort : row.exposePort) ?? null,
        reference: `\${{${row.slug}.DATABASE_URL}}`,
        cluster:
            nodes && row.clusterMasters
                ? {
                      masters: row.clusterMasters,
                      nodes: core.redisClusterSeeds(nodes),
                      reference: `\${{${row.slug}.REDIS_CLUSTER_NODES}}`
                  }
                : null,
        hosts: engine === "mongo" ? address.hosts : [host],
        replicaSet: engine === "mongo" ? replicaSet : null,
        readUri: address.readHost ? `mysql://${user}:${secret}@${address.readHost}:${port}/${creds.database}` : null
    };
}

/**
 * Run the statements that create a database inside an instance that is already
 * up, using the instance's own administrative credentials. Returns nothing on
 * success and throws with what the engine said otherwise - a half-created
 * database (a role but no database) is worth reporting rather than leaving to be
 * discovered by the first connection.
 */
export async function provisionInInstance(databaseId: string, ownerId: string): Promise<void> {
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
        await runCommands(ports, db.parent.containerName, core.createDatabaseCommands(db.engine as DbEngine, grant));
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

/** What a deploy can be told beyond the instance's stored settings. */
export interface DeployDatabaseOptions {
    /** Members of a replica set already moved to another image by a rolling
     *  upgrade, by container name; every other member runs the stored image. */
    readonly memberImages?: Readonly<Record<string, string>>;
}

/** Provision (or re-provision) a managed database. */
/**
 * Every database deploy on the audit trail, whatever started it - the Deploy
 * button, a settings change, a point-in-time recovery, an environment clone.
 * Said here, where they all pass, rather than by each (most never did).
 */
async function auditDatabaseDeploy(userId: string, databaseId: string, deploymentId: string): Promise<void> {
    // Loaded when a deploy happens: the audit writer brings the sign-in stack
    // with it, which nothing else in this module needs to have loaded.
    const { recordDeployAudit } = await import("./deploy-audit");
    await recordDeployAudit({
        actorId: userId,
        action: "deploy.db.deploy",
        targetType: "database",
        targetId: databaseId,
        metadata: { deploymentId }
    });
}

export async function deployDatabase(
    databaseId: string,
    ownerId: string,
    userId: string,
    options: DeployDatabaseOptions = {}
): Promise<string> {
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
        await auditDatabaseDeploy(userId, db.id, deployment.id);
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

    const spec = engineSpec(db.engine);
    const topology = core.resolveTopology(db);
    if ((topology.kind !== "single" || (db.engine === "redis" && db.clusterMasters)) && db.target.runtime === "swarm") {
        throw new Error(SWARM_REFUSAL);
    }
    const creds = await databaseCredentials(databaseId, ownerId);
    const name = serviceName(db.environment.project.slug, db.slug, db.id);
    // The stored volume wins over the derived one: an upgrade moves an instance
    // onto a new volume and keeps the old one to fall back to, and a redeploy
    // must not quietly move it back.
    const volumeName = db.volumeName || `${db.engine}-data-${shortHash(db.id, 8)}`;
    const project = `polaris-db-${shortHash(db.id, 8)}`;

    // Persist the resolved container name and volume so later reads/connections
    // use the same identifiers the deploy created.
    await prisma.managedDatabase.update({
        where: { id: db.id },
        data: { containerName: name, volumeName, status: "provisioning" }
    });

    // The archive folder is mounted into an archiving instance and into one
    // recovered from it - the recovered one reads the original's archive.
    const archiveOf = db.recoveredFromId ?? (db.pitr ? db.id : null);
    // A cluster's nodes are named, and their volumes too, after the database's
    // own: the first node is the container everything else asks for.
    const nodes = databaseClusterNodes({ ...db, containerName: name });
    const nodeVolumes = nodes ? clusterNodeNames(volumeName, nodes.length) : [];
    const plan: DbDeployPlan = {
        ref: { name, project },
        image: db.image,
        env: spec.env(creds),
        command: spec.command?.(creds, db),
        volumeName,
        dataPath: core.databaseDataPath(db.engine, db.version),
        exposePort: db.exposePort ?? undefined,
        limits: limitsOf(db),
        ...(nodes
            ? {
                  nodes: nodes.map((node, index) => ({
                      name: node,
                      command: core.redisClusterServerCommand(
                          creds.password,
                          db.mode as RedisMode,
                          db.maxMemoryMb ?? undefined,
                          node
                      ),
                      volumeName: nodeVolumes[index]!
                  }))
              }
            : {}),
        ...(archiveOf ? { extraVolumes: [{ source: core.pitrHostFolder(archiveOf), target: core.PITR_MOUNT, kind: "bind" as const }] } : {}),
        members: topologyMemberPlans({
            topology,
            name,
            volumeName,
            engineEnv: spec.env(creds),
            password: creds.password,
            clusterKey: creds.clusterKey,
            exposePort: db.exposePort ?? undefined,
            memberImages: options.memberImages
        }),
        ...(options.memberImages ? { keepImages: true } : {}),
        // Nothing routes to a database, so in an isolated environment it leaves the
        // proxy network entirely: the services beside it reach it on their own
        // network, and the daemon attaches the dashboard there for the data browser.
        networks: networksForService({
            environment: db.environment,
            serviceId: db.id,
            target: db.target,
            published: db.exposePort !== null,
            routed: false
        })
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
    await auditDatabaseDeploy(userId, db.id, deployment.id);

    enqueueOnTarget(db.targetId, async () => {
        await executeDeployment(
            deployment.id,
            db.target,
            ownerId,
            (ctx, driver) => driver.deployDatabase(plan, ctx),
            undefined,
            dbPlanImages(plan)
        );
        const final = await prisma.deployment.findUnique({ where: { id: deployment.id }, select: { status: true } });
        const running = final?.status === "running";
        await prisma.managedDatabase.update({
            where: { id: db.id },
            data: { status: running ? "running" : "failed" }
        });
        // What an engine needs once it answers and a compose file cannot say: the
        // object store's identities, a replica set's initiation, the archive's
        // first base backup. Its own failures are recorded on the instance's
        // operations, never on the deploy - the container did come up. Not
        // awaited: it waits for the engine to answer and may take a base backup,
        // and the server's deploy queue is not what should wait on that.
        if (running) {
            void import("./database-ops/provision")
                .then(({ afterProvision }) => afterProvision(db.id, ownerId))
                .catch((error: unknown) => {
                    console.error(`database: post-provision steps for ${db.slug} failed:`, error);
                });
        }
    });
    // Reference kept for symmetry with app deploys (log path is by deployment id).
    void deployLogPath(deployment.id);
    return deployment.id;
}

/** How long a deploy is waited on by an operation that cannot continue without
 *  it - an upgrade, a recovery. Long enough for a first pull on a slow line. */
const DEPLOY_WAIT_MS = 20 * 60_000;

/**
 * Deploy a database and wait for the verdict: null when it is running, or why
 * it is not. For the operations that have to know - an upgrade cannot load data
 * into a container that never came up, and must fall back if it did not.
 */
export async function deployDatabaseAndWait(
    databaseId: string,
    ownerId: string,
    userId: string,
    options: DeployDatabaseOptions = {}
): Promise<string | null> {
    let deploymentId: string;
    try {
        deploymentId = await deployDatabase(databaseId, ownerId, userId, options);
    } catch (caught) {
        return caught instanceof Error ? caught.message : "the deploy could not be started";
    }
    const deadline = Date.now() + DEPLOY_WAIT_MS;
    while (Date.now() < deadline) {
        const row = await prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { status: true, error: true }
        });
        if (row && !["queued", "deploying", "building"].includes(row.status)) {
            return row.status === "running" ? null : (row.error ?? `the deploy ended ${row.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return "the deploy did not finish in time";
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
                        core.dropDatabaseCommands(db.engine as DbEngine, {
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
