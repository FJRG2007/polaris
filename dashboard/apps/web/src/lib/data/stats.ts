/**
 * What a database is doing right now, in the terms that engine keeps.
 *
 * One reading per call, taken from the engine's own counters - `INFO` on Redis,
 * `pg_stat_database` on PostgreSQL, `SHOW GLOBAL STATUS` on MySQL,
 * `serverStatus` on MongoDB. Nothing is stored: the screen keeps the readings it
 * has taken and draws the window it is looking at, which is how the rest of
 * Polaris draws a live figure and is the right trade here too. A table of samples
 * would mean a background job holding a connection open to every database
 * somebody has ever added, forever, for charts nobody is looking at.
 *
 * Two kinds of number, because they are read differently. A **gauge** is true as
 * it stands - connections, memory, keys. A **counter** only goes up, and the
 * interesting thing about it is the difference between two readings: commands
 * served, cache hits, rows written. The screen turns counters into rates; this
 * only reports what the engine said, so a restart shows up as a counter going
 * backwards rather than as a spike nobody can explain.
 */

import { withDriver } from "./open";
import { addressOf } from "./connections";
import type { DataAddress } from "./driver";

/** One number, named for a chart. */
export interface StatValue {
    readonly key: string;
    readonly label: string;
    readonly value: number;
    /** How to draw it: a plain count, bytes, or a percentage. */
    readonly unit: "count" | "bytes" | "percent" | "ms";
}

export interface DatabaseStats {
    /** When the reading was taken, by the server's clock. */
    readonly at: number;
    readonly engine: string;
    /** True as it stands. */
    readonly gauges: readonly StatValue[];
    /** Only goes up. The screen draws the difference between two of these. */
    readonly counters: readonly StatValue[];
}

export async function engineStats(userId: string, connectionId: string): Promise<DatabaseStats> {
    const address = await addressOf(userId, connectionId);
    switch (address.engine) {
        case "redis":
            return redisStats(address);
        case "postgres":
            return postgresStats(address);
        case "mysql":
        case "mariadb":
            return mysqlStats(address);
        case "mongo":
            return mongoStats(address);
        default:
            return { at: Date.now(), engine: address.engine, gauges: [], counters: [] };
    }
}

function gauge(key: string, label: string, value: number, unit: StatValue["unit"] = "count"): StatValue {
    return { key, label, value, unit };
}

/** Redis reports everything in one text blob of `field:value` lines. */
async function redisStats(address: DataAddress): Promise<DatabaseStats> {
    const { RedisDriver } = await import("./drivers/redis");
    const driver = new RedisDriver(address);
    try {
        const info = await driver.info();
        const read = (field: string): number => {
            const match = new RegExp(`^${field}:([^\r\n]+)`, "m").exec(info);
            const value = Number(match?.[1]);
            return Number.isFinite(value) ? value : 0;
        };
        // Every db line reads `dbN:keys=1,expires=0,...`; the keyspace is their sum.
        const keys = [...info.matchAll(/^db\d+:keys=(\d+)/gm)].reduce(
            (total, match) => total + Number(match[1]),
            0
        );
        return {
            at: Date.now(),
            engine: "redis",
            gauges: [
                gauge("ops", "Commands a second", read("instantaneous_ops_per_sec")),
                gauge("clients", "Connections", read("connected_clients")),
                gauge("memory", "Memory", read("used_memory"), "bytes"),
                gauge("keys", "Keys", keys),
                gauge("fragmentation", "Memory fragmentation", read("mem_fragmentation_ratio"))
            ],
            counters: [
                gauge("commands", "Commands", read("total_commands_processed")),
                gauge("hits", "Cache hits", read("keyspace_hits")),
                gauge("misses", "Cache misses", read("keyspace_misses")),
                gauge("expired", "Expired keys", read("expired_keys")),
                gauge("evicted", "Evicted keys", read("evicted_keys")),
                gauge("connections", "Connections opened", read("total_connections_received")),
                gauge("net_in", "Bytes in", read("total_net_input_bytes"), "bytes"),
                gauge("net_out", "Bytes out", read("total_net_output_bytes"), "bytes")
            ]
        };
    } finally {
        await driver.close();
    }
}

