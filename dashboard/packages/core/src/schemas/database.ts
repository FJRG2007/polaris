/**
 * Managed database domain: which engines exist, what each one can do, and what a
 * request to create one is allowed to say.
 *
 * A database can be created two ways. A dedicated instance is its own container
 * with its own data volume - isolated, and the right answer when the workload
 * matters. A database on an existing instance is a logical database created
 * inside a container that is already running, which is how a handful of small
 * apps share one engine process instead of paying for five.
 *
 * Every identifier here ends up inside a `CREATE DATABASE` or `CREATE USER`
 * statement, so the charset is deliberately narrow: letters, digits and
 * underscores, starting with a letter. That is not decoration - it is what keeps
 * a name from carrying SQL with it, on top of the quoting the statement builder
 * does.
 */

import { z } from "zod";

export const DB_ENGINES = ["postgres", "mysql", "mariadb", "mongo", "redis"] as const;
export type DbEngine = (typeof DB_ENGINES)[number];

/** How much a database's own user may do inside it. */
export const DB_PRIVILEGES = ["owner", "readwrite", "readonly"] as const;
export type DbPrivilege = (typeof DB_PRIVILEGES)[number];

export interface DbEngineInfo {
    readonly id: DbEngine;
    /** The name the project writes itself, which is the one to put on screen. */
    readonly label: string;
    /** Port the engine listens on inside its container. */
    readonly port: number;
    /** Offered versions, newest first. The default is chosen by the server so an
     *  existing deployment's default never moves under it. */
    readonly versions: readonly string[];
    /** True when the engine holds several named databases, so one instance can be
     *  shared and a database can be given a name of its own. */
    readonly namedDatabases: boolean;
    /** True when the engine authenticates a named user. Redis authenticates with
     *  a password alone on the default user. */
    readonly namedUsers: boolean;
}

export const DB_ENGINE_INFO: Readonly<Record<DbEngine, DbEngineInfo>> = {
    postgres: {
        id: "postgres",
        label: "PostgreSQL",
        port: 5432,
        versions: ["18", "17", "16", "15", "14"],
        namedDatabases: true,
        namedUsers: true
    },
    mysql: {
        id: "mysql",
        label: "MySQL",
        port: 3306,
        versions: ["9", "8.4", "8"],
        namedDatabases: true,
        namedUsers: true
    },
    mariadb: {
        id: "mariadb",
        label: "MariaDB",
        port: 3306,
        versions: ["11", "10.11"],
        namedDatabases: true,
        namedUsers: true
    },
    mongo: {
        id: "mongo",
        label: "MongoDB",
        port: 27017,
        versions: ["8", "7", "6"],
        namedDatabases: true,
        namedUsers: true
    },
    redis: {
        id: "redis",
        label: "Redis",
        port: 6379,
        versions: ["8", "7"],
        namedDatabases: false,
        namedUsers: false
    }
};

/**
 * Services Polaris runs beside its databases that are not databases: an
 * S3-compatible object store. They share the database machinery - a container,
 * a data volume, generated credentials held encrypted, the deploy queue, the
 * canvas - and nothing that reads data out of a database, which is why they are
 * a separate list rather than members of `DB_ENGINES`: the data browser and the
 * saved connections are typed by `DbEngine`, and an object store in that list
 * would be offered there as something to run SQL against.
 *
 * SeaweedFS rather than MinIO: MinIO stopped publishing community images in
 * October 2025 and archived the community repository in April 2026. SeaweedFS
 * is Apache-2.0, maintained, and has expiry rules, presigned URLs and a
 * replication tool of its own (`filer.sync`). Garage (AGPL) has expiry and
 * presigned URLs too, but no bucket replication.
 */
export const STORAGE_ENGINES = ["seaweedfs"] as const;
export type StorageEngine = (typeof STORAGE_ENGINES)[number];

/** Everything that can be created from the "new database" flow. */
export const MANAGED_ENGINES = [...DB_ENGINES, ...STORAGE_ENGINES] as const;
export type ManagedEngine = (typeof MANAGED_ENGINES)[number];

export interface ManagedEngineInfo extends Omit<DbEngineInfo, "id"> {
    readonly id: ManagedEngine;
    /** True for an object store: no SQL, no named databases, a bucket API. */
    readonly storage: boolean;
}

