/**
 * The commands that create (and drop) a logical database inside an engine that
 * is already running, one builder per engine.
 *
 * Pure by design: these return argument vectors, never run anything, so the
 * exact statements a given request produces can be read in a test instead of
 * inferred from a container's behaviour. Callers hand the vectors to the
 * runtime, which execs them with no shell in between.
 *
 * Identifiers reaching here have already passed `databaseCreateSchema`, which
 * allows letters, digits and underscores only, and passwords which cannot
 * contain a quote or a backslash. The quoting below is the second gate, not the
 * only one: identifiers are quoted the way the engine quotes them and literals
 * are single-quoted.
 */

import { DB_ENGINE_INFO, type DbEngine, type DbPrivilege } from "./database.js";

export interface DatabaseGrant {
    /** The logical database to create. Unused by engines without named databases. */
    readonly database: string;
    readonly username: string;
    readonly password: string;
    readonly privileges: DbPrivilege;
    /** The instance's own administrative account, used to run the statements. */
    readonly adminUser: string;
    readonly adminPassword: string;
}

/** Double-quoted SQL identifier (PostgreSQL, and standard SQL). */
function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** Backtick-quoted identifier (MySQL / MariaDB). */
function quoteBacktick(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
}

/** Single-quoted SQL string literal. */
function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Statements that create the database and the account, in order.
 *
 * They are kept separate rather than joined because `psql -c` wraps everything
 * in one string in a single transaction, and `CREATE DATABASE` is one of the few
 * statements PostgreSQL refuses to run inside one. Each therefore travels as its
 * own command.
 */
function postgresCreate(grant: DatabaseGrant): string[] {
    const db = quoteIdent(grant.database);
    const user = quoteIdent(grant.username);
    return [
        `CREATE ROLE ${user} WITH LOGIN PASSWORD ${quoteLiteral(grant.password)}`,
        grant.privileges === "owner" ? `CREATE DATABASE ${db} OWNER ${user}` : `CREATE DATABASE ${db}`,
        `GRANT CONNECT ON DATABASE ${db} TO ${user}`
    ];
}

/** Statements run inside the new database, once it exists. PostgreSQL grants on
 *  a schema can only be made from a connection to that database. */