async function postgresStats(address: DataAddress): Promise<DatabaseStats> {
    return withDriver(address, async (driver) => {
        const [stat] = await driver.run(
            `SELECT numbackends, xact_commit, xact_rollback, blks_read, blks_hit,
                    tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted,
                    deadlocks, temp_bytes, pg_database_size(current_database()) AS size,
                    (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') AS active
               FROM pg_stat_database WHERE datname = current_database()`
        );
        const row = stat?.rows[0] ?? [];
        const at = (index: number): number => {
            const value = Number(row[index]);
            return Number.isFinite(value) ? value : 0;
        };
        return {
            at: Date.now(),
            engine: "postgres",
            gauges: [
                gauge("clients", "Connections", at(0)),
                gauge("active", "Running queries", at(13)),
                gauge("size", "Size on disk", at(12), "bytes")
            ],
            counters: [
                gauge("commits", "Transactions", at(1)),
                gauge("rollbacks", "Rollbacks", at(2)),
                gauge("hits", "Cache hits", at(4)),
                gauge("misses", "Blocks read from disk", at(3)),
                gauge("returned", "Rows read", at(5)),
                gauge("inserted", "Rows inserted", at(7)),
                gauge("updated", "Rows updated", at(8)),
                gauge("deleted", "Rows deleted", at(9)),
                gauge("deadlocks", "Deadlocks", at(10)),
                gauge("temp", "Spilled to disk", at(11), "bytes")
            ]
        };
    });
}

async function mysqlStats(address: DataAddress): Promise<DatabaseStats> {
    return withDriver(address, async (driver) => {
        const [status] = await driver.run("SHOW GLOBAL STATUS");
        const values = new Map<string, number>();
        for (const row of status?.rows ?? []) {
            const name = String(row[0] ?? "");
            const value = Number(row[1]);
            if (name) values.set(name, Number.isFinite(value) ? value : 0);
        }
        const read = (name: string): number => values.get(name) ?? 0;
        const [size] = await driver.run(
            `SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes
               FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
        );
        return {
            at: Date.now(),
            engine: address.engine,
            gauges: [
                gauge("clients", "Connections", read("Threads_connected")),
                gauge("active", "Running queries", read("Threads_running")),
                gauge("size", "Size on disk", Number(size?.rows[0]?.[0] ?? 0), "bytes")
            ],
            counters: [
                gauge("questions", "Statements", read("Questions")),
                gauge("selects", "Selects", read("Com_select")),
                gauge("writes", "Writes", read("Com_insert") + read("Com_update") + read("Com_delete")),
                gauge("hits", "Buffer pool hits", read("Innodb_buffer_pool_read_requests")),
                gauge("misses", "Read from disk", read("Innodb_buffer_pool_reads")),
                gauge("slow", "Slow queries", read("Slow_queries")),
                gauge("aborted", "Refused connections", read("Aborted_connects"))
            ]
        };
    });
}

async function mongoStats(address: DataAddress): Promise<DatabaseStats> {
    return withDriver(address, async (driver) => {
        const [server] = await driver.run('{ "serverStatus": 1 }');
        const [db] = await driver.run('{ "dbStats": 1 }');
        const pick = (result: typeof server, field: string): number => {
            const index = result?.columns.indexOf(field) ?? -1;
            const value = index === -1 ? 0 : Number(result?.rows[0]?.[index]);
            return Number.isFinite(value) ? value : 0;
        };
        // serverStatus answers with nested documents, which the driver hands over
        // as JSON strings. The two that matter are read out rather than the whole
        // tree being flattened into columns nobody asked for.
        const nested = (result: typeof server, field: string, key: string): number => {
            const index = result?.columns.indexOf(field) ?? -1;
            if (index === -1) return 0;
            try {
                const parsed = JSON.parse(String(result?.rows[0]?.[index] ?? "{}")) as Record<string, unknown>;
                const value = Number(parsed[key]);
                return Number.isFinite(value) ? value : 0;
            } catch {
                return 0;
            }
        };
        return {
            at: Date.now(),
            engine: "mongo",
            gauges: [
                gauge("clients", "Connections", nested(server, "connections", "current")),
                gauge("available", "Connections free", nested(server, "connections", "available")),
                gauge("size", "Size on disk", pick(db, "storageSize"), "bytes"),
                gauge("collections", "Collections", pick(db, "collections")),
                gauge("objects", "Documents", pick(db, "objects"))
            ],
            counters: [
                gauge("query", "Queries", nested(server, "opcounters", "query")),
                gauge("insert", "Inserts", nested(server, "opcounters", "insert")),
                gauge("update", "Updates", nested(server, "opcounters", "update")),
                gauge("delete", "Deletes", nested(server, "opcounters", "delete")),
                gauge("getmore", "Cursor reads", nested(server, "opcounters", "getmore")),
                gauge("net_in", "Bytes in", nested(server, "network", "bytesIn"), "bytes"),
                gauge("net_out", "Bytes out", nested(server, "network", "bytesOut"), "bytes")
            ]
        };
    });
}
