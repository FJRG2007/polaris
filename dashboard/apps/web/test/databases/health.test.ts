/**
 * The Stats report, read from canned catalogue answers rather than a database.
 *
 * Asserted: each figure lands where the screen reads it, every list is bounded,
 * a statement the account may not run (the WAL directory, pg_stat_statements)
 * is a missing figure and not a failed report, and reports are kept for the TTL
 * and shared by callers that ask at once.
 */

import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/lib/data/driver";
import {
    HEALTH_TTL_MS,
    LIST_LIMIT,
    cachedHealth,
    forgetHealth,
    mysqlHealth,
    postgresHealth,
    redisHealthFromInfo,
    type HealthReport,
    type Run
} from "@/lib/data/health";

function result(columns: string[], rows: unknown[][]): QueryResult[] {
    return [{ statement: "", columns, rows, affected: null, ms: 1 }];
}

/** A Run that answers by the first pattern a statement matches, and records what it was asked. */
function fake(answers: [RegExp, QueryResult[] | Error][]): Run & { asked: string[] } {
    const asked: string[] = [];
    const run = (async (statement: string) => {
        asked.push(statement);
        for (const [pattern, answer] of answers) {
            if (pattern.test(statement)) {
                if (answer instanceof Error) throw answer;
                return answer;
            }
        }
        return result([], []);
    }) as Run & { asked: string[] };
    run.asked = asked;
    return run;
}

