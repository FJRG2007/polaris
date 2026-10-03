/**
 * The questions a database's Stats screen answers that a live rate cannot: how
 * full is it, where is the room going, is it keeping up with its own cleaning,
 * and what does it spend its time on.
 *
 * One report per engine, read from the engine's own catalogue in a fixed set of
 * bounded statements - every list is capped (`LIST_LIMIT`), nothing counts a
 * table's rows, and the planner's estimates stand in where a count would be a
 * scan. Each statement that may not be readable by this account (the WAL
 * directory, `pg_stat_statements`, MySQL's `sys` schema) is asked on its own and
 * its absence is reported as such rather than failing the report.
 *
 * The statements are run through a `Run` - a driver's `run` in production, a
 * fake in a test - so the parsing can be read beside the rows that produce it.
 * Reports are cached for `HEALTH_TTL_MS` per database, because the screen is
 * opened and reopened and none of these figures move in seconds.
 *
 * Server-only.
 */

import { withDriver } from "./open";
import type { RedisDriver } from "./drivers/redis";
import { POSTGRES_SYSTEM_SCHEMA_LIKE } from "./driver";
import type { DataAddress, DataDriver, QueryResult } from "./driver";

/** Runs one statement, with its values bound when there are any, and answers
 *  what the driver's `run` answers. */
export type Run = (statement: string, params?: readonly unknown[]) => Promise<QueryResult[]>;

/** How many tables, indexes and statements a report lists at most. */
export const LIST_LIMIT = 50;

/** How long a report is served from memory before it is read again. */
export const HEALTH_TTL_MS = 30_000;

export interface ConnectionUse {
    readonly used: number;
    readonly max: number | null;
    readonly active: number | null;
    readonly idle: number | null;
    readonly idleInTransaction: number | null;
}

export type SizeKey =
    | "database"
    | "tables"
    | "indexes"
    | "system"
    | "wal"
    | "other"
    | "data"
    | "storage"
    | "memory";

export interface SizePart {
    readonly key: SizeKey;
    readonly bytes: number;
}

export interface TableHealth {
    readonly schema: string | null;
    readonly name: string;
    /** The engine's estimate, never a count. */
    readonly rows: number | null;
    readonly dataBytes: number;
    readonly indexBytes: number;
    readonly seqScans: number | null;
    readonly idxScans: number | null;
    readonly deadRows: number | null;
    /** Dead rows as a share of all rows, 0-100. */
    readonly deadPercent: number | null;
    readonly lastVacuum: string | null;
    readonly lastAutovacuum: string | null;
    /** Transactions since the table was last frozen. */
    readonly xidAge: number | null;
    /** Space the engine holds for the table and is not using (MySQL `DATA_FREE`). */
    readonly freeBytes: number | null;
}

export interface UnusedIndex {
    readonly schema: string | null;
    readonly table: string;
    readonly name: string;
    readonly bytes: number;
    readonly scans: number;
}

export interface QueryStat {
    readonly statement: string;
    readonly calls: number;
    readonly rows: number | null;
    readonly totalMs: number | null;
    readonly meanMs: number | null;
    readonly maxMs: number | null;
}

/** Where the statement statistics stand, so the screen offers the right thing. */
export interface QueryStats {
    /** The engine ships what records them. */
    readonly available: boolean;
    /** Postgres: the extension exists in this database. */
    readonly installed: boolean;
    /** Postgres: the library is loaded at start, without which it records nothing. */
    readonly preloaded: boolean;
    readonly rows: readonly QueryStat[];
}

export type FactKey =
    | "version"
    | "uptime"
    | "keys"
    | "evicted"
    | "expired"
    | "fragmentation"
    | "slowQueries"
    | "abortedConnects"
    | "threadsRunning"
    | "tablesWithoutKey"
    | "collections"
    | "documents"
    | "persistence";

export interface Fact {
    readonly key: FactKey;
    readonly value: string | number;
    readonly unit?: "count" | "bytes" | "seconds" | "ratio";
}