function postgresGrantInDatabase(grant: DatabaseGrant): string[] {
    const user = quoteIdent(grant.username);
    if (grant.privileges === "owner") return [];
    if (grant.privileges === "readwrite") {
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

/** A `psql` invocation against one database, running one statement. */
function psql(grant: DatabaseGrant, database: string, statement: string): string[] {
    return ["psql", "-v", "ON_ERROR_STOP=1", "-U", grant.adminUser, "-d", database, "-c", statement];
}

function mysqlPrivilegeList(privileges: DbPrivilege): string {
    if (privileges === "readonly") return "SELECT";
    if (privileges === "readwrite") return "SELECT, INSERT, UPDATE, DELETE";
    return "ALL PRIVILEGES";
}

function mysqlCreate(grant: DatabaseGrant): string[] {
    const db = quoteBacktick(grant.database);
    const user = `${quoteLiteral(grant.username)}@'%'`;
    return [
        `CREATE DATABASE IF NOT EXISTS ${db};`,
        `CREATE USER ${user} IDENTIFIED BY ${quoteLiteral(grant.password)};`,
        `GRANT ${mysqlPrivilegeList(grant.privileges)} ON ${db}.* TO ${user};`,
        "FLUSH PRIVILEGES;"
    ];
}

function mongoRole(privileges: DbPrivilege): string {
    if (privileges === "readonly") return "read";
    if (privileges === "readwrite") return "readWrite";
    return "dbOwner";
}

/**
 * A command to run inside the instance's container: an argument vector, plus
 * whether it carries a secret (so a deploy log can say what ran without
 * printing the password).
 */
export interface ContainerCommand {
    readonly argv: readonly string[];
    /** What to show in the log in place of the command. */
    readonly describe: string;
}

/**
 * Everything that has to run inside an instance's container to add a database
 * and the account that reaches it. Returns an empty list for an engine that
 * cannot host more than one dataset.
 */
export function createDatabaseCommands(engine: DbEngine, grant: DatabaseGrant): ContainerCommand[] {
    if (!DB_ENGINE_INFO[engine].namedDatabases) return [];
    if (engine === "postgres") {
        const commands: ContainerCommand[] = postgresCreate(grant).map((statement) => ({
            argv: psql(grant, "postgres", statement),
            describe: `Creating database ${grant.database} and role ${grant.username}`
        }));
        // The grants below act on a schema, which can only be reached from a
        // connection to the database itself - hence the second target.
        const inDatabase = postgresGrantInDatabase(grant);
        if (inDatabase.length > 0) {
            commands.push({
                argv: psql(grant, grant.database, inDatabase.join(" ")),
                describe: `Granting ${grant.privileges} on ${grant.database} to ${grant.username}`
            });
        }
        return commands;
    }
    if (engine === "mysql" || engine === "mariadb") {
        return [
            {
                // The admin password goes in the argv of a process inside the
                // container, which is the only channel the client offers without
                // a config file; the container is not shared with other tenants.
                argv: [engine === "mysql" ? "mysql" : "mariadb", `-u${grant.adminUser}`, `-p${grant.adminPassword}`, "-e", mysqlCreate(grant).join(" ")],
                describe: `Creating database ${grant.database} and user ${grant.username}`
            }
        ];
    }
    // Mongo creates the database on first write, so only the user is made; the
    // role it is given is what scopes it to that database.
    const user = JSON.stringify(grant.username);
    const database = JSON.stringify(grant.database);
    const role = JSON.stringify(mongoRole(grant.privileges));
    const script = `db.getSiblingDB(${database}).createUser({user: ${user}, pwd: ${JSON.stringify(grant.password)}, roles: [{role: ${role}, db: ${database}}]})`;
    return [
        {
            argv: [
                "mongosh",
                "--quiet",
                "-u",
                grant.adminUser,
                "-p",
                grant.adminPassword,
                "--authenticationDatabase",
                "admin",
                "--eval",
                script
            ],
            describe: `Creating database ${grant.database} and user ${grant.username}`
        }
    ];
}

/** The reverse: drop the logical database and the account that reached it. */
export function dropDatabaseCommands(engine: DbEngine, grant: DatabaseGrant): ContainerCommand[] {
    if (!DB_ENGINE_INFO[engine].namedDatabases) return [];
    if (engine === "postgres") {
        // DROP DATABASE has the same no-transaction rule as CREATE, so these stay
        // one statement per command as well.
        return [
            `DROP DATABASE IF EXISTS ${quoteIdent(grant.database)}`,
            `DROP ROLE IF EXISTS ${quoteIdent(grant.username)}`
        ].map((statement) => ({
            argv: psql(grant, "postgres", statement),
            describe: `Dropping database ${grant.database} and role ${grant.username}`
        }));
    }
    if (engine === "mysql" || engine === "mariadb") {
        const statements = [
            `DROP DATABASE IF EXISTS ${quoteBacktick(grant.database)};`,
            `DROP USER IF EXISTS ${quoteLiteral(grant.username)}@'%';`
        ];
        return [
            {
                argv: [engine === "mysql" ? "mysql" : "mariadb", `-u${grant.adminUser}`, `-p${grant.adminPassword}`, "-e", statements.join(" ")],
                describe: `Dropping database ${grant.database} and user ${grant.username}`
            }
        ];
    }
    const script = `db.getSiblingDB(${JSON.stringify(grant.database)}).dropDatabase()`;
    return [
        {
            argv: [
                "mongosh",
                "--quiet",
                "-u",
                grant.adminUser,
                "-p",
                grant.adminPassword,
                "--authenticationDatabase",
                "admin",
                "--eval",
                script
            ],
            describe: `Dropping database ${grant.database}`
        }
    ];
}
