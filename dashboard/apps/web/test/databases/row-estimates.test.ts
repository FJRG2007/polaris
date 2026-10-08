/**
 * How many rows a table in the list is said to hold.
 *
 * Postgres keeps two figures and neither is a count: the statistics system's
 * live tuples, moved on every write, and the planner's `reltuples`, moved only
 * by ANALYZE. The list showed the planner's, so a table that grew since its last
 * analyse read "2" with thousands of rows in it. These are the fixture rows of
 * both sources and the figure each one becomes.
 */

import { NO_TLS } from "@/lib/data/tls";
import { describe, expect, it, vi } from "vitest";

let catalogue: { name: string; relkind: string; live: string | null; planned: string | null }[] =
    [];
const sent: string[] = [];

vi.mock("pg", () => {
    class Client {
        on() {
            return this;
        }
        async connect() {}
        async end() {}
        async query(text: string) {
            sent.push(text);
            return { rows: catalogue };
        }
    }
    return { Client, Query: class {} };
});

const { PostgresDriver, rowEstimate } = await import("@/lib/data/drivers/postgres");

describe("which figure a table's size comes from", () => {
    it("prefers the live count over a planner figure that went stale", () => {
        // ANALYZE saw 2 rows; thousands were inserted since.
        expect(rowEstimate("4812", "2")).toBe(4812);
    });

    it("falls back to the planner when the statistics were reset", () => {
        expect(rowEstimate("0", "1500")).toBe(1500);
        expect(rowEstimate(null, "1500")).toBe(1500);
    });

    it("says 0 for a table that is empty by both", () => {
        expect(rowEstimate("0", "0")).toBe(0);
        expect(rowEstimate("0", "-1")).toBe(0);
    });

    it("says nothing rather than -1 for a table never analysed and never counted", () => {
        expect(rowEstimate(null, "-1")).toBeNull();
        expect(rowEstimate(null, null)).toBeNull();
    });
});

describe("the list as the driver reads it", () => {
    it("reads both sources and draws a plain view with no figure", async () => {
        catalogue = [
            { name: "entity_documents", relkind: "r", live: "4812", planned: "2" },
            { name: "audit", relkind: "p", live: "0", planned: "-1" },
            { name: "recent", relkind: "v", live: null, planned: "-1" },
            { name: "rollup", relkind: "m", live: "30", planned: "28" },
            { name: "remote", relkind: "f", live: null, planned: "900" }
        ];
        const driver = new PostgresDriver({
            engine: "postgres",
            host: "db.internal",
            port: 5432,
            database: "app",
            tls: NO_TLS,
            readOnly: true
        });

        const listed = await driver.relations("public");

        expect(listed.map((entry) => [entry.name, entry.kind, entry.rows])).toEqual([
            ["entity_documents", "table", 4812],
            ["audit", "table", 0],
            ["recent", "view", null],
            ["rollup", "view", 30],
            ["remote", "table", 900]
        ]);
        const query = sent.find((text) => text.includes("pg_stat_all_tables")) ?? "";
        expect(query).toContain("n_live_tup");
        expect(query).toContain("reltuples");
        await driver.close();
    });
});