export interface HealthReport {
    readonly engine: string;
    readonly at: number;
    readonly connections: ConnectionUse | null;
    /** 0-1, or null when the engine has served nothing yet. */
    readonly cacheHitRatio: number | null;
    readonly sizes: readonly SizePart[];
    readonly tables: readonly TableHealth[];
    /** How many tables there are in all, when `tables` was capped. */
    readonly tablesTotal: number;
    readonly vacuum: {
        readonly databaseXidAge: number | null;
        readonly freezeMaxAge: number | null;
        /** The database is past the age at which the engine forces a freeze. */
        readonly freezeRisk: boolean;
    } | null;
    readonly unusedIndexes: readonly UnusedIndex[] | null;
    readonly queries: QueryStats | null;
    readonly facts: readonly Fact[];
}

function num(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function maybeNum(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

/** The first row of the first result, by column name. */
function firstRow(results: readonly QueryResult[]): Record<string, unknown> {
    const result = results[0];
    const row = result?.rows[0];
    if (!result || !row) return {};
    return Object.fromEntries(result.columns.map((column, index) => [column, row[index]]));
}

/** Every row of the first result, by column name. */
function allRows(results: readonly QueryResult[]): Record<string, unknown>[] {
    const result = results[0];
    if (!result) return [];
    return result.rows.map((row) =>
        Object.fromEntries(result.columns.map((column, index) => [column, row[index]]))
    );
}

/** Asked on its own: a statement this account may not run is a missing figure. */
async function optional(run: Run, statement: string): Promise<QueryResult[] | null> {
    try {
        return await run(statement);
    } catch {
        return null;
    }
}

const STATEMENT_CHARS = 400;

function shorten(statement: string): string {
    const oneLine = statement.replace(/\s+/g, " ").trim();
    return oneLine.length > STATEMENT_CHARS ? `${oneLine.slice(0, STATEMENT_CHARS)}...` : oneLine;
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

export async function postgresHealth(run: Run): Promise<HealthReport> {
    const connections = firstRow(
        await run(
            `SELECT current_setting('max_connections')::int AS max,
                    count(*) FILTER (WHERE backend_type = 'client backend') AS used,
                    count(*) FILTER (WHERE backend_type = 'client backend' AND state = 'active') AS active,
                    count(*) FILTER (WHERE backend_type = 'client backend' AND state = 'idle') AS idle,
                    count(*) FILTER (WHERE backend_type = 'client backend' AND state LIKE 'idle in transaction%') AS idle_tx
               FROM pg_stat_activity`
        )
    );
    const cache = firstRow(
        await run(
            `SELECT sum(blks_hit)::float8 / NULLIF(sum(blks_hit) + sum(blks_read), 0) AS ratio
               FROM pg_stat_database WHERE datname = current_database()`
        )
    );
    const sizes = firstRow(
        await run(
            `SELECT pg_database_size(current_database()) AS database,
                    COALESCE(sum(pg_table_size(c.oid)) FILTER (WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE '${POSTGRES_SYSTEM_SCHEMA_LIKE}'), 0) AS tables,
                    COALESCE(sum(pg_indexes_size(c.oid)) FILTER (WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE '${POSTGRES_SYSTEM_SCHEMA_LIKE}'), 0) AS indexes,
                    COALESCE(sum(pg_total_relation_size(c.oid)) FILTER (WHERE n.nspname = 'information_schema' OR n.nspname LIKE '${POSTGRES_SYSTEM_SCHEMA_LIKE}'), 0) AS system
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r', 'm', 'p')`
        )
    );
    // The WAL directory is readable by superusers and pg_monitor only.
    const wal = await optional(run, "SELECT COALESCE(sum(size), 0) AS bytes FROM pg_ls_waldir()");
    const tables = allRows(
        await run(
            `SELECT s.schemaname, s.relname,
                    CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows,
                    pg_table_size(c.oid) AS data, pg_indexes_size(c.oid) AS indexes,
                    s.seq_scan, s.idx_scan, s.n_dead_tup, s.n_live_tup,
                    s.last_vacuum, s.last_autovacuum, age(c.relfrozenxid) AS xid_age
               FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
              ORDER BY pg_total_relation_size(c.oid) DESC
              LIMIT ${LIST_LIMIT}`
        )
    );
    const counted = firstRow(await run("SELECT count(*) AS total FROM pg_stat_user_tables"));
    const freeze = firstRow(
        await run(
            `SELECT age(datfrozenxid) AS age, current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max
               FROM pg_database WHERE datname = current_database()`
        )
    );
    const unused = allRows(
        await run(
            `SELECT s.schemaname, s.relname, s.indexrelname, pg_relation_size(s.indexrelid) AS bytes, s.idx_scan
               FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
              WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
              ORDER BY pg_relation_size(s.indexrelid) DESC
              LIMIT ${LIST_LIMIT}`
        )
    );
    const statements = firstRow(
        await run(
            `SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements') AS available,
                    EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed,
                    current_setting('shared_preload_libraries') AS preload,
                    current_setting('server_version') AS version`
        )
    );
    const preloaded = String(statements.preload ?? "")
        .split(",")
        .map((part) => part.trim())
        .includes("pg_stat_statements");
    const installed = statements.installed === true || statements.installed === "t";
    let queryRows: QueryStat[] = [];
    if (installed && preloaded) {
        // PostgreSQL 13 renamed the timing columns; the older names are asked
        // only when the newer ones are not there.
        const read =
            (await optional(
                run,
                `SELECT query, calls, rows, total_exec_time AS total, mean_exec_time AS mean, max_exec_time AS max
                   FROM pg_stat_statements
                  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                  ORDER BY total_exec_time DESC LIMIT ${LIST_LIMIT}`
            )) ??
            (await optional(
                run,
                `SELECT query, calls, rows, total_time AS total, mean_time AS mean, max_time AS max
                   FROM pg_stat_statements
                  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
                  ORDER BY total_time DESC LIMIT ${LIST_LIMIT}`
            ));
        queryRows = allRows(read ?? []).map((row) => ({
            statement: shorten(String(row.query ?? "")),
            calls: num(row.calls),
            rows: maybeNum(row.rows),
            totalMs: maybeNum(row.total),
            meanMs: maybeNum(row.mean),
            maxMs: maybeNum(row.max)
        }));
    }

    const database = num(sizes.database);
    const tablesBytes = num(sizes.tables);
    const indexBytes = num(sizes.indexes);
    const systemBytes = num(sizes.system);
    const walBytes = wal ? num(firstRow(wal).bytes) : null;
    const databaseXidAge = maybeNum(freeze.age);
    const freezeMaxAge = maybeNum(freeze.freeze_max);
    const ratio = maybeNum(cache.ratio);

    return {
        engine: "postgres",
        at: Date.now(),
        connections: {
            used: num(connections.used),
            max: maybeNum(connections.max),
            active: maybeNum(connections.active),
            idle: maybeNum(connections.idle),
            idleInTransaction: maybeNum(connections.idle_tx)
        },
        cacheHitRatio: ratio,
        sizes: [
            { key: "database", bytes: database },
            { key: "tables", bytes: tablesBytes },
            { key: "indexes", bytes: indexBytes },
            { key: "system", bytes: systemBytes },
            ...(walBytes === null ? [] : [{ key: "wal" as const, bytes: walBytes }]),
            { key: "other", bytes: Math.max(0, database - tablesBytes - indexBytes - systemBytes) }
        ],
        tables: tables.map((row) => {
            const dead = maybeNum(row.n_dead_tup);
            const live = maybeNum(row.n_live_tup);
            return {
                schema: text(row.schemaname),
                name: String(row.relname ?? ""),
                rows: maybeNum(row.rows),
                dataBytes: num(row.data),
                indexBytes: num(row.indexes),
                seqScans: maybeNum(row.seq_scan),
                idxScans: maybeNum(row.idx_scan),
                deadRows: dead,
                deadPercent:
                    dead === null || live === null || dead + live === 0
                        ? null
                        : Math.round((dead / (dead + live)) * 1000) / 10,
                lastVacuum: text(row.last_vacuum),
                lastAutovacuum: text(row.last_autovacuum),
                xidAge: maybeNum(row.xid_age),
                freeBytes: null
            };
        }),
        tablesTotal: num(counted.total),
        vacuum: {
            databaseXidAge,
            freezeMaxAge,
            freezeRisk:
                databaseXidAge !== null && freezeMaxAge !== null && databaseXidAge >= freezeMaxAge
        },
        unusedIndexes: unused.map((row) => ({
            schema: text(row.schemaname),
            table: String(row.relname ?? ""),
            name: String(row.indexrelname ?? ""),
            bytes: num(row.bytes),
            scans: num(row.idx_scan)
        })),
        queries: {
            available: statements.available === true || statements.available === "t",
            installed,
            preloaded,
            rows: queryRows
        },
        facts: statements.version ? [{ key: "version", value: String(statements.version) }] : []
    };
}

// ---------------------------------------------------------------------------
// MySQL and MariaDB
// ---------------------------------------------------------------------------

export async function mysqlHealth(run: Run, engine: string): Promise<HealthReport> {
    const status = new Map<string, number>();
    for (const row of (
        await run(
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Threads_running', 'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads', 'Slow_queries', 'Aborted_connects', 'Uptime')"
        )
    )[0]?.rows ?? []) {
        status.set(String(row[0] ?? ""), num(row[1]));
    }
    const variables = new Map<string, string>();
    for (const row of (
        await run("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections', 'version')")
    )[0]?.rows ?? []) {
        variables.set(String(row[0] ?? ""), String(row[1] ?? ""));
    }
    const tables = allRows(
        await run(
            `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH, DATA_FREE
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
              ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
              LIMIT ${LIST_LIMIT}`
        )
    );
    const totals = firstRow(
        await run(
            `SELECT COUNT(*) AS total, COALESCE(SUM(DATA_LENGTH), 0) AS data, COALESCE(SUM(INDEX_LENGTH), 0) AS indexes
               FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`
        )
    );
    const keyless = firstRow(
        await run(
            `SELECT COUNT(*) AS total FROM information_schema.TABLES t
              WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
                AND NOT EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS c
                                 WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
                                   AND c.CONSTRAINT_TYPE = 'PRIMARY KEY')`
        )
    );
    // The sys schema is MySQL's, and only with the performance schema on.
    const unused = await optional(
        run,
        `SELECT object_schema, object_name, index_name FROM sys.schema_unused_indexes
          WHERE object_schema = DATABASE() LIMIT ${LIST_LIMIT}`
    );
    const digests = await optional(
        run,
        `SELECT DIGEST_TEXT, COUNT_STAR, SUM_ROWS_SENT, SUM_TIMER_WAIT, AVG_TIMER_WAIT, MAX_TIMER_WAIT
           FROM performance_schema.events_statements_summary_by_digest
          WHERE SCHEMA_NAME = DATABASE()
          ORDER BY SUM_TIMER_WAIT DESC LIMIT ${LIST_LIMIT}`
    );
    // The performance schema's timer is in picoseconds.
    const ms = (value: unknown) => {
        const parsed = maybeNum(value);
        return parsed === null ? null : Math.round(parsed / 1_000_000) / 1000;
    };

    const requests = status.get("Innodb_buffer_pool_read_requests") ?? 0;
    const reads = status.get("Innodb_buffer_pool_reads") ?? 0;
    const data = num(totals.data);
    const indexes = num(totals.indexes);
    return {
        engine,
        at: Date.now(),
        connections: {
            used: status.get("Threads_connected") ?? 0,
            max: maybeNum(variables.get("max_connections")),
            active: status.get("Threads_running") ?? null,
            idle: null,
            idleInTransaction: null
        },
        cacheHitRatio: requests > 0 ? Math.max(0, 1 - reads / requests) : null,
        sizes: [
            { key: "database", bytes: data + indexes },
            { key: "tables", bytes: data },
            { key: "indexes", bytes: indexes }
        ],
        tables: tables.map((row) => ({
            schema: null,
            name: String(row.TABLE_NAME ?? ""),
            rows: maybeNum(row.TABLE_ROWS),
            dataBytes: num(row.DATA_LENGTH),
            indexBytes: num(row.INDEX_LENGTH),
            seqScans: null,
            idxScans: null,
            deadRows: null,
            deadPercent: null,
            lastVacuum: null,
            lastAutovacuum: null,
            xidAge: null,
            freeBytes: maybeNum(row.DATA_FREE)
        })),
        tablesTotal: num(totals.total),
        vacuum: null,
        unusedIndexes: unused
            ? allRows(unused).map((row) => ({
                  schema: text(row.object_schema),
                  table: String(row.object_name ?? ""),
                  name: String(row.index_name ?? ""),
                  bytes: 0,
                  scans: 0
              }))
            : null,
        queries: {
            available: digests !== null,
            installed: digests !== null,
            preloaded: digests !== null,
            rows: allRows(digests ?? []).map((row) => ({
                statement: shorten(String(row.DIGEST_TEXT ?? "")),
                calls: num(row.COUNT_STAR),
                rows: maybeNum(row.SUM_ROWS_SENT),
                totalMs: ms(row.SUM_TIMER_WAIT),
                meanMs: ms(row.AVG_TIMER_WAIT),
                maxMs: ms(row.MAX_TIMER_WAIT)
            }))
        },
        facts: [
            ...(variables.get("version")
                ? [{ key: "version" as const, value: variables.get("version") as string }]
                : []),
            { key: "uptime", value: status.get("Uptime") ?? 0, unit: "seconds" },
            { key: "slowQueries", value: status.get("Slow_queries") ?? 0, unit: "count" },
            { key: "abortedConnects", value: status.get("Aborted_connects") ?? 0, unit: "count" },
            { key: "tablesWithoutKey", value: num(keyless.total), unit: "count" }
        ]
    };
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

/** A Redis `INFO` reply, as the figures the report shows. Pure. */
export function redisHealthFromInfo(info: string): HealthReport {
    const field = (name: string): string | null => {
        const match = new RegExp(`^${name}:([^\\r\\n]*)`, "m").exec(info);
        return match ? (match[1] ?? "").trim() : null;
    };
    const read = (name: string): number | null => maybeNum(field(name));
    const keys = [...info.matchAll(/^db\d+:keys=(\d+)/gm)].reduce(
        (total, match) => total + Number(match[1]),
        0
    );
    const hits = read("keyspace_hits") ?? 0;
    const misses = read("keyspace_misses") ?? 0;
    const maxMemory = read("maxmemory");
    const aof = field("aof_enabled") === "1";
    const rdb = (read("rdb_changes_since_last_save") ?? null) !== null;
    return {
        engine: "redis",
        at: Date.now(),
        connections: {
            used: read("connected_clients") ?? 0,
            max: read("maxclients"),
            active: null,
            idle: null,
            idleInTransaction: null
        },
        cacheHitRatio: hits + misses > 0 ? hits / (hits + misses) : null,
        sizes: [
            { key: "memory", bytes: read("used_memory") ?? 0 },
            ...(maxMemory ? [{ key: "database" as const, bytes: maxMemory }] : [])
        ],
        tables: [],
        tablesTotal: 0,
        vacuum: null,
        unusedIndexes: null,
        queries: null,
        facts: [
            ...(field("redis_version")
                ? [{ key: "version" as const, value: field("redis_version") as string }]
                : []),
            { key: "uptime", value: read("uptime_in_seconds") ?? 0, unit: "seconds" },
            { key: "keys", value: keys, unit: "count" },
            { key: "evicted", value: read("evicted_keys") ?? 0, unit: "count" },
            { key: "expired", value: read("expired_keys") ?? 0, unit: "count" },
            { key: "fragmentation", value: read("mem_fragmentation_ratio") ?? 0, unit: "ratio" },
            { key: "persistence", value: aof ? "aof" : rdb ? "rdb" : "none" }
        ]
    };
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

export async function mongoHealth(run: Run): Promise<HealthReport> {
    const server = await run('{ "serverStatus": 1 }');
    const db = firstRow(await run('{ "dbStats": 1 }'));
    const nested = (field: string, key: string): number | null => {
        const raw = firstRow(server)[field];
        if (raw === undefined || raw === null) return null;
        try {
            const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<
                string,
                unknown
            >;
            return maybeNum(parsed[key]);
        } catch {
            return null;
        }
    };
    const version = firstRow(server).version;
    return {
        engine: "mongo",
        at: Date.now(),
        connections: {
            used: nested("connections", "current") ?? 0,
            max:
                nested("connections", "current") !== null &&
                nested("connections", "available") !== null
                    ? (nested("connections", "current") ?? 0) +
                      (nested("connections", "available") ?? 0)
                    : null,
            active: nested("connections", "active"),
            idle: null,
            idleInTransaction: null
        },
        cacheHitRatio: null,
        sizes: [
            { key: "data", bytes: num(db.dataSize) },
            { key: "storage", bytes: num(db.storageSize) },
            { key: "indexes", bytes: num(db.indexSize) }
        ],
        tables: [],
        tablesTotal: num(db.collections),
        vacuum: null,
        unusedIndexes: null,
        queries: null,
        facts: [
            ...(version ? [{ key: "version" as const, value: String(version) }] : []),
            { key: "uptime", value: num(firstRow(server).uptime), unit: "seconds" },
            { key: "collections", value: num(db.collections), unit: "count" },
            { key: "documents", value: num(db.objects), unit: "count" }
        ]
    };
}

// ---------------------------------------------------------------------------
// One report, through a driver, cached
// ---------------------------------------------------------------------------

/** Read one report for an address the caller has already resolved and authorized. */
export async function healthAt(address: DataAddress): Promise<HealthReport> {
    return withDriver(address, async (driver) => {
        const run = runnerFor(driver);
        switch (address.engine) {
            case "postgres":
                return postgresHealth(run);
            case "mysql":
            case "mariadb":
                return mysqlHealth(run, address.engine);
            case "mongo":
                return mongoHealth(run);
            case "redis":
                return redisHealthFromInfo(await (driver as RedisDriver).info());
            default:
                throw new Error("No health report for this engine.");
        }
    });
}

/** A `Run` over an open driver: bound values go through Postgres' own parameter
 *  path; every other statement Polaris writes here carries none. */
export function runnerFor(driver: DataDriver): Run {
    // Asked of the driver rather than imported: importing the Postgres driver
    // here would load `pg` into every request that reads any engine's report.
    const bound = (
        driver as {
            query?: (statement: string, params: readonly unknown[]) => Promise<QueryResult[]>;
        }
    ).query;
    return (statement, params) => {
        if (params && params.length > 0) {
            if (typeof bound !== "function")
                throw new Error("Bound values are only sent to PostgreSQL here.");
            return bound.call(driver, statement, params);
        }
        return driver.run(statement);
    };
}

/** Reports kept in memory, by key. Bounded so a process that has opened a
 *  thousand databases does not hold a thousand reports. */
const cache = new Map<string, { readonly at: number; readonly report: Promise<HealthReport> }>();
const CACHE_ENTRIES = 500;

/**
 * A report from memory when one was read in the last `HEALTH_TTL_MS`, otherwise
 * a fresh one. Two screens opening at once share one read. A failed read is not
 * kept, so the next open tries again.
 */
export function cachedHealth(
    key: string,
    read: () => Promise<HealthReport>,
    now = Date.now()
): Promise<HealthReport> {
    const kept = cache.get(key);
    if (kept && now - kept.at < HEALTH_TTL_MS) return kept.report;
    const report = read();
    cache.set(key, { at: now, report });
    report.catch(() => {
        if (cache.get(key)?.report === report) cache.delete(key);
    });
    while (cache.size > CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
    return report;
}

/** Forget a database's report, after something changed what it would say. */
export function forgetHealth(key: string): void {
    cache.delete(key);
}
