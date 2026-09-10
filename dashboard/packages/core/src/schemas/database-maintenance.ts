/**
 * The commands that look after a database once it exists: putting a dump back,
 * asking whether the engine is up, running Redis the way it is meant to be run,
 * turning a MongoDB into a replica set, and PostgreSQL's point-in-time recovery.
 *
 * Pure for the same reason as `database-statements`: these return argument
 * vectors and never run anything, so the exact commands a request produces are
 * read in a test instead of inferred from a container's behaviour. Everything
 * reaching a shell script here does so as a positional argument (`"$1"`), never
 * interpolated into the script, so a path or a name cannot become a command.
 */

import { z } from "zod";
import type { DbPrivilege } from "./database.js";
import { MANAGED_ENGINE_INFO, type ManagedEngine } from "./database.js";

/** A command to run inside a database's container. `env` travels as `env K=V`
 *  in front of the argv, so a password never sits in the script text. */
export interface MaintenanceCommand {
    readonly argv: readonly string[];
    /** What the step does, for a log line - never the command, which carries secrets. */
    readonly describe: string;
}

/** Prefix an argv with environment variables through `env`, which every image has. */
function withEnv(env: Readonly<Record<string, string>>, argv: readonly string[]): string[] {
    const pairs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
    return pairs.length > 0 ? ["env", ...pairs, ...argv] : [...argv];
}

/**
 * A shell pipeline that fails when EITHER side fails.
 *
 * `a | b` reports only `b`: a `pg_dump` that died half way into `gzip` is a
 * successful command that wrote half a dump, and a `gunzip` that hit a corrupt
 * archive feeds `psql` a truncated script that may apply cleanly. `pipefail`
 * would fix that and is not in every image's shell - MariaDB's is dash - so the
 * producer leaves a marker when it fails, and the script exits non-zero on it.
 * `marker` is a path the script owns; it is removed either way.
 */
export function strictPipe(producer: string, consumer: string, marker: string): string {
    return [
        `rm -f "${marker}"`,
        `( ${producer} || echo failed > "${marker}" ) | ${consumer}`,
        "status=$?",
        `if [ -e "${marker}" ]; then rm -f "${marker}"; exit 1; fi`,
        "exit $status"
    ].join("\n");
}

function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

