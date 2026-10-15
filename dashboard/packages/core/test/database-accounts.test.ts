import { describe, expect, it } from "vitest";
import * as accounts from "../src/schemas/database-accounts.js";

const pg: accounts.AccountTarget = {
    engine: "postgres",
    adminUser: "app",
    adminPassword: "admin-secret-value"
};
const my: accounts.AccountTarget = {
    engine: "mysql",
    adminUser: "app",
    adminPassword: "admin-secret-value"
};
const maria: accounts.AccountTarget = { ...my, engine: "mariadb" };
const PASSWORD = "Abcdefghijklmnop_1234";

function statement(argv: readonly string[]): string {
    return argv.at(-1) ?? "";
}

describe("accounts.dbAccountCreateSchema", () => {
    it("normalizes and refuses the engine's own names", () => {
        expect(accounts.dbAccountCreateSchema.parse({ username: "  Reporting " }).username).toBe(
            "reporting"
        );
        expect(accounts.dbAccountCreateSchema.safeParse({ username: "root" }).success).toBe(false);
        expect(accounts.dbAccountCreateSchema.safeParse({ username: "pg_read" }).success).toBe(
            false
        );
        expect(accounts.dbAccountCreateSchema.safeParse({ username: "x'; DROP" }).success).toBe(
            false
        );
        expect(accounts.dbAccountCreateSchema.safeParse({ username: "1abc" }).success).toBe(false);
    });
});

describe("account commands", () => {
    it("creates a PostgreSQL role with the password as a literal and the admin password in the environment", () => {
        const command = accounts.createAccountCommand(pg, "reporting", PASSWORD);
        expect(command.argv.slice(0, 3)).toEqual(["env", "PGPASSWORD=admin-secret-value", "psql"]);
        expect(statement(command.argv)).toBe(
            `CREATE ROLE "reporting" WITH LOGIN PASSWORD '${PASSWORD}'`
        );
        expect(command.describe).not.toContain(PASSWORD);
    });

    it("creates a MySQL user at any host", () => {
        const command = accounts.createAccountCommand(my, "reporting", PASSWORD);
        expect(command.argv[0]).toBe("mysql");
        expect(statement(command.argv)).toBe(
            `CREATE USER 'reporting'@'%' IDENTIFIED BY '${PASSWORD}'; FLUSH PRIVILEGES;`
        );
        expect(accounts.createAccountCommand(maria, "reporting", PASSWORD).argv[0]).toBe("mariadb");
    });

    it("refuses a password Polaris did not generate, and names that could break out", () => {
        expect(() => accounts.createAccountCommand(pg, "reporting", "short")).toThrow();
        expect(() =>
            accounts.createAccountCommand(pg, "reporting", "abcdefghijklmnop'; DROP ROLE x; --")
        ).toThrow();
        expect(() => accounts.createAccountCommand(pg, 'bad"name', PASSWORD)).toThrow();
        expect(() => accounts.dropAccountCommand(my, "x' OR '1")).toThrow();
        expect(() => accounts.dropAccountCommand(pg, "postgres")).toThrow();
        expect(() => accounts.dropAccountCommand(my, "root")).toThrow();
        expect(() =>
            accounts.grantAccountCommands(pg, {
                username: "a",
                database: "shop`; DROP",
                privileges: "readonly"
            })
        ).toThrow();
    });

    it("drops an account", () => {
        expect(statement(accounts.dropAccountCommand(pg, "reporting").argv)).toBe(
            'DROP ROLE IF EXISTS "reporting"'
        );
        expect(statement(accounts.dropAccountCommand(my, "reporting").argv)).toBe(
            "DROP USER IF EXISTS 'reporting'@'%'; FLUSH PRIVILEGES;"
        );
    });

    it("grants on PostgreSQL in two connections: the database, then its schema", () => {
        const [onDatabase, inSchema] = accounts.grantAccountCommands(pg, {
            username: "reporting",
            database: "shop",
            privileges: "readonly"
        });
        expect(onDatabase.argv).toContain("postgres");
        expect(statement(onDatabase.argv)).toBe(
            'GRANT CONNECT, TEMPORARY ON DATABASE "shop" TO "reporting"'
        );
        expect(inSchema.argv[inSchema.argv.indexOf("-d") + 1]).toBe("shop");
        expect(statement(inSchema.argv)).toMatch(/^REVOKE ALL ON ALL TABLES/);
        expect(statement(inSchema.argv)).toContain(
            'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "reporting";'
        );
        expect(statement(inSchema.argv)).not.toContain("INSERT");
    });

    it("narrows a MySQL grant by revoking first", () => {
        const [command] = accounts.grantAccountCommands(my, {
            username: "reporting",
            database: "shop",
            privileges: "readwrite"
        });
        expect(statement(command.argv)).toBe(
            "REVOKE ALL PRIVILEGES ON `shop`.* FROM 'reporting'@'%'; GRANT SELECT, INSERT, UPDATE, DELETE ON `shop`.* TO 'reporting'@'%'; FLUSH PRIVILEGES;"
        );
    });

    it("revokes", () => {
        const pgCommands = accounts.revokeAccountCommands(pg, {
            username: "reporting",
            database: "shop"
        });
        expect(statement(pgCommands[1].argv)).toBe(
            'REVOKE ALL ON DATABASE "shop" FROM "reporting"'
        );
        const [mysqlCommand] = accounts.revokeAccountCommands(my, {
            username: "reporting",
            database: "shop"
        });
        expect(statement(mysqlCommand.argv)).toContain(
            "REVOKE ALL PRIVILEGES ON `shop`.* FROM 'reporting'@'%'"
        );
    });
});