export const MANAGED_ENGINE_INFO: Readonly<Record<ManagedEngine, ManagedEngineInfo>> = {
    ...(Object.fromEntries(
        DB_ENGINES.map((engine) => [engine, { ...DB_ENGINE_INFO[engine], storage: false }])
    ) as Record<DbEngine, ManagedEngineInfo>),
    seaweedfs: {
        id: "seaweedfs",
        label: "Object storage",
        // The S3 gateway's port. Pinned to one tested release rather than a
        // moving tag, so a redeploy never changes what it runs by itself.
        port: 8333,
        versions: ["4.46"],
        namedDatabases: false,
        namedUsers: false,
        storage: true
    }
};

/** True for an engine this build can create. */
export function isManagedEngine(value: unknown): value is ManagedEngine {
    return typeof value === "string" && (MANAGED_ENGINES as readonly string[]).includes(value);
}

/** True for an engine whose data can be browsed and queried. */
export function isDbEngine(value: unknown): value is DbEngine {
    return typeof value === "string" && (DB_ENGINES as readonly string[]).includes(value);
}

/** True for an object store rather than a database. */
export function isStorageEngine(engine: string): engine is StorageEngine {
    return (STORAGE_ENGINES as readonly string[]).includes(engine);
}

/** The engine's own name for itself, for anywhere an engine id would otherwise
 *  be shown raw. Falls back to the stored value so a row written by a future
 *  version still renders as something. */
export function dbEngineLabel(engine: string): string {
    return MANAGED_ENGINE_INFO[engine as ManagedEngine]?.label ?? engine;
}

/**
 * What is known to stop a version from running, in a sentence for any screen
 * that offers it, or null. MongoDB 8 itself refuses to start on Linux 6.19 or
 * newer (its issue SERVER-121912), which is what new distributions ship; seen
 * on a Linux 7.0 server, where 7 starts.
 */
export function dbVersionCaveat(engine: string, version: string): string | null {
    return engine === "mongo" && version === "8"
        ? "MongoDB 8 does not start on Linux 6.19 or newer. On a server with a newer kernel, pick 7."
        : null;
}

/** True when an engine can host more databases beside the one it was created
 *  for, which is what makes it an instance others can be placed on. */
export function canShareInstance(engine: string): boolean {
    return DB_ENGINE_INFO[engine as DbEngine]?.namedDatabases ?? false;
}

/**
 * How a dedicated instance is laid out.
 *
 * - `single` - one container. What every instance was before the others existed.
 * - `replicaSet` - MongoDB as a replica set of three or five members, each in a
 *   container of its own on the same server, finding each other by name.
 * - `sharded` - MongoDB as a sharded cluster: a config server replica set of
 *   three, shards that are each a replica set of three, and a router that is
 *   what applications connect to.
 * - `replicas` - MySQL with one or two read replicas following its primary by
 *   GTID replication.
 *
 * Chosen when the database is created and kept: a set's members and a cluster's
 * shards are started empty and joined by Polaris, and turning a running single
 * instance into one of them is a different job from the one this does.
 */
export const DB_TOPOLOGIES = ["single", "replicaSet", "sharded", "replicas"] as const;
export type DbTopologyKind = (typeof DB_TOPOLOGIES)[number];

/** The one engine each layout beyond `single` is offered for. */
export const TOPOLOGY_ENGINE: Readonly<Record<Exclude<DbTopologyKind, "single">, DbEngine>> = {
    replicaSet: "mongo",
    sharded: "mongo",
    replicas: "mysql"
};

/** Members a MongoDB replica set may have: an odd number, so a majority exists. */
export const MONGO_SET_SIZES = [3, 5] as const;
/** Shards a sharded cluster may start with, each a replica set of three. */
export const MONGO_SHARD_COUNTS = [2, 3, 4] as const;
/** Read replicas a MySQL primary may have. */
export const MYSQL_REPLICA_COUNTS = [1, 2] as const;

/** A layout with its sizes resolved. */
export type DbTopology =
    | { readonly kind: "single" }
    | { readonly kind: "replicaSet"; readonly members: number }
    | { readonly kind: "sharded"; readonly shards: number }
    | { readonly kind: "replicas"; readonly replicas: number };

/**
 * The layout a stored instance has. A row written before layouts existed, or
 * one naming a layout this build does not know, is a single instance - which is
 * what it was started as.
 */
export function resolveTopology(row: {
    readonly topology?: string | null;
    readonly members?: number | null;
    readonly shards?: number | null;
    readonly readReplicas?: number | null;
}): DbTopology {
    const pick = (value: number | null | undefined, allowed: readonly number[]): number =>
        value != null && allowed.includes(value) ? value : (allowed[0] as number);
    switch (row.topology) {
        case "replicaSet":
            return { kind: "replicaSet", members: pick(row.members, MONGO_SET_SIZES) };
        case "sharded":
            return { kind: "sharded", shards: pick(row.shards, MONGO_SHARD_COUNTS) };
        case "replicas":
            return { kind: "replicas", replicas: pick(row.readReplicas, MYSQL_REPLICA_COUNTS) };
        default:
            return { kind: "single" };
    }
}

