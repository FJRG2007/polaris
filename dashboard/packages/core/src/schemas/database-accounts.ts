/**
 * The commands behind a database's Users and Processes tabs: the accounts an
 * instance holds and what each may reach, and the connections open on it right
 * now.
 *
 * Pure for the same reason as `database-statements`: these return argument
 * vectors and never run anything. Every name is checked against a strict
 * pattern AND quoted the way the engine quotes it, every password must be one
 * Polaris generated, and a connection id must be a positive integer - so no
 * value that reaches a statement can end the literal or identifier it sits in.
 *
 * Refusals, from a schema or a builder, are keys of the `deployServer`
 * catalog's `databases.issues` group, translated by the action that shows them.
 */

import { z } from "zod";
import { DB_PRIVILEGES, type DbPrivilege } from "./database.js";

/** The engines these tabs work on. */
export const ACCOUNT_ENGINES = ["postgres", "mysql", "mariadb"] as const;
export type AccountEngine = (typeof ACCOUNT_ENGINES)[number];

export function isAccountEngine(engine: string): engine is AccountEngine {
    return (ACCOUNT_ENGINES as readonly string[]).includes(engine);
}

/** The instance a command runs against, signed in as its administrative account. */
export interface AccountTarget {
    readonly engine: AccountEngine;
    readonly adminUser: string;
    readonly adminPassword: string;
}

/** A command to run inside the instance's container. `describe` never carries a secret. */
export interface AccountCommand {
    readonly argv: readonly string[];
    readonly describe: string;
}

const USERNAME = /^[a-z_][a-z0-9_]{0,31}$/;
const DATABASE = /^[A-Za-z0-9_]{1,63}$/;
const GENERATED_PASSWORD = /^[A-Za-z0-9_-]{16,128}$/;

/** Accounts the engines keep for themselves; never created, dropped or regranted here. */
const RESERVED = new Set([
    "postgres",
    "root",
    "mysql",
    "mariadb",
    "public",
    "pg_monitor",
    "replication",
    "replicator",
    "polaris"
]);

export function isReservedAccount(username: string): boolean {
    return (
        RESERVED.has(username) ||
        username.startsWith("pg_") ||
        username.startsWith("mysql.") ||
        username.startsWith("mariadb.")
    );
}

export const dbAccountCreateSchema = z.object({
    username: z
        .string()
        .trim()
        .toLowerCase()
        .regex(USERNAME, "databases.issues.accountName")
        .refine((name) => !isReservedAccount(name), "databases.issues.accountReserved")
});

export const dbAccountGrantSchema = z.object({
    username: z.string().trim().regex(USERNAME, "databases.issues.notManagedAccount"),
    database: z.string().trim().regex(DATABASE, "databases.issues.notManagedDatabase"),
    privileges: z.enum(DB_PRIVILEGES)
});

export const dbAccountRevokeSchema = dbAccountGrantSchema.omit({ privileges: true });

function checkUsername(username: string): string {
    if (!USERNAME.test(username)) throw new Error("databases.issues.notManagedAccount");
    return username;
}