function quoteBacktick(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
}

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Compare two dotted versions numerically: negative when `a` is older. */
export function compareVersions(a: string, b: string): number {
    const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

/**
 * The versions an instance can be upgraded to: the offered ones newer than it
 * runs. Downgrades are never offered - no engine here reads data written by a
 * newer version of itself, and a dump taken from one is not guaranteed to load
 * into an older one either.
 */
export function upgradeTargets(engine: ManagedEngine, current: string): string[] {
    const info = MANAGED_ENGINE_INFO[engine];
    if (!info) return [];
    return info.versions.filter((version) => compareVersions(version, current) > 0);
}

/**
 * Where an engine's data lives inside its container, by version.
 *
 * PostgreSQL 18's official image moved it: `PGDATA` became
 * `/var/lib/postgresql/18/docker` and the declared volume
 * `/var/lib/postgresql`. A volume mounted at the old `/var/lib/postgresql/data`
 * is then not where the data is written, so a PostgreSQL 18 instance kept its
 * data in the container's own layer and lost it on the next redeploy.
 */
export function databaseDataPath(engine: string, version: string): string {
    if (engine === "postgres") {
        return compareVersions(version, "18") >= 0 ? "/var/lib/postgresql" : "/var/lib/postgresql/data";
    }
    if (engine === "mysql" || engine === "mariadb") return "/var/lib/mysql";
    if (engine === "mongo") return "/data/db";
    return "/data";
}

/**
 * A version change is a MAJOR one - moved by a dump, a new container and a
 * load - whenever the version differs at all. The versions offered are the
 * image's major tags, so the same tag again is the only in-place change there
 * is: pulling it brings the newest patch release, which every engine here reads
 * its own data files with. Anything else changes the on-disk format for at
 * least one of them (PostgreSQL between any two majors, MongoDB's feature
 * compatibility version, MySQL's data dictionary), and a dump is the one path
 * that works for all of them and leaves the old data untouched to go back to.
 */
export function isInPlaceUpgrade(current: string, next: string): boolean {
    return compareVersions(current, next) === 0;
}

// ---------------------------------------------------------------------------
// What an instance holds
// ---------------------------------------------------------------------------

/** Databases every engine keeps for itself, never carried by an upgrade. */
const SYSTEM_DATABASES: Readonly<Record<string, readonly string[]>> = {
    postgres: ["postgres", "template0", "template1"],
    mysql: ["information_schema", "mysql", "performance_schema", "sys"],
    mariadb: ["information_schema", "mysql", "performance_schema", "sys"],
    mongo: ["admin", "config", "local"]
};

/**
 * List the databases inside an instance, one per line. An upgrade carries the
 * databases Polaris knows about - the instance's own and those hosted on it -
 * and refuses rather than silently leaving behind one somebody made by hand.
 */
export function listDatabasesCommand(
    engine: "postgres" | "mysql" | "mariadb" | "mongo",
    adminUser: string,
    adminPassword: string
): MaintenanceCommand {
    if (engine === "postgres") {
        return {
            argv: withEnv({ PGPASSWORD: adminPassword }, [
                "psql",
                "-tA",
                "-U",
                adminUser,
                "-d",
                "postgres",
                "-c",
                "SELECT datname FROM pg_database ORDER BY datname"
            ]),
            describe: "Listing the databases"
        };
    }
    if (engine === "mysql" || engine === "mariadb") {
        return {
            argv: [engine === "mysql" ? "mysql" : "mariadb", "-uroot", `-p${adminPassword}`, "-N", "-e", "SHOW DATABASES"],
            describe: "Listing the databases"
        };
    }
    return {
        argv: [
            "mongosh",
            "--quiet",
            "-u",
            adminUser,
            "-p",
            adminPassword,
            "--authenticationDatabase",
            "admin",
            "--eval",
            'db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.map((entry) => entry.name).join("\\n")'
        ],
        describe: "Listing the databases"
    };
}

/** PostgreSQL roles, one per line - the ones an upgrade would not carry. */
export function listRolesCommand(adminUser: string, adminPassword: string): MaintenanceCommand {
    return {
        argv: withEnv({ PGPASSWORD: adminPassword }, [
            "psql",
            "-tA",
            "-U",
            adminUser,
            "-d",
            "postgres",
            "-c",
            "SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname"
        ]),
        describe: "Listing the accounts"
    };
}

/** The names in a listing that are neither the engine's own nor known. */
export function unknownNames(engine: string, output: string, known: readonly string[]): string[] {
    const system = new Set([...(SYSTEM_DATABASES[engine] ?? []), ...known]);
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((name) => name.length > 0 && !name.includes(" ") && !system.has(name));
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/** What a readiness probe needs to know. */
export interface ProbeTarget {
    readonly engine: ManagedEngine;
    readonly username: string;
    readonly password: string;
}

/**
 * A command that succeeds once the engine accepts connections.
 *
 * Asked after a container is recreated and before anything is loaded into it:
 * compose returns as soon as the container starts, which for PostgreSQL and
 * MySQL is seconds before they answer, and a restore started in that gap fails
 * on a refused connection that reads like a wrong password.
 */
export function readinessCommand(target: ProbeTarget): MaintenanceCommand {
    switch (target.engine) {
        case "postgres":
            return { argv: ["pg_isready", "-U", target.username], describe: "Waiting for PostgreSQL" };
        // The root password rides the argv of a process inside the database's own
        // container, the same channel `database-statements` uses; MYSQL_PWD is
        // deprecated by MySQL and not something to build on.
        case "mysql":
            return {
                argv: ["mysqladmin", "ping", "-uroot", `-p${target.password}`, "--silent"],
                describe: "Waiting for MySQL"
            };
        case "mariadb":
            return {
                argv: ["mariadb-admin", "ping", "-uroot", `-p${target.password}`, "--silent"],
                describe: "Waiting for MariaDB"
            };
        case "mongo":
            return {
                argv: [
                    "mongosh",
                    "--quiet",
                    "-u",
                    target.username,
                    "-p",
                    target.password,
                    "--authenticationDatabase",
                    "admin",
                    "--eval",
                    "db.adminCommand({ ping: 1 }).ok"
                ],
                describe: "Waiting for MongoDB"
            };
        case "redis":
            return {
                argv: withEnv({ REDISCLI_AUTH: target.password }, ["redis-cli", "ping"]),
                describe: "Waiting for Redis"
            };
        case "seaweedfs":
            return {
                argv: ["wget", "-q", "-O", "-", "http://127.0.0.1:9333/cluster/status"],
                describe: "Waiting for the object store"
            };
    }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** Everything a restore into a running instance needs. */
export interface RestoreTarget {
    readonly engine: "postgres" | "mysql" | "mariadb" | "mongo";
    /** The database being restored, by its name inside the engine. */
    readonly database: string;
    /** Its own account, and how much that account may do. */
    readonly username: string;
    readonly password: string;
    readonly privileges: DbPrivilege;
    /** The instance's administrative account (for MySQL and MariaDB, root's
     *  password - the images set root's password to the instance's own). */
    readonly adminUser: string;
    readonly adminPassword: string;
    /** True when the database lives inside another instance rather than being
     *  the one its own container was created for. */
    readonly hosted: boolean;
    /** Where the dump was written inside the container. */
    readonly file: string;
    /** For MongoDB, the database the dump was taken from, when that is not the
     *  one it is being restored into - a copy between databases. */
    readonly sourceDatabase?: string;
    /** For a MongoDB replica set of several members, its seed list: the load
     *  goes to whichever member is primary, not to the container it runs in. */
    readonly seeds?: string;
}

/**
 * The steps that replace a database's contents with a dump, in order.
 *
 * The database is dropped and created again rather than loaded over: a plain
 * SQL dump loaded on top of existing tables fails on the first one that
 * already exists, and a load that skipped errors instead would leave a mixture
 * of both states nobody could describe. The steps are separate commands so a
 * failure names the one that failed.
 *
 * PostgreSQL loads with `ON_ERROR_STOP`, so a dump that does not fully apply is
 * a failed restore rather than a partial one that reports success; the safety
 * copy taken before the restore is what gets somebody back.
 */
export function restoreCommands(target: RestoreTarget): MaintenanceCommand[] {
    if (target.engine === "postgres") {
        const db = quoteIdent(target.database);
        const owner = !target.hosted || target.privileges === "owner";
        // The database's own account loads when it owns the database, so what it
        // creates is its own; otherwise the instance's account loads and the
        // grants the database was created with are applied again afterwards.
        const loader = owner ? target.username : target.adminUser;
        const loaderPassword = owner ? target.password : target.adminPassword;
        // A database cannot be dropped from a connection to itself, so the
        // administrative statements run from `postgres` - or from `template1` in
        // the one case where the database being restored is `postgres`.
        const maintenance = target.database === "postgres" ? "template1" : "postgres";
        const admin = (statement: string, describe: string): MaintenanceCommand => ({
            argv: withEnv({ PGPASSWORD: target.adminPassword }, [
                "psql",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                target.adminUser,
                "-d",
                maintenance,
                "-c",
                statement
            ]),
            describe
        });
        const commands: MaintenanceCommand[] = [
            admin(
                `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${quoteLiteral(target.database)} AND pid <> pg_backend_pid()`,
                "Closing connections to the database"
            ),
            admin(`DROP DATABASE IF EXISTS ${db}`, "Removing the current contents"),
            admin(
                owner ? `CREATE DATABASE ${db} OWNER ${quoteIdent(target.username)}` : `CREATE DATABASE ${db}`,
                "Creating the database again"
            ),
            {
                argv: withEnv({ PGPASSWORD: loaderPassword }, [
                    "sh",
                    "-c",
                    strictPipe('gunzip -c "$1"', 'psql -v ON_ERROR_STOP=1 -q -U "$2" -d "$3"', "$1.failed"),
                    "polaris",
                    target.file,
                    loader,
                    target.database
                ]),
                describe: "Loading the copy"
            }
        ];
        if (!owner) {
            const user = quoteIdent(target.username);
            const grants =
                target.privileges === "readwrite"
                    ? [
                          `GRANT CONNECT ON DATABASE ${db} TO ${user};`,
                          `GRANT USAGE, CREATE ON SCHEMA public TO ${user};`,
                          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${user};`,
                          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${user};`,
                          `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${user};`,
                          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${user};`
                      ]
                    : [
                          `GRANT CONNECT ON DATABASE ${db} TO ${user};`,
                          `GRANT USAGE ON SCHEMA public TO ${user};`,
                          `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${user};`,
                          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${user};`
                      ];
            commands.push({
                argv: withEnv({ PGPASSWORD: target.adminPassword }, [
                    "psql",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-U",
                    target.adminUser,
                    "-d",
                    target.database,
                    "-c",
                    grants.join(" ")
                ]),
                describe: `Granting ${target.privileges} to ${target.username} again`
            });
        }
        return commands;
    }

    if (target.engine === "mysql" || target.engine === "mariadb") {
        const client = target.engine === "mysql" ? "mysql" : "mariadb";
        const db = quoteBacktick(target.database);
        // Grants on `db`.* survive a DROP DATABASE in both engines, so the
        // database's own account keeps what it had without being granted again.
        return [
            {
                argv: [client, "-uroot", `-p${target.adminPassword}`, "-e", `DROP DATABASE IF EXISTS ${db}; CREATE DATABASE ${db};`],
                describe: "Removing the current contents"
            },
            {
                argv: [
                    "sh",
                    "-c",
                    strictPipe('gunzip -c "$1"', '"$2" -uroot -p"$4" "$3"', "$1.failed"),
                    "polaris",
                    target.file,
                    client,
                    target.database,
                    target.adminPassword
                ],
                describe: "Loading the copy"
            }
        ];
    }

    // MongoDB: mongorestore drops each collection it restores (`--drop`), limited
    // to this database's namespaces, and renames them when the copy came from a
    // database of another name.
    const from = target.sourceDatabase ?? target.database;
    const rename = from !== target.database ? [`--nsFrom=${from}.*`, `--nsTo=${target.database}.*`] : [];
    return [
        {
            argv: [
                "mongorestore",
                ...(target.seeds ? [`--host=${target.seeds}`] : []),
                `--username=${target.adminUser}`,
                `--password=${target.adminPassword}`,
                "--authenticationDatabase=admin",
                `--archive=${target.file}`,
                "--gzip",
                "--drop",
                `--nsInclude=${from}.*`,
                ...rename
            ],
            describe: "Loading the copy"
        }
    ];
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/**
 * How a Redis instance keeps what it holds.
 *
 * - `default` - what every instance created before this ran: Redis' own
 *   snapshot schedule, no append-only file. Kept so an existing instance's
 *   behaviour does not change because the setting now exists.
 * - `cache` - nothing written to disk, a memory ceiling, and the least recently
 *   used keys evicted to stay under it. What a cache is.
 * - `persistent` - every write appended to a log fsynced each second, plus
 *   snapshots. What a queue or a session store needs.
 */
export const REDIS_MODES = ["default", "cache", "persistent"] as const;
export type RedisMode = (typeof REDIS_MODES)[number];

export const REDIS_MODE_LABELS: Readonly<Record<RedisMode, string>> = {
    default: "Default",
    cache: "Cache",
    persistent: "Persistent"
};

export const REDIS_MODE_NOTES: Readonly<Record<RedisMode, string>> = {
    default: "Redis' own snapshot schedule. What this instance was created with.",
    cache: "Nothing is written to disk. Least recently used keys are evicted to stay under the memory limit.",
    persistent: "Every write is logged and synced to disk each second, as well as snapshotted."
};

/** The memory ceilings offered for cache mode, in megabytes. */
export const REDIS_CACHE_SIZES_MB = [64, 128, 256, 512, 1024, 2048, 4096] as const;

export const redisModeSchema = z
    .object({
        databaseId: z.string().uuid(),
        mode: z.enum(REDIS_MODES),
        maxMemoryMb: z
            .number()
            .int()
            .refine((value) => (REDIS_CACHE_SIZES_MB as readonly number[]).includes(value), "Pick an offered size")
            .optional()
    })
    .refine((value) => value.mode !== "cache" || value.maxMemoryMb !== undefined, {
        path: ["maxMemoryMb"],
        message: "A cache needs a memory limit"
    });

/** The `redis-server` command for a mode. The password is `--requirepass`, the
 *  one way the official image enables authentication. */
export function redisServerCommand(password: string, mode: RedisMode, maxMemoryMb = 256): string[] {
    const base = ["redis-server", "--requirepass", password];
    if (mode === "cache") {
        return [
            ...base,
            "--save",
            "",
            "--appendonly",
            "no",
            "--maxmemory",
            `${maxMemoryMb}mb`,
            "--maxmemory-policy",
            "allkeys-lru"
        ];
    }
    if (mode === "persistent") {
        return [...base, "--appendonly", "yes", "--appendfsync", "everysec", "--save", "3600 1 300 100 60 10000"];
    }
    return base;
}

/**
 * The steps that load an RDB snapshot into a running Redis without stopping it.
 *
 * Redis only reads an RDB file at startup, and restarting an append-only
 * instance loads the append-only file instead - so the snapshot is served by a
 * second, private `redis-server` inside the same container on a loopback port,
 * the instance is made its replica for one full synchronisation (which replaces
 * its dataset, and rewrites its append-only file when it keeps one), and then
 * promoted back. The instance keeps answering throughout.
 *
 * The waiting in between is the caller's: `redisSyncDone` reads the replica's
 * INFO until the synchronisation has finished.
 */
export const REDIS_RESTORE_PORT = 6399;

export function redisRestoreStart(file: string, dir: string): MaintenanceCommand[] {
    return [
        {
            argv: ["sh", "-c", 'mkdir -p "$2" && cp "$1" "$2/dump.rdb"', "polaris", file, dir],
            describe: "Staging the snapshot"
        },
        {
            argv: [
                "redis-server",
                "--port",
                String(REDIS_RESTORE_PORT),
                "--bind",
                "127.0.0.1",
                "--dir",
                dir,
                "--dbfilename",
                "dump.rdb",
                "--appendonly",
                "no",
                "--save",
                "",
                "--daemonize",
                "yes"
            ],
            describe: "Serving the snapshot privately"
        }
    ];
}

/** Make the instance a replica of the private server, which replaces its data. */
export function redisReplicateFrom(password: string): MaintenanceCommand {
    return {
        argv: withEnv({ REDISCLI_AUTH: password }, [
            "redis-cli",
            "REPLICAOF",
            "127.0.0.1",
            String(REDIS_RESTORE_PORT)
        ]),
        describe: "Loading the snapshot"
    };
}

/** The instance's replication state, for `redisSyncDone`. */
export function redisReplicationInfo(password: string): MaintenanceCommand {
    return {
        argv: withEnv({ REDISCLI_AUTH: password }, ["redis-cli", "INFO", "replication"]),
        describe: "Checking the load"
    };
}

/** True once a replica's first full synchronisation has finished. */
export function redisSyncDone(info: string): boolean {
    const field = (name: string): string | undefined =>
        info
            .split(/\r?\n/)
            .find((line) => line.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
    return field("master_link_status") === "up" && field("master_sync_in_progress") === "0";
}

/** Promote the instance back and stop the private server. */
export function redisRestoreFinish(password: string, dir: string): MaintenanceCommand[] {
    return [
        {
            argv: withEnv({ REDISCLI_AUTH: password }, ["redis-cli", "REPLICAOF", "NO", "ONE"]),
            describe: "Promoting the instance"
        },
        {
            argv: ["redis-cli", "-p", String(REDIS_RESTORE_PORT), "SHUTDOWN", "NOSAVE"],
            describe: "Stopping the private server"
        },
        { argv: ["rm", "-rf", "--", dir], describe: "Removing the staged snapshot" }
    ];
}

// ---------------------------------------------------------------------------
// MongoDB replica set
// ---------------------------------------------------------------------------

/** The replica set's name. One per instance, so one name is enough. */
export const MONGO_REPLICA_SET = "rs0";

/** Where the key file the members authenticate each other with is kept: inside
 *  the data volume, so it survives the container being recreated. */
const MONGO_KEYFILE = "/data/db/.polaris-keyfile";

/**
 * The command that runs `mongod` as a single-member replica set.
 *
 * A replica set is what change streams and multi-document transactions need.
 * With authentication on - which the image turns on when it creates the root
 * account - a replica set also needs a key file for its members to
 * authenticate each other, even with one member. The image's entrypoint does
 * not create one, so the command creates it on first start (owned by the
 * `mongodb` user with mode 400, as mongod requires) and then hands over to the
 * entrypoint unchanged; the entrypoint drops `--replSet` and `--keyFile` for
 * its own first-boot initialisation and keeps them for the real server.
 *
 * One line: a container's command reaches compose through the host daemon,
 * which refuses any argument holding a control character, and through a YAML
 * file on a remote server, where a line break inside a quoted value is folded
 * into a space. A script written over several lines ran on neither.
 */
export function mongoReplicaSetCommand(): string[] {
    const script = [
        `if [ ! -s "${MONGO_KEYFILE}" ]; then head -c 756 /dev/urandom | base64 > "${MONGO_KEYFILE}"`,
        `chmod 400 "${MONGO_KEYFILE}"`,
        `chown mongodb:mongodb "${MONGO_KEYFILE}"`,
        "fi",
        `exec docker-entrypoint.sh mongod --replSet ${MONGO_REPLICA_SET} --bind_ip_all --keyFile "${MONGO_KEYFILE}"`
    ].join("; ");
    return ["sh", "-c", script];
}

/**
 * Initiate the set once the server is up, with the member named by the
 * address other services reach it on. Idempotent: an already-initiated set
 * answers with its status rather than an error, and so does one another
 * caller initiated between the status check and the initiation.
 */
export function mongoInitiateCommand(adminUser: string, adminPassword: string, host: string): MaintenanceCommand {
    if (!/^[A-Za-z0-9._-]+$/.test(host)) throw new Error("A member host is a container name");
    const config = `{ _id: ${JSON.stringify(MONGO_REPLICA_SET)}, members: [{ _id: 0, host: ${JSON.stringify(`${host}:27017`)} }] }`;
    const script = `try { rs.status().ok } catch (error) { try { rs.initiate(${config}).ok } catch (again) { if (again.codeName !== "AlreadyInitialized") throw again; 1 } }`;
    return {
        argv: [
            "mongosh",
            "--quiet",
            "-u",
            adminUser,
            "-p",
            adminPassword,
            "--authenticationDatabase",
            "admin",
            "--eval",
            script
        ],
        describe: "Starting the replica set"
    };
}

// ---------------------------------------------------------------------------
// PostgreSQL point-in-time recovery
// ---------------------------------------------------------------------------

/**
 * Where the write-ahead log archive and the base backups live: a host folder
 * mounted into the instance, beside - not inside - its data volume.
 *
 * A host folder rather than a volume because a recovery runs in a NEW instance
 * with a data volume of its own, and it has to read the archive the original
 * wrote. A named volume belongs to one compose project; a folder under the
 * host's volume root can be mounted by both.
 */
export const PITR_MOUNT = "/polaris-pitr";

/** The host folder, relative to the volume root, for one instance's archive. */
export function pitrHostFolder(databaseId: string): string {
    return `pitr/${databaseId}`;
}

/**
 * The `postgres` command that archives every completed WAL segment.
 *
 * The archive command is the one the PostgreSQL manual gives: it refuses to
 * overwrite a segment already archived, and returns non-zero on any failure so
 * the server keeps the segment and retries. A minute of `archive_timeout` is
 * the manual's own suggestion - it bounds how much can be lost to a disk that
 * dies between segments, at the cost of an archive of mostly-empty segments on
 * an idle instance.
 */
export function pitrServerCommand(): string[] {
    return [
        "postgres",
        "-c",
        "wal_level=replica",
        "-c",
        "archive_mode=on",
        "-c",
        `archive_command=test ! -f ${PITR_MOUNT}/wal/%f && cp %p ${PITR_MOUNT}/wal/%f`,
        "-c",
        "archive_timeout=60"
    ];
}

/** Make the archive folders exist and belong to the server's own user - a host
 *  folder mounted in is created by the engine as root. */
export function pitrPrepareCommand(): MaintenanceCommand {
    return {
        argv: ["sh", "-c", 'mkdir -p "$1/wal" "$1/base" && chown -R postgres:postgres "$1"', "polaris", PITR_MOUNT],
        describe: "Preparing the archive"
    };
}

/**
 * Take a base backup into the archive, labelled with when it started.
 *
 * `-X none` because the archive already has every segment; `-c fast` so the
 * backup starts now rather than after the next scheduled checkpoint. Over the
 * local socket, where the image's `initdb` leaves replication connections
 * trusted, as the instance's own account - the superuser the image created.
 * It returns only once the server has archived the last segment the backup
 * needs, so a finished command is a restorable backup.
 */
export function pitrBaseBackupCommand(label: string, username: string): MaintenanceCommand {
    if (!/^[0-9TZ-]+$/.test(label)) throw new Error("A base backup label is a timestamp");
    return {
        argv: [
            "pg_basebackup",
            "-h",
            "/var/run/postgresql",
            "-U",
            username,
            "-D",
            `${PITR_MOUNT}/base/${label}`,
            "-F",
            "t",
            "-z",
            "-X",
            "none",
            "-c",
            "fast",
            "-l",
            `polaris ${label}`
        ],
        describe: "Taking a base backup"
    };
}

/** The newest backup history file in the archive: its name is what
 *  `pg_archivecleanup` is given to keep the segments a base backup needs. */
export function pitrNewestHistoryCommand(): MaintenanceCommand {
    return {
        argv: ["sh", "-c", 'ls -1 "$1/wal" | grep "\\.backup$" | sort | tail -n 1', "polaris", PITR_MOUNT],
        describe: "Finding the newest backup record"
    };
}

/** Remove the segments older than the oldest base backup still kept, and the
 *  base backups that have fallen out of retention. */
export function pitrCleanupCommands(oldestHistoryFile: string, removeBases: readonly string[]): MaintenanceCommand[] {
    if (!/^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$/.test(oldestHistoryFile)) {
        throw new Error("That is not a backup history file name");
    }
    const commands: MaintenanceCommand[] = removeBases.map((label) => {
        if (!/^[0-9TZ-]+$/.test(label)) throw new Error("A base backup label is a timestamp");
        return {
            argv: ["rm", "-rf", "--", `${PITR_MOUNT}/base/${label}`],
            describe: `Removing the base backup of ${label}`
        };
    });
    commands.push({
        argv: ["pg_archivecleanup", `${PITR_MOUNT}/wal`, oldestHistoryFile],
        describe: "Removing log segments no kept backup needs"
    });
    return commands;
}

/**
 * The command a recovered instance starts with.
 *
 * On its first start its data folder is empty, so the base backup is unpacked
 * into it, `recovery.signal` is created and the recovery settings are appended:
 * where the archived segments are, the moment to stop at, and to promote once
 * there. The image's entrypoint then finds an existing cluster and starts it,
 * PostgreSQL replays the archive to the target and opens for writes. On every
 * later start the folder is not empty and the command only hands over.
 *
 * The recovered instance does not archive: its settings come from this
 * command, and nothing here repeats the original's archive settings, so it
 * never writes into the archive it is reading from.
 *
 * One line, for the reason `mongoReplicaSetCommand` gives.
 */
export function pitrRecoveryCommand(baseLabel: string, target: Date): string[] {
    if (!/^[0-9TZ-]+$/.test(baseLabel)) throw new Error("A base backup label is a timestamp");
    const script = [
        "set -e",
        'if [ ! -s "$PGDATA/PG_VERSION" ]; then mkdir -p "$PGDATA"',
        'tar -xzf "$1" -C "$PGDATA"',
        'touch "$PGDATA/recovery.signal"',
        "printf \"%s\\n\" \"restore_command = 'cp $3/wal/%f %p'\" \"recovery_target_time = '$2'\" \"recovery_target_action = 'promote'\" >> \"$PGDATA/postgresql.auto.conf\"",
        'chown -R postgres:postgres "$PGDATA"',
        'chmod 700 "$PGDATA"',
        "fi",
        "exec docker-entrypoint.sh postgres"
    ].join("; ");
    return [
        "sh",
        "-c",
        script,
        "polaris",
        `${PITR_MOUNT}/base/${baseLabel}/base.tar.gz`,
        toRecoveryTime(target),
        PITR_MOUNT
    ];
}

/** A recovery target the way PostgreSQL reads one: `YYYY-MM-DD HH:MM:SS+00`. */
export function toRecoveryTime(at: Date): string {
    return `${at.toISOString().slice(0, 19).replace("T", " ")}+00`;
}

/** A base backup's label from when it started - sortable, and safe in a path. */
export function pitrLabel(at: Date): string {
    return at.toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
}

/**
 * The base backup a recovery to `target` starts from: the newest one that had
 * FINISHED by then. PostgreSQL cannot recover to a moment inside a base backup,
 * so one still running at the target is no use - the one before it is.
 */
export function pitrBaseFor<T extends { readonly finishedAt: Date }>(
    bases: readonly T[],
    target: Date
): T | null {
    return (
        [...bases]
            .filter((base) => base.finishedAt.getTime() <= target.getTime())
            .sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime())[0] ?? null
    );
}

/** The recovery windows offered, in days. */
export const PITR_KEEP_DAYS = [1, 3, 7, 14, 30] as const;

export const pitrSettingsSchema = z.object({
    databaseId: z.string().uuid(),
    enabled: z.boolean(),
    keepDays: z
        .number()
        .int()
        .refine((value) => (PITR_KEEP_DAYS as readonly number[]).includes(value), "Pick an offered window")
});

export const mongoReplicaSetSchema = z.object({
    databaseId: z.string().uuid(),
    enabled: z.boolean()
});

export const pitrRestoreSchema = z.object({
    databaseId: z.string().uuid(),
    /** ISO timestamp of the moment to recover to. */
    target: z.string().datetime({ offset: true }),
    /** The name of the new instance the recovery lands in. */
    name: z.string().trim().min(1).max(64)
});

export const databaseUpgradeSchema = z.object({
    databaseId: z.string().uuid(),
    version: z.string().trim().min(1).max(24),
    /** When to run it. Absent is now. */
    at: z.string().datetime({ offset: true }).optional()
});

export const databaseCopySchema = z
    .object({
        /** The database the data goes into. Its current contents are replaced. */
        databaseId: z.string().uuid(),
        /** A managed database to copy from... */
        fromDatabaseId: z.string().uuid().optional(),
        /** ...or a connection string to one somewhere else. */
        fromUrl: z.string().trim().max(2048).optional()
    })
    .refine((value) => Boolean(value.fromDatabaseId) !== Boolean(value.fromUrl), {
        message: "Copy from one managed database or one connection string",
        path: ["fromUrl"]
    });

/** A connection string, parsed and checked for the engine it has to be. */
export interface ExternalSource {
    readonly engine: "postgres" | "mysql" | "mariadb" | "mongo" | "redis";
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly username: string;
    readonly password: string;
    readonly tls: boolean;
    /** MongoDB: the database the account signs in against (`authSource`). */
    readonly authSource: string;
}

/**
 * Read a connection string somebody pasted into its parts.
 *
 * Returns null for anything that is not a URL of one of the schemes the dump
 * tools read, or whose host carries anything but a hostname - the host reaches
 * a command line inside the container.
 */
export function parseExternalSource(raw: string, into: ManagedEngine): ExternalSource | null {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    const scheme = url.protocol.replace(/:$/, "");
    const engine =
        scheme === "postgres" || scheme === "postgresql"
            ? "postgres"
            : scheme === "mysql"
              ? into === "mariadb"
                  ? "mariadb"
                  : "mysql"
              : scheme === "mariadb"
                ? "mariadb"
                : scheme === "mongodb"
                  ? "mongo"
                  : scheme === "redis" || scheme === "rediss"
                    ? "redis"
                    : null;
    if (!engine) return null;
    const host = url.hostname;
    if (!/^[A-Za-z0-9.-]+$/.test(host) || host.startsWith("-")) return null;
    const defaults: Record<ExternalSource["engine"], number> = {
        postgres: 5432,
        mysql: 3306,
        mariadb: 3306,
        mongo: 27017,
        redis: 6379
    };
    let database: string;
    try {
        database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    } catch {
        return null;
    }
    // Redis names a numbered database in the path; the dump takes all of them.
    if (engine === "redis") database = "";
    if (database && !/^[A-Za-z0-9_$-]+$/.test(database)) return null;
    const authSource = url.searchParams.get("authSource") ?? "admin";
    if (!/^[A-Za-z0-9_$-]+$/.test(authSource)) return null;
    return {
        authSource,
        engine,
        host,
        port: url.port ? Number(url.port) : defaults[engine],
        database,
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        tls:
            scheme === "rediss" ||
            url.searchParams.get("sslmode") === "require" ||
            url.searchParams.get("ssl") === "true" ||
            url.searchParams.get("tls") === "true"
    };
}

/**
 * A dump of a database somewhere else, taken from inside the destination's own
 * container - which has the engine's client tools and can reach the network -
 * written to `file` in the same format the local dumps use, so the restore
 * steps above load it without knowing where it came from.
 */
export function externalDumpCommand(source: ExternalSource, file: string): MaintenanceCommand {
    if (source.engine === "postgres") {
        return {
            argv: withEnv({ PGPASSWORD: source.password, ...(source.tls ? { PGSSLMODE: "require" } : {}) }, [
                "sh",
                "-c",
                strictPipe('pg_dump --no-owner --no-acl -h "$1" -p "$2" -U "$3" -d "$4"', 'gzip > "$5"', "$5.failed"),
                "polaris",
                source.host,
                String(source.port),
                source.username,
                source.database,
                file
            ]),
            describe: `Copying ${source.database} from ${source.host}`
        };
    }
    if (source.engine === "mysql" || source.engine === "mariadb") {
        const tool = source.engine === "mysql" ? "mysqldump" : "mariadb-dump";
        return {
            argv: [
                "sh",
                "-c",
                strictPipe(
                    `${tool} --single-transaction --routines --triggers -h "$1" -P "$2" -u "$3" -p"$6" "$4"`,
                    'gzip > "$5"',
                    "$5.failed"
                ),
                "polaris",
                source.host,
                String(source.port),
                source.username,
                source.database,
                file,
                source.password
            ],
            describe: `Copying ${source.database} from ${source.host}`
        };
    }
    if (source.engine === "mongo") {
        return {
            argv: [
                "mongodump",
                `--host=${source.host}`,
                `--port=${source.port}`,
                `--username=${source.username}`,
                `--password=${source.password}`,
                `--authenticationDatabase=${source.authSource}`,
                `--db=${source.database}`,
                ...(source.tls ? ["--ssl"] : []),
                `--archive=${file}`,
                "--gzip"
            ],
            describe: `Copying ${source.database} from ${source.host}`
        };
    }
    return {
        argv: withEnv({ REDISCLI_AUTH: source.password }, [
            "redis-cli",
            "-h",
            source.host,
            "-p",
            String(source.port),
            // An ACL account other than the default one is named as well.
            ...(source.username && source.username !== "default" ? ["--user", source.username] : []),
            ...(source.tls ? ["--tls"] : []),
            "--rdb",
            file
        ]),
        describe: `Copying the dataset from ${source.host}`
    };
}
