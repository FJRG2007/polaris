/**
 * The two questions a database screen is opened to answer that a rate cannot.
 *
 * "What is it doing right now" is the Activity panel's rates, and it is a
 * different question from "what is in here" and "what does it spend its time
 * on". Those two are what somebody is actually looking for when a disk is
 * filling or a page is slow, and neither is a counter climbing.
 *
 * **Where is the room going** is answered everywhere: every engine can be asked
 * how big its tables are, and the answer is the same shape whatever asked it.
 *
 * **What runs most often** is not. Postgres keeps it only when
 * `pg_stat_statements` is installed - an extension, and on a managed database
 * often not one anybody can install - and MySQL only when the performance schema
 * is on. So it is optional by design and comes back with a sentence saying which
 * of those is missing, rather than an empty chart that reads as a database doing
 * nothing.
 *
 * Both are read on demand rather than polled. They change over hours, not
 * seconds, and putting them on the five-second poll would mean a `pg_class` scan
 * every five seconds for a chart nobody is watching change.
 *
 * Server-only.
 */

import { withDriver } from "./open";
import { addressOf } from "./connections";
import { POSTGRES_SYSTEM_SCHEMA_LIKE, type DataAddress } from "./driver";

/** One row of a "biggest things in here" chart. */
export interface SizedRelation {
    readonly name: string;
    readonly bytes: number;
    /** Rows, where the engine can say without counting them. */
    readonly rows: number | null;
}

/** One statement the engine has been asked repeatedly. */
export interface FrequentStatement {
    /** The normalized statement, with its literals already replaced by the
     *  engine. Truncated for display; nobody reads a 4KB query off a chart. */
    readonly statement: string;
    readonly calls: number;
    /** Total milliseconds across every call, where the engine tracks it. */
    readonly totalMs: number | null;
}

export interface DatabaseInsights {
    readonly biggest: SizedRelation[];
    readonly frequent: FrequentStatement[];
    /** Why `frequent` is empty, when it is empty because the engine will not say
     *  rather than because nothing has run. Empty string when there is nothing to
     *  explain. */
    readonly frequentUnavailable: string;
}

/** How many of each is worth drawing. Past this a bar chart is a wall. */
const TOP = 10;

/** As long a statement as a chart row can carry. */
const STATEMENT_CHARS = 160;

function shorten(statement: string): string {
    const oneLine = statement.replace(/\s+/g, " ").trim();
    return oneLine.length > STATEMENT_CHARS ? `${oneLine.slice(0, STATEMENT_CHARS)}...` : oneLine;
}

function count(value: unknown): number {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

export async function databaseInsights(
    userId: string,
    connectionId: string
): Promise<DatabaseInsights> {
    const address = await addressOf(userId, connectionId);
    switch (address.engine) {
        case "postgres":
            return postgresInsights(address);
        case "mysql":
        case "mariadb":
            return mysqlInsights(address);
        default:
            // Redis and Mongo have neither question in this shape: one is a
            // keyspace and the other is documents, and inventing a table list for
            // either would be drawing a chart about something that is not there.
            return { biggest: [], frequent: [], frequentUnavailable: "" };
    }
}

async function postgresInsights(address: DataAddress): Promise<DatabaseInsights> {
    return withDriver(address, async (driver) => {
        // `pg_total_relation_size` is the table plus its indexes plus its TOAST,
        // which is what "how much room is this costing me" means. The estimate
        // from the planner's own statistics rather than count(*): a count on the
        // ten biggest tables is the most expensive thing this screen could do.
        // Everything Postgres owns is excluded by prefix rather than by a list of
        // names: pg_temp_N and pg_toast_temp_N are created per backend as
        // sessions make temporary tables, so the set changes while somebody is
        // looking at it - and a backend's temporary tables are ordinary relations
        // that would otherwise turn up here as somebody's biggest tables.
        //
        // The pattern is interpolated rather than written into the statement.
        // Inline it has to survive this template literal, where a lone backslash
        // before an underscore is dropped - which turns LIKE's escape back into
        // its single-character wildcard, silently, and takes a schema called
        // pgbouncer with it. See POSTGRES_SYSTEM_SCHEMA_LIKE.
        const [sized] = await driver.run(
            `SELECT relname,
                    pg_total_relation_size(c.oid) AS bytes,
                    CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS rows
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r', 'p', 'm')
                AND n.nspname <> 'information_schema'
                AND n.nspname NOT LIKE '${POSTGRES_SYSTEM_SCHEMA_LIKE}'
              ORDER BY bytes DESC
              LIMIT ${TOP}`
        );

        let frequent: FrequentStatement[] = [];
        let frequentUnavailable = "";
        try {
            const [statements] = await driver.run(
                `SELECT query, calls, total_exec_time
                   FROM pg_stat_statements
                  ORDER BY calls DESC
                  LIMIT ${TOP}`
            );
            frequent = (statements?.rows ?? []).map((row) => ({
                statement: shorten(String(row[0] ?? "")),
                calls: count(row[1]),
                totalMs: Math.round(count(row[2]))
            }));
        } catch {
            // The extension is not installed, or this role cannot read it. Either
            // way it is a fact about the database rather than a failure, and the
            // panel says so instead of drawing nothing.
            frequentUnavailable =
                "Postgres only records this with the pg_stat_statements extension installed. Ask whoever runs this database to add it.";
        }

        return {
            biggest: (sized?.rows ?? []).map((row) => ({
                name: String(row[0] ?? ""),
                bytes: count(row[1]),
                rows: row[2] === null ? null : count(row[2])
            })),
            frequent,
            frequentUnavailable
        };
    });
}

async function mysqlInsights(address: DataAddress): Promise<DatabaseInsights> {
    return withDriver(address, async (driver) => {
        const [sized] = await driver.run(
            `SELECT TABLE_NAME,
                    COALESCE(DATA_LENGTH + INDEX_LENGTH, 0) AS bytes,
                    TABLE_ROWS
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE()
              ORDER BY bytes DESC
              LIMIT ${TOP}`
        );

        let frequent: FrequentStatement[] = [];
        let frequentUnavailable = "";
        try {
            // The digest table is the performance schema's, and it is off on
            // plenty of installs. `DIGEST_TEXT` is already normalized - the
            // literals are replaced by the server - so nothing here is printing
            // somebody's data back at them.
            const [statements] = await driver.run(
                `SELECT DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT
                   FROM performance_schema.events_statements_summary_by_digest
                  WHERE SCHEMA_NAME = DATABASE()
                  ORDER BY COUNT_STAR DESC
                  LIMIT ${TOP}`
            );
            frequent = (statements?.rows ?? []).map((row) => ({
                statement: shorten(String(row[0] ?? "")),
                calls: count(row[1]),
                // The timer is in picoseconds, which is the performance schema's
                // own unit and not one anybody wants on a chart.
                totalMs: Math.round(count(row[2]) / 1_000_000_000)
            }));
        } catch {
            frequentUnavailable =
                "This server does not have the performance schema turned on, so it is not recording which statements run.";
        }

        return {
            biggest: (sized?.rows ?? []).map((row) => ({
                name: String(row[0] ?? ""),
                bytes: count(row[1]),
                rows: row[2] === null ? null : count(row[2])
            })),
            frequent,
            frequentUnavailable
        };
    });
}
