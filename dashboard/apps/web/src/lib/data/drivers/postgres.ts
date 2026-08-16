/**
 * PostgreSQL, as the browser reads it.
 *
 * The catalogue queries are the ordinary ones (`information_schema` for columns,
 * `pg_class` for the row estimate) and they are parameterized, so nothing a
 * browser typed reaches a statement as text. The one thing that cannot be a
 * parameter is a name in the `FROM` of a page of rows, and that goes through two
 * gates: it has to be a relation this connection just listed, and it is quoted
 * on the way in anyway.
 *
 * Read-only is a real read-only transaction rather than a promise. Postgres
 * refuses the write itself, which covers the statements no keyword check could
 * catch - a function that writes, a trigger behind a SELECT.
 */

import { Client } from "pg";
import * as data from "../driver";
import {
    quoteQualified,
    quoteSqlIdent,
    splitStatements,
    statementWrites,
    anyStatementWrites
} from "@polaris/core";

/** The name a page of rows gives the table it reads, so a whole-row reference
 *  and a sort column both have one thing to hang off. */
const ROW_ALIAS = '"row"';

/** Schemas nobody browsing their own data means. */
const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

export class PostgresDriver implements data.DataDriver {
    readonly shape = "sql" as const;
    private client: Client | null = null;

    constructor(private readonly address: data.DataAddress) {}

    private async open(): Promise<Client> {
        if (this.client) return this.client;
        const client = new Client({
            host: this.address.host,
            port: this.address.port,
            database: this.address.database ?? undefined,
            user: this.address.username ?? undefined,
            password: this.address.password ?? undefined,
            // The certificate is not verified: a database Polaris runs answers
            // on a self-signed one, and refusing it would mean the tool works
            // everywhere except on the databases it provisioned. The channel is
            // still encrypted, which is what the switch is for.
            ssl: this.address.tls ? { rejectUnauthorized: false } : undefined,
            connectionTimeoutMillis: 8000,
            statement_timeout: 30_000,
            application_name: "polaris-data-browser"
        });
        await client.connect();
        if (this.address.readOnly) await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
        this.client = client;
        return client;
    }

    async version(): Promise<string> {
        const client = await this.open();
        const result = await client.query<{ version: string }>("SELECT version()");
        return result.rows[0]?.version ?? "PostgreSQL";
    }

    async namespaces(): Promise<data.DataNamespace[]> {
        const client = await this.open();
        const result = await client.query<{ name: string; count: string }>(
            `SELECT n.nspname AS name, count(c.oid)::text AS count
               FROM pg_namespace n
               LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r','v','m','p','f')
              WHERE n.nspname <> ALL($1::text[]) AND n.nspname NOT LIKE 'pg\\_temp%'
              GROUP BY n.nspname
              ORDER BY n.nspname`,
            [SYSTEM_SCHEMAS]
        );
        return result.rows.map((row) => ({
            name: row.name,
            kind: "schema" as const,
            count: Number(row.count)
        }));
    }

    async relations(namespace: string | null): Promise<data.DataRelation[]> {
        const client = await this.open();
        const result = await client.query<{ name: string; kind: string; rows: string }>(
            `SELECT c.relname AS name,
                    CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS kind,
                    c.reltuples::bigint::text AS rows
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r','v','m','p','f') AND n.nspname = $1
              ORDER BY c.relname`,
            [namespace ?? "public"]
        );
        return result.rows.map((row) => ({
            name: row.name,
            namespace: namespace ?? "public",
            kind: row.kind === "view" ? ("view" as const) : ("table" as const),
            // -1 is "never analysed", which is not a row count and must not be
            // drawn as one.
            rows: Number(row.rows) < 0 ? null : Number(row.rows)
        }));
    }

