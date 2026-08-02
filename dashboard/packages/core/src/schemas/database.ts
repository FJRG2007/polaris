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

/** The engine's own name for itself, for anywhere an engine id would otherwise
 *  be shown raw. Falls back to the stored value so a row written by a future
 *  version still renders as something. */
export function dbEngineLabel(engine: string): string {
    return DB_ENGINE_INFO[engine as DbEngine]?.label ?? engine;
}

/** True when an engine can host more databases beside the one it was created
 *  for, which is what makes it an instance others can be placed on. */
export function canShareInstance(engine: string): boolean {
    return DB_ENGINE_INFO[engine as DbEngine]?.namedDatabases ?? false;
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

export const databaseCreateSchema = z
    .object({
        environmentId: z.string().uuid(),
        /** Display name. The slug derived from it identifies the service. */
        name: z.string().trim().min(1, "A database name is required").max(64),
        engine: z.enum(DB_ENGINES),
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
        privileges: z.enum(DB_PRIVILEGES).default("owner")
    })
    .superRefine((value, ctx) => {
        const info = DB_ENGINE_INFO[value.engine];
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
    });

export type DatabaseCreateInput = z.input<typeof databaseCreateSchema>;
export type DatabaseCreate = z.output<typeof databaseCreateSchema>;
