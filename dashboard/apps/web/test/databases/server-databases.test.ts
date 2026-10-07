/**
 * Every database on a Postgres server, from one connection.
 *
 * A Postgres connection is bound to one database, so the browser lists the
 * server's others (`pg_database`) and opens the one picked with the same login,
 * the same encryption and the same SSH route. What is pinned here is the part
 * that decides whether that is safe: a name from the browser is dialled only
 * after the server listed it for this account, Polaris' own database lists only
 * itself, an account that may not read the catalogue falls back to the database
 * it is in, and everything after the switch - rows, statements, edits - lands on
 * the database that was picked. A real engine is not available here, so the
 * engine is a fake that records which database each connection was opened on.
 */

import { NO_TLS } from "@/lib/data/tls";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The database each connection was opened on, in order. */
const opened: (string | undefined)[] = [];
/** Statements sent, with the database they were sent to. */
const sent: { database: string | undefined; text: string }[] = [];
/** What `pg_database` holds for this account, or null when reading it is refused. */
let listed: string[] | null = ["analytics", "app", "billing"];

const tunnel = vi.hoisted(() => ({
    opens: 0,
    closes: 0
}));

vi.mock("pg", async () => {
    const { EventEmitter } = await import("node:events");
    class Query extends EventEmitter {
        constructor(readonly config: { text: string }) {
            super();
        }
    }
    class Client {
        private readonly database: string | undefined;
        constructor(config: { database?: string }) {
            this.database = config.database;
        }
        async connect() {
            opened.push(this.database);
        }
        async end() {}
        query(query: string | Query | { text: string }, _params?: unknown[]) {
            if (query instanceof Query) {
                sent.push({ database: this.database, text: query.config.text });
                queueMicrotask(() => {
                    query.emit("row", [this.database]);
                    query.emit("end", { fields: [{ name: "db" }], rowCount: 1 });
                });
                return query;
            }
            const text = typeof query === "string" ? query : query.text;
            sent.push({ database: this.database, text });
            return Promise.resolve(this.answer(text));
        }
        private answer(text: string) {
            if (text.includes("FROM pg_database")) {
                if (listed === null) throw new Error("permission denied for table pg_database");
                return { rows: listed.map((name) => ({ name })) };
            }
            if (text.includes("current_database()")) return { rows: [{ name: this.database }] };
            if (text.includes("FROM pg_namespace")) return { rows: [{ name: "public", count: "1" }] };
            if (text.includes("FROM pg_attribute")) {
                return { rows: [{ name: "id", type: "integer", nullable: "NO", pk: true }] };
            }
            if (text.includes("FROM pg_class")) {
                return { rows: [{ name: `t_${this.database}`, kind: "table", rows: "5" }] };
            }
            if (text.startsWith("UPDATE")) return { rows: [], rowCount: 1 };
            return { rows: [{ id: 1, from: this.database }], fields: [] };
        }
    }
    return { Client, Query };
});

vi.mock("@/lib/data/tunnel", () => ({
    TunnelError: class TunnelError extends Error {},
    openTunnel: async () => {
        tunnel.opens += 1;
        return {
            host: "127.0.0.1",
            port: 40_000,
            close: () => {
                tunnel.closes += 1;
            }
        };
    }
}));

// `browser.ts` resolves connection ids through this; the tests here hand it
// addresses directly, so nothing behind it is reached.
vi.mock("@/lib/data/connections", () => ({ addressOf: vi.fn() }));

const { PostgresDriver } = await import("@/lib/data/drivers/postgres");
const { withDriverOn } = await import("@/lib/data/open");
const browser = await import("@/lib/data/browser");
const { DataRequestError, NO_SUCH_DATABASE } = await import("@/lib/data/driver");
const { databaseChoiceSchema } = await import("@/lib/data/connection-schema");

type Address = Parameters<typeof browser.browseAt>[0];

function address(overrides: Partial<Address> = {}): Address {
    return {
        engine: "postgres",
        host: "db.example.test",
        port: 5432,
        database: "app",
        username: "reader",
        password: "fixture-password",
        tls: NO_TLS,
        readOnly: false,
        ...overrides
    };
}

beforeEach(() => {
    opened.length = 0;
    sent.length = 0;
    listed = ["analytics", "app", "billing"];
    tunnel.opens = 0;
    tunnel.closes = 0;
});

describe("listing the server's databases", () => {
    it("asks pg_database for what this account can connect to, without templates", async () => {
        const driver = new PostgresDriver(address());
        expect(await driver.databases()).toEqual(["analytics", "app", "billing"]);

        const query = sent.find((entry) => entry.text.includes("FROM pg_database"))?.text ?? "";
        expect(query).toContain("NOT datistemplate");
        expect(query).toContain("datallowconn");
        expect(query).toContain("has_database_privilege(datname, 'CONNECT')");
        // The open one is kept whatever its flags say.
        expect(query).toContain("datname = current_database()");
        await driver.close();
    });

    it("falls back to the database it is in when the catalogue is refused", async () => {
        listed = null;
        const driver = new PostgresDriver(address());
        expect(await driver.databases()).toEqual(["app"]);
        await driver.close();
    });

    it("returns the list with a browse, the configured database selected", async () => {
        const result = await browser.browseAt(address(), null);
        expect(result.databases).toEqual(["analytics", "app", "billing"]);
        expect(result.database).toBe("app");
        expect(result.relations.map((entry) => entry.name)).toEqual(["t_app"]);
        expect(opened).toEqual(["app"]);
    });

    it("lists only the configured database when the account cannot read pg_database", async () => {
        listed = null;
        const result = await browser.browseAt(address(), null);
        expect(result.databases).toEqual(["app"]);
        expect(result.database).toBe("app");
    });

    it("keeps a confined connection - Polaris' own - to its one database", async () => {
        const result = await browser.browseAt(address({ confined: true, readOnly: true }), null);
        expect(result.databases).toEqual(["app"]);
        // Not even asked: the list is not this connection's to show.
        expect(sent.some((entry) => entry.text.includes("FROM pg_database"))).toBe(false);
    });
});