/** The columns a layout is stored in. */
export function topologyColumns(topology: DbTopology): {
    topology: DbTopologyKind;
    members: number;
    shards: number;
    readReplicas: number;
} {
    return {
        topology: topology.kind,
        members: topology.kind === "replicaSet" ? topology.members : 1,
        shards: topology.kind === "sharded" ? topology.shards : 0,
        readReplicas: topology.kind === "replicas" ? topology.replicas : 0
    };
}

/** A layout in words, for a badge or a heading. */
export function topologyLabel(topology: DbTopology): string {
    switch (topology.kind) {
        case "replicaSet":
            return `Replica set of ${topology.members}`;
        case "sharded":
            return `Sharded, ${topology.shards} shards`;
        case "replicas":
            return `Primary and ${topology.replicas} read ${topology.replicas === 1 ? "replica" : "replicas"}`;
        default:
            return "Single instance";
    }
}

/** A SQL identifier we are willing to create: letters, digits and underscores,
 *  opening with a letter. Deliberately narrower than what the engines accept. */
const sqlIdentifier = z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "Use letters, digits and underscores, starting with a letter");

/**
 * A password we are willing to put in a statement. Quotes and backslashes are
 * refused rather than escaped: they are the characters that break out of a
 * literal, and no generated password needs them. Everything else printable is
 * allowed, so a pasted password from a manager still fits.
 */