    async columns(namespace: string | null, relation: string): Promise<data.DataColumn[]> {
        const client = await this.open();
        const result = await client.query<{
            name: string;
            type: string;
            nullable: string;
            pk: boolean;
        }>(
            `SELECT a.attname AS name,
                    format_type(a.atttypid, a.atttypmod) AS type,
                    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable,
                    COALESCE(i.indisprimary, false) AS pk
               FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_index i ON i.indrelid = c.oid AND a.attnum = ANY(i.indkey) AND i.indisprimary
              WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
              ORDER BY a.attnum`,
            [namespace ?? "public", relation]
        );
        return result.rows.map((row) => ({
            name: row.name,
            type: row.type,
            nullable: row.nullable === "YES",
            primaryKey: row.pk
        }));
    }

    async rows(namespace: string | null, relation: string, query: data.RowQuery): Promise<data.DataPage> {
        const client = await this.open();
        const columns = await this.columns(namespace, relation);
        if (columns.length === 0) throw new data.DataRequestError("That table has no columns to read.");
        const target = quoteQualified([namespace ?? "public", relation], quoteSqlIdent);

        // Only a column this table actually has can be ordered by, and the name
        // is compared against the ones just read rather than pattern-matched.
        const order = query.orderBy
            ? columns.find((column) => column.name === query.orderBy)
            : undefined;
        if (query.orderBy && !order) throw new data.DataRequestError("No such column to order by.");

        const params: unknown[] = [];
        // The filter is a substring over the whole row, cast to text. Costlier
        // than an indexed column comparison and the only one that can be offered
        // over a table nobody has described: what somebody types in a box above a
        // grid is "find this", not a predicate.
        //
        // Through the alias, not the table's own name. A whole-row reference in
        // Postgres is a range variable, and `public.users::text` is read as the
        // column `users` of a table `public` - which is a "missing FROM-clause
        // entry" rather than a filter, and was exactly that until this alias.
        let where = "";
        if (query.filter?.trim()) {
            params.push(`%${query.filter.trim()}%`);
            where = ` WHERE ${ROW_ALIAS}::text ILIKE $${params.length}`;
        }

        const orderBy = order
            ? ` ORDER BY ${ROW_ALIAS}.${quoteSqlIdent(order.name)} ${query.descending ? "DESC" : "ASC"}`
            : "";
        params.push(query.limit, query.offset);
        const result = await client.query(
            `SELECT ${ROW_ALIAS}.* FROM ${target} AS ${ROW_ALIAS}${where}${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        return {
            columns,
            rows: result.rows as Record<string, unknown>[],
            total: null
        };
    }

    async count(namespace: string | null, relation: string, filter: string | null): Promise<number> {
        const client = await this.open();
        const target = quoteQualified([namespace ?? "public", relation], quoteSqlIdent);
        const params: unknown[] = [];
        let where = "";
        if (filter?.trim()) {
            params.push(`%${filter.trim()}%`);
            where = ` WHERE ${ROW_ALIAS}::text ILIKE $1`;
        }
        const result = await client.query<{ total: string }>(
            `SELECT count(*)::text AS total FROM ${target} AS ${ROW_ALIAS}${where}`,
            params
        );
        return Number(result.rows[0]?.total ?? 0);
    }

    async run(sql: string): Promise<data.QueryResult[]> {
        if (this.address.readOnly && anyStatementWrites(sql)) {
            throw new data.ReadOnlyError("one of those statements");
        }
        const client = await this.open();
        const results: data.QueryResult[] = [];
        for (const statement of splitStatements(sql)) {
            const started = Date.now();
            const result = await client.query({ text: statement, rowMode: "array" });
            const fields = result.fields?.map((field) => field.name) ?? [];
            results.push({
                statement,
                columns: fields,
                rows: (result.rows as unknown[][]) ?? [],
                affected: statementWrites(statement) ? (result.rowCount ?? 0) : null,
                ms: Date.now() - started
            });
        }
        return results;
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = null;
        if (client) await client.end().catch(() => undefined);
    }
}