describe("PostgreSQL", () => {
    const answers: [RegExp, QueryResult[] | Error][] = [
        [
            /FROM pg_stat_activity/,
            result(["max", "used", "active", "idle", "idle_tx"], [[100, "12", "3", "8", "1"]])
        ],
        [/blks_hit/, result(["ratio"], [[0.987]])],
        [
            /pg_database_size/,
            result(["database", "tables", "indexes", "system"], [["1000", "600", "200", "50"]])
        ],
        [/pg_ls_waldir/, new Error("permission denied for function pg_ls_waldir")],
        [
            /FROM pg_stat_user_tables s JOIN/,
            result(
                [
                    "schemaname",
                    "relname",
                    "rows",
                    "data",
                    "indexes",
                    "seq_scan",
                    "idx_scan",
                    "n_dead_tup",
                    "n_live_tup",
                    "last_vacuum",
                    "last_autovacuum",
                    "xid_age"
                ],
                [
                    [
                        "public",
                        "orders",
                        "900",
                        "500",
                        "100",
                        "4",
                        "40",
                        "100",
                        "900",
                        null,
                        new Date("2026-10-01T00:00:00Z"),
                        "1234"
                    ]
                ]
            )
        ],
        [/count\(\*\) AS total FROM pg_stat_user_tables/, result(["total"], [["73"]])],
        [/datfrozenxid/, result(["age", "freeze_max"], [["250000000", "200000000"]])],
        [
            /pg_stat_user_indexes/,
            result(
                ["schemaname", "relname", "indexrelname", "bytes", "idx_scan"],
                [["public", "orders", "orders_note_idx", "8192", "0"]]
            )
        ],
        [
            /pg_available_extensions WHERE name = 'pg_stat_statements'/,
            result(
                ["available", "installed", "preload", "version"],
                [[true, true, "pg_stat_statements", "16.4"]]
            )
        ],
        [
            /total_exec_time/,
            result(
                ["query", "calls", "rows", "total", "mean", "max"],
                [["SELECT 1", "10", "10", "5.5", "0.55", "2"]]
            )
        ]
    ];

    it("reads every section, bounded, and names the WAL as missing rather than failing", async () => {
        const run = fake(answers);
        const report = await postgresHealth(run);
        expect(report.connections).toEqual({
            used: 12,
            max: 100,
            active: 3,
            idle: 8,
            idleInTransaction: 1
        });
        expect(report.cacheHitRatio).toBeCloseTo(0.987);
        expect(report.sizes.map((part) => part.key)).toEqual([
            "database",
            "tables",
            "indexes",
            "system",
            "other"
        ]);
        expect(report.sizes.find((part) => part.key === "other")?.bytes).toBe(150);
        expect(report.tables[0]).toMatchObject({
            name: "orders",
            deadRows: 100,
            deadPercent: 10,
            xidAge: 1234
        });
        expect(report.tables[0]?.lastAutovacuum).toBe("2026-10-01T00:00:00.000Z");
        expect(report.tablesTotal).toBe(73);
        expect(report.vacuum).toEqual({
            databaseXidAge: 250000000,
            freezeMaxAge: 200000000,
            freezeRisk: true
        });
        expect(report.unusedIndexes).toEqual([
            { schema: "public", table: "orders", name: "orders_note_idx", bytes: 8192, scans: 0 }
        ]);
        expect(report.queries).toMatchObject({ available: true, installed: true, preloaded: true });
        expect(report.queries?.rows[0]).toMatchObject({
            statement: "SELECT 1",
            calls: 10,
            meanMs: 0.55
        });
        for (const statement of run.asked.filter((entry) => /ORDER BY/.test(entry))) {
            expect(statement).toContain(`LIMIT ${LIST_LIMIT}`);
        }
        expect(run.asked.every((statement) => !/count\(\*\) FROM "/.test(statement))).toBe(true);
    });

    it("asks for no statement statistics until the library is loaded", async () => {
        const run = fake([
            [
                /pg_available_extensions WHERE name = 'pg_stat_statements'/,
                result(
                    ["available", "installed", "preload", "version"],
                    [[true, false, "", "16.4"]]
                )
            ],
            ...answers
        ]);
        const report = await postgresHealth(run);
        expect(report.queries).toEqual({
            available: true,
            installed: false,
            preloaded: false,
            rows: []
        });
        expect(run.asked.some((statement) => /FROM pg_stat_statements/.test(statement))).toBe(
            false
        );
    });
});

describe("MySQL", () => {
    it("reads status, sizes, keyless tables and the digest, and survives a missing sys schema", async () => {
        const report = await mysqlHealth(
            fake([
                [
                    /SHOW GLOBAL STATUS/,
                    result(
                        ["Variable_name", "Value"],
                        [
                            ["Threads_connected", "5"],
                            ["Threads_running", "2"],
                            ["Innodb_buffer_pool_read_requests", "1000"],
                            ["Innodb_buffer_pool_reads", "10"],
                            ["Uptime", "7200"]
                        ]
                    )
                ],
                [
                    /SHOW GLOBAL VARIABLES/,
                    result(
                        ["Variable_name", "Value"],
                        [
                            ["max_connections", "151"],
                            ["version", "8.0.39"]
                        ]
                    )
                ],
                [
                    /TABLE_NAME, TABLE_ROWS/,
                    result(
                        ["TABLE_NAME", "TABLE_ROWS", "DATA_LENGTH", "INDEX_LENGTH", "DATA_FREE"],
                        [["orders", "50", "16384", "0", "4096"]]
                    )
                ],
                [
                    /COUNT\(\*\) AS total, COALESCE/,
                    result(["total", "data", "indexes"], [["1", "16384", "0"]])
                ],
                [/CONSTRAINT_TYPE = 'PRIMARY KEY'/, result(["total"], [["1"]])],
                [
                    /sys\.schema_unused_indexes/,
                    new Error("Table 'sys.schema_unused_indexes' doesn't exist")
                ],
                [/events_statements_summary_by_digest/, new Error("performance_schema off")]
            ]),
            "mysql"
        );
        expect(report.connections).toMatchObject({ used: 5, max: 151, active: 2 });
        expect(report.cacheHitRatio).toBeCloseTo(0.99);
        expect(report.tables[0]).toMatchObject({ name: "orders", rows: 50, freeBytes: 4096 });
        expect(report.unusedIndexes).toBeNull();
        expect(report.queries).toEqual({
            available: false,
            installed: false,
            preloaded: false,
            rows: []
        });
        expect(report.facts).toContainEqual({ key: "tablesWithoutKey", value: 1, unit: "count" });
    });
});

describe("Redis", () => {
    it("reads INFO into connections, hit ratio, memory and keys", () => {
        const report = redisHealthFromInfo(
            [
                "redis_version:7.2.4",
                "uptime_in_seconds:3600",
                "connected_clients:4",
                "maxclients:10000",
                "used_memory:2048",
                "maxmemory:0",
                "keyspace_hits:90",
                "keyspace_misses:10",
                "evicted_keys:0",
                "expired_keys:3",
                "aof_enabled:0",
                "rdb_changes_since_last_save:2",
                "db0:keys=5,expires=0,avg_ttl=0",
                "db1:keys=2,expires=0,avg_ttl=0"
            ].join("\r\n")
        );
        expect(report.connections).toMatchObject({ used: 4, max: 10000 });
        expect(report.cacheHitRatio).toBeCloseTo(0.9);
        expect(report.sizes).toEqual([{ key: "memory", bytes: 2048 }]);
        expect(report.facts).toContainEqual({ key: "keys", value: 7, unit: "count" });
        expect(report.facts).toContainEqual({ key: "persistence", value: "rdb" });
    });
});

describe("the report cache", () => {
    it("shares one read inside the TTL, reads again after it, and forgets on request", async () => {
        const report = { engine: "postgres" } as HealthReport;
        const read = vi.fn(async () => report);
        const key = "db-cache-test";
        const now = 1_000_000;
        await cachedHealth(key, read, now);
        await cachedHealth(key, read, now + HEALTH_TTL_MS - 1);
        expect(read).toHaveBeenCalledTimes(1);
        await cachedHealth(key, read, now + HEALTH_TTL_MS + 1);
        expect(read).toHaveBeenCalledTimes(2);
        forgetHealth(key);
        await cachedHealth(key, read, now + HEALTH_TTL_MS + 2);
        expect(read).toHaveBeenCalledTimes(3);
    });

    it("does not keep a failed read", async () => {
        const key = "db-cache-failure";
        const failing = vi.fn(async () => {
            throw new Error("down");
        });
        await expect(cachedHealth(key, failing, 5)).rejects.toThrow("down");
        await Promise.resolve();
        const ok = vi.fn(async () => ({ engine: "redis" }) as HealthReport);
        await cachedHealth(key, ok, 6);
        expect(ok).toHaveBeenCalledTimes(1);
    });
});