const dbPassword = z
    .string()
    .min(12, "Use at least 12 characters")
    .max(128)
    .regex(/^[\x21-\x7e]+$/u, "Use printable characters with no spaces")
    .refine((value) => !/["'`\\]/.test(value), "Quotes and backslashes are not allowed in a database password");

/** A host port a database may be published on. Below 1024 is refused: those are
 *  the ports the host's own services claim, and a database is not one of them. */
const hostPort = z.number().int().min(1024).max(65535);

/**
 * The masters a new Redis can be run as a Redis Cluster with, each given one
 * replica, so the cluster runs twice as many nodes. Three is the smallest
 * cluster Redis documents as working; odd counts keep a majority of masters
 * possible when one is lost.
 */
export const REDIS_CLUSTER_MASTERS = [3, 5, 7] as const;
export type RedisClusterMasters = (typeof REDIS_CLUSTER_MASTERS)[number];

/** True for a master count a cluster can be created with. */
export function isRedisClusterMasters(value: unknown): value is RedisClusterMasters {
    return typeof value === "number" && (REDIS_CLUSTER_MASTERS as readonly number[]).includes(value);
}

export const databaseCreateSchema = z
    .object({
        environmentId: z.string().uuid(),
        /** Display name. The slug derived from it identifies the service. */
        name: z.string().trim().min(1, "A database name is required").max(64),
        engine: z.enum(MANAGED_ENGINES),
        /** "local" or a host id; resolved to a deploy target server-side. */
        serverId: z.string().trim().min(1).optional(),
        version: z
            .string()
            .trim()
            .max(24)
            .regex(/^[0-9][0-9A-Za-z.\-]*$/, "That is not a version this engine publishes")
            .optional(),
        /** An existing instance to create this database inside, instead of
         *  starting one of its own. */
        instanceId: z.string().uuid().optional(),
        /** Published host port, so the database is reachable from outside the
         *  proxy network. Omitted keeps it internal, which is the safe default. */
        exposePort: hostPort.optional(),
        /** The database's own name inside the engine. Defaults to the slug. */
        databaseName: sqlIdentifier.optional(),
        /** The account applications connect with. Defaults to a generated one. */
        username: sqlIdentifier.optional(),
        /** Left off, a strong password is generated and stored encrypted. */
        password: dbPassword.optional(),
        privileges: z.enum(DB_PRIVILEGES).default("owner"),
        /** Redis only: run as a cluster of this many masters, each with one
         *  replica. Omitted is a single instance. */
        clusterMasters: z
            .number()
            .int()
            .refine(isRedisClusterMasters, "A cluster has 3, 5 or 7 masters")
            .optional(),
        /** How the instance is laid out. Left off, it is one container. */
        topology: z.enum(DB_TOPOLOGIES).default("single"),
        /** A replica set's members. Left off, three. */
        members: z.number().int().optional(),
        /** A sharded cluster's shards. Left off, two. */
        shards: z.number().int().optional(),
        /** A MySQL primary's read replicas. Left off, one. */
        readReplicas: z.number().int().optional()
    })
    .superRefine((value, ctx) => {
        const info = MANAGED_ENGINE_INFO[value.engine];
        const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
        if (value.topology !== "single") {
            const engine = TOPOLOGY_ENGINE[value.topology];
            if (value.engine !== engine) {
                issue("topology", `${topologyLabel(topologyOf(value))} is offered for ${DB_ENGINE_INFO[engine].label} only`);
            }
            if (value.instanceId) issue("topology", "A database on an existing instance runs the way that instance does");
        }
        if (value.members !== undefined && (value.topology !== "replicaSet" || !(MONGO_SET_SIZES as readonly number[]).includes(value.members))) {
            issue("members", value.topology === "replicaSet" ? "A replica set has 3 or 5 members" : "Only a replica set has members to count");
        }
        if (value.shards !== undefined && (value.topology !== "sharded" || !(MONGO_SHARD_COUNTS as readonly number[]).includes(value.shards))) {
            issue("shards", value.topology === "sharded" ? "A sharded cluster starts with 2, 3 or 4 shards" : "Only a sharded cluster has shards");
        }
        if (
            value.readReplicas !== undefined &&
            (value.topology !== "replicas" || !(MYSQL_REPLICA_COUNTS as readonly number[]).includes(value.readReplicas))
        ) {
            issue("readReplicas", value.topology === "replicas" ? "Add 1 or 2 read replicas" : "Only a primary with replicas has read replicas");
        }
        // A replica set's members know each other by names only the environment
        // resolves, and a client that connects as a replica set follows those
        // names - so from outside it could reach none of them.
        if (value.topology === "replicaSet" && value.exposePort !== undefined) {
            issue(
                "exposePort",
                "A replica set is reached by its members' names inside the environment, so it is not published. A sharded cluster's router can be."
            );
        }
        if (value.version && !info.versions.includes(value.version)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["version"],
                message: `${info.label} ${value.version} is not one of the offered versions`
            });
        }
        if (value.instanceId && !info.namedDatabases) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["instanceId"],
                message: `${info.label} holds one dataset per instance, so it cannot share one`
            });
        }
        // A database placed on an existing instance answers on that instance's
        // port and lives in its container; asking to publish a port or pick a
        // version would silently do nothing.
        if (value.instanceId && value.exposePort !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["exposePort"],
                message: "A database on an existing instance is reached through that instance's port"
            });
        }
        if (value.instanceId && value.version) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["version"],
                message: "A database on an existing instance runs the version that instance runs"
            });
        }
        if (!info.namedUsers && (value.username || value.databaseName)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["username"],
                message: `${info.label} has no named users or databases`
            });
        }
        if (info.storage && value.password) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["password"],
                message: "An object store's keys are always generated"
            });
        }
        if (value.clusterMasters !== undefined && value.engine !== "redis") {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["clusterMasters"],
                message: `${info.label} does not run as a Redis Cluster`
            });
        }
        // A cluster answers a client with the addresses of its nodes, which only
        // the services on its network can reach; one published port leads a
        // client outside to one node and then to addresses it cannot open.
        if (value.clusterMasters !== undefined && value.exposePort !== undefined) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["exposePort"],
                message: "A cluster is reached by the services in its environment and cannot be published on one port"
            });
        }
    });

export type DatabaseCreateInput = z.input<typeof databaseCreateSchema>;
export type DatabaseCreate = z.output<typeof databaseCreateSchema>;

/** The layout a create request asks for, with the sizes it left off filled in. */
export function topologyOf(input: {
    readonly topology?: DbTopologyKind;
    readonly members?: number;
    readonly shards?: number;
    readonly readReplicas?: number;
}): DbTopology {
    return resolveTopology({
        topology: input.topology ?? "single",
        members: input.members ?? null,
        shards: input.shards ?? null,
        readReplicas: input.readReplicas ?? null
    });
}

/** The create-request fields that ask for a stored layout again - a copy of an
 *  environment gets the layout its original had. */
export function topologyRequest(topology: DbTopology): Pick<
    DatabaseCreateInput,
    "topology" | "members" | "shards" | "readReplicas"
> {
    switch (topology.kind) {
        case "replicaSet":
            return { topology: "replicaSet", members: topology.members };
        case "sharded":
            return { topology: "sharded", shards: topology.shards };
        case "replicas":
            return { topology: "replicas", readReplicas: topology.replicas };
        default:
            return { topology: "single" };
    }
}
