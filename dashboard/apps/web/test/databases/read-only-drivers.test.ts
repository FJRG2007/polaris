/**
 * Read-only is the database's to enforce, not the keyword gate's.
 *
 * What is pinned here is the conversation each driver has with its engine: a
 * typed statement on a read-only connection goes inside a read-only transaction
 * whose mode is already fixed, one statement at a time through a protocol that
 * takes exactly one, and is rolled back after. The engine then refuses whatever
 * the gate missed. A real engine is not available here, so the engines are
 * fakes that record what they were sent - which is the part this code decides.
 */

import { NO_TLS } from "@/lib/data/tls";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { text: string; extended: boolean }[] = [];
let rowsToReturn = 3;

vi.mock("pg", async () => {
    const { EventEmitter } = await import("node:events");
    class Query extends EventEmitter {
        constructor(readonly config: { text: string; queryMode?: string }) {
            super();
        }
    }
    class Client {
        async connect() {}
        async end() {}
        query(query: string | Query) {
            if (typeof query === "string") {
                sent.push({ text: query, extended: false });
                return Promise.resolve({ rows: [], fields: [] });
            }
            sent.push({ text: query.config.text, extended: query.config.queryMode === "extended" });
            queueMicrotask(() => {
                for (let index = 0; index < rowsToReturn; index += 1) query.emit("row", [index]);
                query.emit("end", { fields: [{ name: "n" }], rowCount: rowsToReturn });
            });
            return query;
        }
    }
    return { Client, Query };
});

const { PostgresDriver } = await import("@/lib/data/drivers/postgres");
const { writesThroughStage } = await import("@/lib/data/drivers/mongo");
const { MAX_STATEMENT_ROWS, ReadOnlyError } = await import("@/lib/data/driver");

const address = {
    engine: "postgres" as const,
    host: "127.0.0.1",
    port: 5432,
    tls: NO_TLS,
    readOnly: true
};

beforeEach(() => {
    sent.length = 0;
    rowsToReturn = 3;
});

describe("PostgreSQL, read-only", () => {
    it("runs a statement inside a read-only transaction whose mode is already fixed", async () => {
        const driver = new PostgresDriver(address);
        await driver.run("SELECT * FROM users");
        expect(sent.map((entry) => entry.text)).toEqual([
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
            "BEGIN TRANSACTION READ ONLY",
            // After this, SET TRANSACTION READ WRITE is refused by Postgres.
            "SELECT 1",
            "SELECT * FROM users",
            "ROLLBACK"
        ]);
    });

    it("sends the typed statement through the extended protocol, which takes one", async () => {
        const driver = new PostgresDriver(address);
        await driver.run("SELECT 1; SELECT 2");
        const typed = sent.filter((entry) => entry.text === "SELECT 2" || entry.extended);
        expect(typed.every((entry) => entry.extended)).toBe(true);
        expect(sent.filter((entry) => entry.text === "ROLLBACK")).toHaveLength(2);
    });

    it("refuses before anything is sent when the gate sees the write", async () => {
        const driver = new PostgresDriver(address);
        for (const statement of [
            "SET TRANSACTION READ WRITE",
            "COMMIT; DROP TABLE users",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "COPY users TO PROGRAM 'id'",
            "SELECT 1 # 1; DROP TABLE users",
            "SELECT pg_terminate_backend(1)"
        ]) {
            await expect(driver.run(statement), statement).rejects.toBeInstanceOf(ReadOnlyError);
        }
        expect(sent).toHaveLength(0);
    });
});

describe("PostgreSQL, any mode", () => {
    it("keeps at most the row ceiling of a result and says it was cut", async () => {
        rowsToReturn = MAX_STATEMENT_ROWS + 5;
        const driver = new PostgresDriver({ ...address, readOnly: false });
        const [result] = await driver.run("SELECT n FROM big");
        expect(result?.rows).toHaveLength(MAX_STATEMENT_ROWS);
        expect(result?.note).toBe(`Showing the first ${MAX_STATEMENT_ROWS} rows.`);
    });
});

describe("MongoDB aggregation stages", () => {
    it("treats $out and $merge as writes, however deep", () => {
        expect(writesThroughStage({ aggregate: "users", pipeline: [{ $match: {} }, { $out: "copy" }] })).toBe(true);
        expect(
            writesThroughStage({ explain: { aggregate: "u", pipeline: [{ $facet: { a: [{ $merge: "x" }] } }] } })
        ).toBe(true);
        expect(writesThroughStage({ find: "users", filter: { active: true } })).toBe(false);
    });
});