describe("listing accounts", () => {
    it("reads PostgreSQL's unaligned output and protects superusers and the admin account", () => {
        expect(statement(accounts.listAccountsCommand(pg).argv)).toContain("FROM pg_roles");
        const listed = accounts.parseAccounts(
            "postgres",
            "app|t|app\nreporting|f|shop,web\nlonely|f|\n",
            "app"
        );
        expect(listed).toEqual([
            { username: "app", databases: ["app"], protected: true },
            { username: "reporting", databases: ["shop", "web"], protected: false },
            { username: "lonely", databases: [], protected: false }
        ]);
    });

    it("reads MySQL's tab-separated output", () => {
        expect(statement(accounts.listAccountsCommand(my).argv)).toContain("FROM mysql.user");
        expect(accounts.parseAccounts("mysql", "root\t1\t\nreporting\t0\tshop\n", "app")).toEqual([
            { username: "root", databases: [], protected: true },
            { username: "reporting", databases: ["shop"], protected: false }
        ]);
    });
});

describe("processes", () => {
    it("lists from pg_stat_activity and information_schema, bounded", () => {
        expect(statement(accounts.processListCommand(pg).argv)).toContain("pg_stat_activity");
        expect(statement(accounts.processListCommand(pg).argv)).toContain("LIMIT 50");
        expect(statement(accounts.processListCommand(my).argv)).toContain(
            "information_schema.PROCESSLIST"
        );
    });

    it("parses rows, marks its own connection, keeps a query holding the separator", () => {
        const rows = accounts.parseProcessList(
            "postgres",
            "41|app|postgres|local|active|0|1|SELECT pid\n7|web|shop|10.0.0.4|idle|93|0|SELECT a | b\nnot|a|row\n"
        );
        expect(rows).toEqual([
            {
                id: 41,
                user: "app",
                database: "postgres",
                client: "local",
                state: "active",
                seconds: 0,
                self: true,
                query: "SELECT pid"
            },
            {
                id: 7,
                user: "web",
                database: "shop",
                client: "10.0.0.4",
                state: "idle",
                seconds: 93,
                self: false,
                query: "SELECT a   b"
            }
        ]);
        expect(
            accounts.parseProcessList("mysql", "12\troot\t\tlocalhost\tQuery\t0\t1\tSELECT 1\n")[0]
        ).toMatchObject({ id: 12, self: true });
    });

    it("kills by a numeric id only", () => {
        expect(statement(accounts.killProcessCommand(pg, 7).argv)).toBe(
            "SELECT pg_terminate_backend(7)"
        );
        expect(statement(accounts.killProcessCommand(my, 7).argv)).toBe("KILL 7");
        expect(() => accounts.killProcessCommand(pg, 0)).toThrow();
        expect(() => accounts.killProcessCommand(pg, 1.5)).toThrow();
        expect(() => accounts.killProcessCommand(my, Number("7; DROP"))).toThrow();
    });
});