describe("switching to another database", () => {
    it("opens the picked database after the server listed it, and browses that one", async () => {
        const result = await browser.browseAt(address(), null, "billing");

        // First the configured database, to list; then the picked one.
        expect(opened).toEqual(["app", "billing"]);
        expect(result.database).toBe("billing");
        expect(result.relations.map((entry) => entry.name)).toEqual(["t_billing"]);
        expect(result.databases).toEqual(["analytics", "app", "billing"]);
    });

    it("refuses a name the server did not list, before dialling it", async () => {
        await expect(browser.browseAt(address(), null, "secret_db")).rejects.toThrow(
            NO_SUCH_DATABASE
        );
        await expect(browser.runAt(address(), "SELECT 1", "secret_db")).rejects.toBeInstanceOf(
            DataRequestError
        );
        expect(opened.every((database) => database === "app")).toBe(true);
    });

    it("refuses another database on a confined connection even when the server has it", async () => {
        await expect(
            browser.browseAt(address({ confined: true, readOnly: true }), null, "billing")
        ).rejects.toThrow(NO_SUCH_DATABASE);
        expect(opened).not.toContain("billing");
    });

    it("refuses a database the account cannot connect to (not listed)", async () => {
        // has_database_privilege filtered it out of what pg_database answered.
        listed = ["app"];
        await expect(browser.browseAt(address(), null, "billing")).rejects.toThrow(
            NO_SUCH_DATABASE
        );
        expect(opened).not.toContain("billing");
    });

    it("treats the configured database by name as no switch at all", async () => {
        await browser.browseAt(address(), null, "app");
        expect(opened).toEqual(["app"]);
    });

    it("sends rows, statements and edits to the picked database", async () => {
        const page = await browser.rowsAt(address(), "public", "t_billing", { limit: 10 }, "billing");
        expect(page.rows).toEqual([{ id: 1, from: "billing" }]);

        sent.length = 0;
        const [result] = await browser.runAt(address(), "SELECT current_database()", "billing");
        expect(result?.rows).toEqual([["billing"]]);

        sent.length = 0;
        // The key column is not editable from the grid, so the cell rule refuses
        // it - after reading the picked database's own catalogue to know that.
        await expect(
            browser.updateCellAt(
                address(),
                { namespace: "public", relation: "t_billing", column: "id", value: "2", key: { id: 1 } },
                "billing"
            )
        ).rejects.toThrow(/primary key/);
        expect(sent.some((entry) => entry.database === "billing")).toBe(true);
    });

    it("keeps the read-only flag on the picked database", async () => {
        await expect(
            browser.runAt(address({ readOnly: true }), "DELETE FROM t_billing", "billing")
        ).rejects.toThrow(/read-only/);
        // Refused before the picked database was even reached.
        expect(opened).not.toContain("billing");

        sent.length = 0;
        await browser.runAt(address({ readOnly: true }), "SELECT 1", "billing");
        const onBilling = sent.filter((entry) => entry.database === "billing").map((e) => e.text);
        expect(onBilling).toContain("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
        expect(onBilling).toContain("BEGIN TRANSACTION READ ONLY");
    });

    it("goes through one SSH tunnel for the listing and the picked database", async () => {
        const tunnelled = address({
            tunnel: { target: {} as never, jump: null, label: "jump" }
        });
        const result = await browser.browseAt(tunnelled, null, "analytics");

        expect(result.database).toBe("analytics");
        expect(opened).toEqual(["app", "analytics"]);
        expect(tunnel.opens).toBe(1);
        expect(tunnel.closes).toBe(1);
    });

    it("closes the tunnel when the name is refused", async () => {
        const tunnelled = address({ tunnel: { target: {} as never, jump: null, label: "jump" } });
        await expect(withDriverOn(tunnelled, "nope", async () => 1)).rejects.toThrow(
            NO_SUCH_DATABASE
        );
        expect(tunnel.closes).toBe(tunnel.opens);
    });
});

describe("the database a browser asks for", () => {
    it("is the connection's own when absent or null", () => {
        expect(databaseChoiceSchema.parse(undefined)).toBeNull();
        expect(databaseChoiceSchema.parse(null)).toBeNull();
        expect(databaseChoiceSchema.parse("billing")).toBe("billing");
    });

    it("refuses what cannot be a database name", () => {
        for (const bad of ["", "x".repeat(129), "bad\u0000name", "line\nbreak", 42, {}]) {
            expect(databaseChoiceSchema.safeParse(bad).success).toBe(false);
        }
    });
});