function checkDatabase(database: string): string {
    if (!DATABASE.test(database)) throw new Error("databases.issues.notManagedDatabase");
    return database;
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

function mysqlAccount(username: string): string {
    return `${quoteLiteral(checkUsername(username))}@'%'`;
}

/** One `psql` statement against one database, unaligned and tuple-only for reading. */
function psql(target: AccountTarget, database: string, statement: string): string[] {
    return [
        "env",
        `PGPASSWORD=${target.adminPassword}`,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-U",
        target.adminUser,
        "-d",
        database,
        "-c",
        statement
    ];
}

/** One batch of MySQL / MariaDB statements, tab-separated with no header. */
function mysql(target: AccountTarget, statements: string): string[] {
    return [
        target.engine === "mysql" ? "mysql" : "mariadb",
        "-uroot",
        `-p${target.adminPassword}`,
        "-N",
        "-B",
        "-e",
        statements
    ];
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** An account as the Users tab lists it. */
export interface DbAccount {
    readonly username: string;
    /** Databases it can connect to by a grant of its own (or owns). */
    readonly databases: readonly string[];
    /** A superuser, or the engine's own account: shown, never changed. */
    readonly protected: boolean;
}

const ACCOUNT_LIMIT = 200;

export function listAccountsCommand(target: AccountTarget): AccountCommand {
    if (target.engine === "postgres") {
        const statement = [
            "SELECT r.rolname, r.rolsuper,",
            "coalesce((SELECT string_agg(d.datname, ',' ORDER BY d.datname) FROM pg_database d",
            "WHERE NOT d.datistemplate AND (d.datdba = r.oid OR EXISTS (SELECT 1 FROM aclexplode(d.datacl) a",
            "WHERE a.grantee = r.oid AND a.privilege_type = 'CONNECT'))), '')",
            "FROM pg_roles r WHERE r.rolcanlogin AND r.rolname !~ '^pg_'",
            `ORDER BY r.rolname LIMIT ${ACCOUNT_LIMIT}`
        ].join(" ");
        return { argv: psql(target, "postgres", statement), describe: "Listing the accounts" };
    }
    const statement = [
        "SELECT u.User, IF(u.Super_priv = 'Y', 1, 0),",
        "IFNULL((SELECT GROUP_CONCAT(DISTINCT d.Db ORDER BY d.Db) FROM mysql.db d WHERE d.User = u.User AND d.Host = u.Host), '')",
        "FROM mysql.user u WHERE u.Host = '%' AND u.User <> ''",
        `ORDER BY u.User LIMIT ${ACCOUNT_LIMIT}`
    ].join(" ");
    return { argv: mysql(target, statement), describe: "Listing the accounts" };
}

export function parseAccounts(
    engine: AccountEngine,
    output: string,
    adminUser: string
): DbAccount[] {
    const separator = engine === "postgres" ? "|" : "\t";
    return output
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => {
            const [username = "", superuser = "", databases = ""] = line.split(separator);
            const isSuper = superuser === "t" || superuser === "1";
            return {
                username,
                databases: databases ? databases.split(",").filter(Boolean) : [],
                protected: isSuper || username === adminUser || isReservedAccount(username)
            };
        })
        .filter((account) => account.username.length > 0);
}

/** Create a login account with a generated password and no database yet. */
export function createAccountCommand(
    target: AccountTarget,
    username: string,
    password: string
): AccountCommand {
    checkUsername(username);
    if (isReservedAccount(username)) throw new Error("databases.issues.engineAccount");
    if (!GENERATED_PASSWORD.test(password)) throw new Error("databases.issues.generatedPassword");
    const describe = `Creating the account ${username}`;
    if (target.engine === "postgres") {
        return {
            argv: psql(
                target,
                "postgres",
                `CREATE ROLE ${quoteIdent(username)} WITH LOGIN PASSWORD ${quoteLiteral(password)}`
            ),
            describe
        };
    }
    return {
        argv: mysql(
            target,
            `CREATE USER ${mysqlAccount(username)} IDENTIFIED BY ${quoteLiteral(password)}; FLUSH PRIVILEGES;`
        ),
        describe
    };
}

/** Drop an account. PostgreSQL refuses while it still owns something, and says so. */
export function dropAccountCommand(target: AccountTarget, username: string): AccountCommand {
    checkUsername(username);
    if (isReservedAccount(username)) throw new Error("databases.issues.engineAccount");
    const describe = `Removing the account ${username}`;
    if (target.engine === "postgres") {
        return {
            argv: psql(target, "postgres", `DROP ROLE IF EXISTS ${quoteIdent(username)}`),
            describe
        };
    }
    return {
        argv: mysql(target, `DROP USER IF EXISTS ${mysqlAccount(username)}; FLUSH PRIVILEGES;`),
        describe
    };
}

function mysqlPrivileges(privileges: DbPrivilege): string {
    if (privileges === "readonly") return "SELECT";
    if (privileges === "readwrite") return "SELECT, INSERT, UPDATE, DELETE";
    return "ALL PRIVILEGES";
}

/** What a PostgreSQL account may do inside the database, run from a connection to it. */
function postgresSchemaGrants(user: string, privileges: DbPrivilege): string[] {
    if (privileges === "owner") {
        return [
            `GRANT ALL ON SCHEMA public TO ${user};`,
            `GRANT ALL ON ALL TABLES IN SCHEMA public TO ${user};`,
            `GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${user};`,
            `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${user};`,
            `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${user};`
        ];
    }
    if (privileges === "readwrite") {
        return [
            `GRANT USAGE, CREATE ON SCHEMA public TO ${user};`,
            `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${user};`,
            `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${user};`,
            `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${user};`,
            `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${user};`
        ];
    }
    return [
        `GRANT USAGE ON SCHEMA public TO ${user};`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${user};`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${user};`
    ];
}

function postgresSchemaRevokes(user: string): string[] {
    return [
        `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${user};`,
        `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${user};`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${user};`,
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${user};`,
        `REVOKE ALL ON SCHEMA public FROM ${user};`
    ];
}

/**
 * Give an account one level of access to one database. What it had there
 * before is taken away first, so moving from read-write to read-only narrows.
 */
export function grantAccountCommands(
    target: AccountTarget,
    grant: {
        readonly username: string;
        readonly database: string;
        readonly privileges: DbPrivilege;
    }
): AccountCommand[] {
    const username = checkUsername(grant.username);
    const database = checkDatabase(grant.database);
    if (isReservedAccount(username)) throw new Error("databases.issues.engineAccount");
    const describe = `Giving ${username} ${grant.privileges} access to ${database}`;
    if (target.engine === "postgres") {
        const user = quoteIdent(username);
        const db = quoteIdent(database);
        return [
            {
                argv: psql(
                    target,
                    "postgres",
                    grant.privileges === "owner"
                        ? `GRANT ALL PRIVILEGES ON DATABASE ${db} TO ${user}`
                        : `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${user}`
                ),
                describe
            },
            {
                argv: psql(
                    target,
                    database,
                    [
                        ...postgresSchemaRevokes(user),
                        ...postgresSchemaGrants(user, grant.privileges)
                    ].join(" ")
                ),
                describe
            }
        ];
    }
    const account = mysqlAccount(username);
    const db = quoteBacktick(database);
    return [
        {
            argv: mysql(
                target,
                `REVOKE ALL PRIVILEGES ON ${db}.* FROM ${account}; GRANT ${mysqlPrivileges(grant.privileges)} ON ${db}.* TO ${account}; FLUSH PRIVILEGES;`
            ),
            describe
        }
    ];
}

/** Take an account's access to one database away entirely. */
export function revokeAccountCommands(
    target: AccountTarget,
    revoke: { readonly username: string; readonly database: string }
): AccountCommand[] {
    const username = checkUsername(revoke.username);
    const database = checkDatabase(revoke.database);
    if (isReservedAccount(username)) throw new Error("databases.issues.engineAccount");
    const describe = `Taking ${username}'s access to ${database} away`;
    if (target.engine === "postgres") {
        const user = quoteIdent(username);
        return [
            { argv: psql(target, database, postgresSchemaRevokes(user).join(" ")), describe },
            {
                argv: psql(
                    target,
                    "postgres",
                    `REVOKE ALL ON DATABASE ${quoteIdent(database)} FROM ${user}`
                ),
                describe
            }
        ];
    }
    // MySQL refuses a REVOKE for a grant that does not exist; a USAGE grant first makes it one that does.
    const account = mysqlAccount(username);
    const db = quoteBacktick(database);
    return [
        {
            argv: mysql(
                target,
                `GRANT USAGE ON ${db}.* TO ${account}; REVOKE ALL PRIVILEGES ON ${db}.* FROM ${account}; FLUSH PRIVILEGES;`
            ),
            describe
        }
    ];
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/** One open connection. */
export interface DbProcess {
    readonly id: number;
    readonly user: string;
    readonly database: string;
    readonly client: string;
    readonly state: string;
    /** How long its current statement (or state) has run, in seconds. */
    readonly seconds: number;
    /** The connection that made this listing: shown, never killable. */
    readonly self: boolean;
    /** The statement, flattened to one line and cut short. */
    readonly query: string;
}

/** The busiest connections listed; the exec channel is bounded, so the list is too. */
export const PROCESS_LIMIT = 50;
const QUERY_CHARS = 160;

export function processListCommand(target: AccountTarget): AccountCommand {
    if (target.engine === "postgres") {
        const statement = [
            "SELECT pid, coalesce(usename, ''), coalesce(datname, ''), coalesce(host(client_addr), 'local'),",
            "coalesce(state, ''), coalesce(extract(epoch FROM now() - coalesce(query_start, backend_start))::bigint, 0),",
            "CASE WHEN pid = pg_backend_pid() THEN 1 ELSE 0 END,",
            `left(regexp_replace(coalesce(query, ''), '[[:space:]|]+', ' ', 'g'), ${QUERY_CHARS})`,
            "FROM pg_stat_activity WHERE backend_type = 'client backend'",
            `ORDER BY (pid = pg_backend_pid()) DESC, query_start ASC NULLS LAST LIMIT ${PROCESS_LIMIT}`
        ].join(" ");
        return { argv: psql(target, "postgres", statement), describe: "Listing the connections" };
    }
    const statement = [
        "SELECT ID, IFNULL(USER, ''), IFNULL(DB, ''), IFNULL(HOST, ''), IFNULL(COMMAND, ''), IFNULL(TIME, 0),",
        "IF(ID = CONNECTION_ID(), 1, 0),",
        `LEFT(REPLACE(REPLACE(REPLACE(IFNULL(INFO, ''), CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '), ${QUERY_CHARS})`,
        "FROM information_schema.PROCESSLIST",
        `ORDER BY (ID = CONNECTION_ID()) DESC, TIME DESC LIMIT ${PROCESS_LIMIT}`
    ].join(" ");
    return { argv: mysql(target, statement), describe: "Listing the connections" };
}

export function parseProcessList(engine: AccountEngine, output: string): DbProcess[] {
    const separator = engine === "postgres" ? "|" : "\t";
    const processes: DbProcess[] = [];
    for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const fields = line.split(separator);
        if (fields.length < 8) continue;
        const id = Number(fields[0]);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        processes.push({
            id,
            user: fields[1] ?? "",
            database: fields[2] ?? "",
            client: fields[3] ?? "",
            state: fields[4] ?? "",
            seconds: Math.max(0, Number(fields[5]) || 0),
            self: fields[6] === "1",
            query: fields.slice(7).join(" ").trim()
        });
    }
    return processes;
}

export const dbProcessKillSchema = z.object({
    processId: z
        .number({ message: "databases.issues.connectionId" })
        .int("databases.issues.connectionId")
        .positive("databases.issues.connectionId")
        .max(2 ** 53 - 1, "databases.issues.connectionId")
});

/** End one connection, by its numeric id only. */
export function killProcessCommand(target: AccountTarget, processId: number): AccountCommand {
    if (!Number.isSafeInteger(processId) || processId <= 0)
        throw new Error("databases.issues.connectionId");
    const describe = `Ending connection ${processId}`;
    if (target.engine === "postgres") {
        return {
            argv: psql(target, "postgres", `SELECT pg_terminate_backend(${processId})`),
            describe
        };
    }
    return { argv: mysql(target, `KILL ${processId}`), describe };
}
