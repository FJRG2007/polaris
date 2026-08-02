import { describe, expect, it } from "vitest";
import {
    createDatabaseCommands,
    databaseCreateSchema,
    dbEngineLabel,
    dropDatabaseCommands,
    type DatabaseGrant
} from "../src/index.js";

const grant: DatabaseGrant = {
    database: "shop",
    username: "shop_app",
    password: "aVeryLongPassword1",
    privileges: "owner",
    adminUser: "polaris",
    adminPassword: "adminSecret1"
};

describe("engine catalog", () => {
    it("names each engine the way the project names itself", () => {
        expect(dbEngineLabel("postgres")).toBe("PostgreSQL");
        expect(dbEngineLabel("mysql")).toBe("MySQL");
        expect(dbEngineLabel("mongo")).toBe("MongoDB");
        // An engine written by a newer version still renders as something.
        expect(dbEngineLabel("cockroach")).toBe("cockroach");
    });
});

describe("databaseCreateSchema", () => {
    const base = { environmentId: "0192f0a0-0000-7000-8000-000000000000", name: "Shop", engine: "postgres" as const };

    it("accepts the plain case and defaults the privileges to owner", () => {
        const parsed = databaseCreateSchema.parse(base);
        expect(parsed.privileges).toBe("owner");
    });

    it("refuses an identifier that could carry SQL", () => {
        for (const username of ['a"b', "a;DROP", "a b", "1abc", "a-b"]) {
            expect(databaseCreateSchema.safeParse({ ...base, username }).success).toBe(false);
        }
        expect(databaseCreateSchema.safeParse({ ...base, username: "shop_app2" }).success).toBe(true);
    });

    it("refuses a password carrying a quote or a backslash", () => {
        expect(databaseCreateSchema.safeParse({ ...base, password: "abcdefghijkl'x" }).success).toBe(false);
        expect(databaseCreateSchema.safeParse({ ...base, password: "abcdefghijkl\\x" }).success).toBe(false);
        expect(databaseCreateSchema.safeParse({ ...base, password: "abcdefghijklX1" }).success).toBe(true);
        // Too short to be worth having.
        expect(databaseCreateSchema.safeParse({ ...base, password: "short1" }).success).toBe(false);
    });

    it("refuses a version the engine does not publish", () => {
        expect(databaseCreateSchema.safeParse({ ...base, version: "16" }).success).toBe(true);
        expect(databaseCreateSchema.safeParse({ ...base, version: "9" }).success).toBe(false);
    });

    it("refuses sharing an instance of an engine that holds one dataset", () => {
        const instanceId = "0192f0a0-0000-7000-8000-000000000001";
        expect(databaseCreateSchema.safeParse({ ...base, instanceId }).success).toBe(true);
        expect(databaseCreateSchema.safeParse({ ...base, engine: "redis", instanceId }).success).toBe(false);
    });

    it("refuses settings that belong to the instance, not to a database on it", () => {
        const instanceId = "0192f0a0-0000-7000-8000-000000000001";
        expect(databaseCreateSchema.safeParse({ ...base, instanceId, exposePort: 5433 }).success).toBe(false);
        expect(databaseCreateSchema.safeParse({ ...base, instanceId, version: "16" }).success).toBe(false);
    });

    it("keeps a database off the ports the host's own services claim", () => {
        expect(databaseCreateSchema.safeParse({ ...base, exposePort: 80 }).success).toBe(false);
        expect(databaseCreateSchema.safeParse({ ...base, exposePort: 5433 }).success).toBe(true);
    });
});

describe("createDatabaseCommands", () => {
    it("creates the database owned by its user on PostgreSQL", () => {
        const commands = createDatabaseCommands("postgres", grant);
        const statements = commands.map((command) => command.argv.at(-1) ?? "");
        expect(statements[0]).toBe('CREATE ROLE "shop_app" WITH LOGIN PASSWORD \'aVeryLongPassword1\'');
        expect(statements[1]).toBe('CREATE DATABASE "shop" OWNER "shop_app"');
        // Owner needs no grants pass; that only exists for the lesser roles.
        expect(commands).toHaveLength(3);
    });

    /**
     * PostgreSQL refuses CREATE/DROP DATABASE inside a transaction, and `psql -c`
     * runs whatever it is given as one. Batching them therefore fails against a
     * real server while looking perfectly valid on paper.
     */
    it("keeps each PostgreSQL statement in its own command", () => {
        for (const command of [
            ...createDatabaseCommands("postgres", grant),
            ...dropDatabaseCommands("postgres", grant)
        ]) {
            const statement = command.argv.at(-1) ?? "";
            if (!/\b(CREATE|DROP) DATABASE\b/.test(statement)) continue;
            expect(statement).not.toContain(";");
        }
    });

    it("grants inside the new database for anything short of ownership", () => {
        const readonly = createDatabaseCommands("postgres", { ...grant, privileges: "readonly" });
        const grants = readonly.at(-1);
        expect(grants?.argv).toContain("shop");
        const sql = grants?.argv.at(-1) ?? "";
        expect(sql).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA public TO "shop_app";');
        expect(sql).not.toContain("INSERT");
    });

    it("scopes the grant to the one database on MySQL", () => {
        const [command] = createDatabaseCommands("mysql", { ...grant, privileges: "readwrite" });
        const sql = command?.argv.at(-1) ?? "";
        expect(sql).toContain("CREATE DATABASE IF NOT EXISTS `shop`;");
        expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON `shop`.* TO 'shop_app'@'%';");
    });

    it("gives the Mongo user a role on its own database only", () => {
        const [command] = createDatabaseCommands("mongo", { ...grant, privileges: "readwrite" });
        const script = command?.argv.at(-1) ?? "";
        expect(script).toContain('db.getSiblingDB("shop")');
        expect(script).toContain('role: "readWrite"');
    });

    it("has nothing to run for an engine that holds one dataset", () => {
        expect(createDatabaseCommands("redis", grant)).toEqual([]);
        expect(dropDatabaseCommands("redis", grant)).toEqual([]);
    });

    it("drops both the database and the account it was reached with", () => {
        const statements = dropDatabaseCommands("postgres", grant).map((command) => command.argv.at(-1) ?? "");
        expect(statements).toContain('DROP DATABASE IF EXISTS "shop"');
        expect(statements).toContain('DROP ROLE IF EXISTS "shop_app"');
    });
});
