/**
 * An app's own tables, migrated by the host from the SQL its bundle ships into
 * a schema of its own: applied once, only what is new on an upgrade, nothing
 * kept when one fails, and never twice when two servers install at once.
 *
 * The database is a fake that keeps what Postgres would decide here: a
 * transaction's writes are dropped when it throws, and the advisory lock holds
 * a second transaction until the first ends.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    AppMigrationFailed,
    appSchema,
    applyAppMigrations,
    migrationRefusal,
    splitStatements,
    type AppMigration,
    type MigrationDb,
    type MigrationTx
} from "@/lib/app-bundles/migrations";

function fakeDb() {
    let committed = { applied: new Map<string, string>(), ran: [] as string[] };
    let queue: Promise<unknown> = Promise.resolve();
    const db: MigrationDb = {
        transaction<T>(work: (tx: MigrationTx) => Promise<T>): Promise<T> {
            const run = async () => {
                const draft = { applied: new Map(committed.applied), ran: [...committed.ran] };
                const tx: MigrationTx = {
                    async execute(sql, ...params) {
                        if (/\bFAIL\b/.test(sql)) throw new Error("syntax error at FAIL");
                        if (sql.startsWith("INSERT INTO") && sql.includes("_polaris_migrations")) {
                            draft.applied.set(params[0] as string, params[1] as string);
                        } else if (!/^(SELECT pg_advisory|CREATE SCHEMA|CREATE TABLE IF NOT EXISTS "app_|SET LOCAL)/.test(sql)) {
                            draft.ran.push(sql);
                        }
                        return 0;
                    },
                    async query<R>() {
                        return [...draft.applied].map(([name, sha256]) => ({ name, sha256 })) as R[];
                    }
                };
                const result = await work(tx);
                committed = draft;
                return result;
            };
            // The advisory lock: one migrating transaction at a time.
            const next = queue.then(run, run);
            queue = next.catch(() => undefined);
            return next;
        }
    };
    return { db, state: () => committed };
}

const migration = (name: string, sql: string): AppMigration => ({
    name,
    sql,
    sha256: createHash("sha256").update(sql).digest("hex")
});

const first = migration("0001_orders.sql", "CREATE TABLE orders (id uuid PRIMARY KEY, total numeric NOT NULL);");
const second = migration("0002_notes.sql", "ALTER TABLE orders ADD COLUMN note text; CREATE INDEX orders_total ON orders (total);");

describe("app-owned migrations", () => {
    it("puts an app's tables in a schema of its own", () => {
        expect(appSchema("hospitality")).toBe("app_hospitality");
        expect(appSchema("status-pages")).toBe("app_status_pages");
        expect(() => appSchema('x"; DROP')).toThrow(AppMigrationFailed);
    });

    it("applies the migrations once on install, and again applies nothing", async () => {
        const { db, state } = fakeDb();
        expect(await applyAppMigrations(db, "bakery", [first])).toEqual(["0001_orders.sql"]);
        expect(await applyAppMigrations(db, "bakery", [first])).toEqual([]);
        expect(state().ran).toHaveLength(1);
    });

    it("applies only the new ones on an upgrade, in order, one statement at a time", async () => {
        const { db, state } = fakeDb();
        await applyAppMigrations(db, "bakery", [first]);
        expect(await applyAppMigrations(db, "bakery", [second, first])).toEqual(["0002_notes.sql"]);
        expect(state().ran).toEqual([
            "CREATE TABLE orders (id uuid PRIMARY KEY, total numeric NOT NULL)",
            "ALTER TABLE orders ADD COLUMN note text",
            "CREATE INDEX orders_total ON orders (total)"
        ]);
    });

    it("keeps nothing of a run that fails, and says which migration in a sentence", async () => {
        const { db, state } = fakeDb();
        await applyAppMigrations(db, "bakery", [first]);
        const broken = migration("0003_broken.sql", "CREATE TABLE fine (id int); FAIL;");
        await expect(applyAppMigrations(db, "bakery", [first, second, broken])).rejects.toThrow(
            "Its data could not be set up: 0003_broken.sql failed, and nothing of this update was kept."
        );
        expect([...state().applied.keys()]).toEqual(["0001_orders.sql"]);
        expect(state().ran).toHaveLength(1);
    });

    it("applies each migration exactly once when two servers install at the same time", async () => {
        const { db, state } = fakeDb();
        const [one, two] = await Promise.all([
            applyAppMigrations(db, "bakery", [first, second]),
            applyAppMigrations(db, "bakery", [first, second])
        ]);
        expect([...one, ...two].sort()).toEqual(["0001_orders.sql", "0002_notes.sql"]);
        expect(state().ran).toHaveLength(3);
    });

    it("stops an app whose applied migration was edited, instead of skipping it", async () => {
        const { db } = fakeDb();
        await applyAppMigrations(db, "bakery", [first]);
        const edited = migration("0001_orders.sql", "CREATE TABLE orders (id bigint);");
        await expect(applyAppMigrations(db, "bakery", [edited])).rejects.toThrow(/changed after it was applied/);
    });

    it("refuses what is not additive or reaches outside the app's schema, before anything runs", async () => {
        expect(migrationRefusal("bakery", "DROP TABLE orders;")).toMatch(/drops/);
        expect(migrationRefusal("bakery", "TRUNCATE orders;")).toMatch(/empties/);
        expect(migrationRefusal("bakery", "ALTER TABLE orders RENAME TO o;")).toMatch(/renames/);
        expect(migrationRefusal("bakery", "DELETE FROM orders;")).toMatch(/WHERE/);
        expect(migrationRefusal("bakery", "INSERT INTO public.users (id) VALUES (1);")).toMatch(/"public"/);
        expect(migrationRefusal("bakery", 'UPDATE "app_crm".deals SET x = 1 WHERE true;')).toMatch(/"app_crm"/);
        expect(migrationRefusal("bakery", "SET search_path TO public;")).toMatch(/search path/);
        expect(migrationRefusal("bakery", "GRANT ALL ON orders TO PUBLIC;")).toMatch(/grants/);
        expect(migrationRefusal("bakery", "CREATE TABLE app_bakery.extra (id int); -- DROP is only a comment")).toBeNull();
        expect(migrationRefusal("bakery", "INSERT INTO orders (note) VALUES ('please drop by');")).toBeNull();
        const { db, state } = fakeDb();
        await expect(applyAppMigrations(db, "bakery", [migration("0001_x.sql", "DROP TABLE orders;")])).rejects.toThrow(/refused/);
        expect(state().ran).toHaveLength(0);
    });

    it("splits on the semicolons that end statements, not those in quotes or bodies", () => {
        expect(
            splitStatements(
                "CREATE TABLE a (n text DEFAULT 'a;b'); -- c;d\nCREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;"
            )
        ).toEqual(["CREATE TABLE a (n text DEFAULT 'a;b')", "-- c;d\nCREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql"]);
    });
});
