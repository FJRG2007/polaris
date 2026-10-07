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
 * Read-only is a real read-only transaction rather than a promise. Every typed
 * statement runs inside `BEGIN READ ONLY`, after a first query has fixed the
 * transaction's mode, and is rolled back after - so Postgres refuses the write
 * itself, which covers what no keyword check could catch: a function that
 * writes, a trigger behind a SELECT, a statement that tries to switch the
 * transaction or the session back to read-write. Each one is sent on its own,
 * through the extended protocol, which takes exactly one statement: a second one
 * hidden where the splitter did not see it is an error, not a write.
 */

import { Client, Query, type QueryArrayConfig } from "pg";
import * as data from "../driver";
import { tlsConnectOptions } from "../tls";
import { prepareCellEdit } from "../cell-edit";
import * as rowEdit from "../row-edit";
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

/**
 * Schemas nobody browsing their own data means.
 *
 * `information_schema` by name, and everything Postgres owns by its prefix. The
 * prefix is the rule rather than a list because the list cannot be complete: the
 * server creates `pg_temp_N` and `pg_toast_temp_N` per backend as sessions make
 * temporary tables, so the set changes while somebody is looking at it. Naming
 * the three fixed ones and one of the two patterns is what shipped, and
 * `pg_toast_temp_3` duly turned up in the schema selector - and, on a database
 * with no `public`, could be the one the browser opened on.
 *
 * Safe to exclude wholesale: Postgres reserves the `pg_` prefix and refuses to
 * create a schema with it ("unacceptable schema name ... The prefix pg_ is
 * reserved for system schemas"), so there is no user schema this can hide.
 */
const SYSTEM_SCHEMA_NAMES = ["information_schema"];
const SYSTEM_SCHEMA_PREFIX = "pg\\_%";

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
            // Whatever the connection's mode says, checked the way `tls.ts`
            // checks it for every engine.
            ssl: tlsConnectOptions(this.address.tls) ?? undefined,
            connectionTimeoutMillis: 8000,
            statement_timeout: data.STATEMENT_TIMEOUT_MS,
            application_name: "polaris-data-browser"
        });
        await client.connect();
        if (this.address.readOnly)
            await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
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
              WHERE n.nspname <> ALL($1::text[]) AND n.nspname NOT LIKE $2
              GROUP BY n.nspname
              ORDER BY n.nspname`,
            [SYSTEM_SCHEMA_NAMES, SYSTEM_SCHEMA_PREFIX]
        );
        return result.rows.map((row) => ({
            name: row.name,
            kind: "schema" as const,
            count: Number(row.count)
        }));
    }

    /**
     * Every database on this server the account could open, the open one first
     * among equals.
     *
     * `pg_database` is a shared catalogue, so any connection reads the whole
     * server's list. Beekeeper Studio drops the templates (`datistemplate`); this
     * also drops what refuses connections outright (`datallowconn`, which is
     * `template0`'s state and a database being taken offline) and what this
     * account has no CONNECT on, since offering a name that only answers
     * "permission denied" is offering nothing. The open database is kept
     * whatever its flags say - it is the one already open.
     *
     * An account that may not read the catalogue gets the database it is in, the
     * way the MongoDB driver falls back when `listDatabases` is refused.
     */
    async databases(): Promise<string[]> {
        const client = await this.open();
        try {
            const result = await client.query<{ name: string }>(
                `SELECT datname AS name
                   FROM pg_database
                  WHERE (NOT datistemplate AND datallowconn AND has_database_privilege(datname, 'CONNECT'))
                     OR datname = current_database()
                  ORDER BY datname`
            );
            return result.rows.map((row) => row.name);
        } catch {
            const current = await client
                .query<{ name: string }>("SELECT current_database() AS name")
                .then((result) => result.rows[0]?.name ?? null)
                .catch(() => null);
            const fallback = current ?? this.address.database ?? null;
            return fallback ? [fallback] : [];
        }
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

    async rows(
        namespace: string | null,
        relation: string,
        query: data.RowQuery
    ): Promise<data.DataPage> {
        const client = await this.open();
        const columns = await this.columns(namespace, relation);
        if (columns.length === 0)
            throw new data.DataRequestError("That table has no columns to read.");
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

    async count(
        namespace: string | null,
        relation: string,
        filter: string | null
    ): Promise<number> {
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
        const readOnly = this.address.readOnly;
        if (readOnly && anyStatementWrites(sql, "postgres")) {
            throw new data.ReadOnlyError("one of those statements");
        }
        const client = await this.open();
        const results: data.QueryResult[] = [];
        for (const statement of splitStatements(sql, "postgres")) {
            const started = Date.now();
            const result = readOnly
                ? await this.readOnlyStatement(client, statement)
                : await capped(client, statement, false);
            results.push({
                statement,
                columns: result.columns,
                rows: result.rows,
                affected: statementWrites(statement, "postgres") ? (result.rowCount ?? 0) : null,
                ms: Date.now() - started,
                ...(result.truncated ? { note: data.TRUNCATED_NOTE } : {})
            });
        }
        return results;
    }

    /**
     * One statement in a transaction that cannot write.
     *
     * `SELECT 1` first, because Postgres lets a transaction be switched back to
     * read-write only until its first query: after that, `SET TRANSACTION READ
     * WRITE` is refused by the engine. The rollback undoes anything the statement
     * managed to change about the session, a `SET` included.
     */
    private async readOnlyStatement(client: Client, statement: string): Promise<CappedResult> {
        await client.query("BEGIN TRANSACTION READ ONLY");
        try {
            await client.query("SELECT 1");
            return await capped(client, statement, true);
        } finally {
            await client.query("ROLLBACK").catch(() => undefined);
        }
    }

    /**
     * One statement Polaris wrote, with its values bound. Never a statement
     * somebody typed - that is `run` - so it is not judged for writes here; a
     * read-only session is still refused any by the engine itself.
     */
    async query(statement: string, params: readonly unknown[]): Promise<data.QueryResult[]> {
        const client = await this.open();
        const started = Date.now();
        const result = await client.query({
            text: statement,
            values: [...params],
            rowMode: "array"
        });
        return [
            {
                statement,
                columns: result.fields?.map((field) => field.name) ?? [],
                rows: (result.rows as unknown[][]) ?? [],
                affected: null,
                ms: Date.now() - started
            }
        ];
    }

    /**
     * Change one cell, aimed by primary key.
     *
     * Refused outright on a read-only connection - the session is already set
     * READ ONLY, so the engine would refuse it too, but a sentence somebody can
     * act on is better than a transaction error. Everything else about which
     * statement this becomes is `prepareCellEdit`, shared with MySQL.
     */
    async updateCell(edit: data.CellEdit): Promise<data.CellEditResult> {
        if (this.address.readOnly) throw new data.ReadOnlyError("changing a value");
        const columns = await this.columns(edit.namespace, edit.relation);
        const prepared = prepareCellEdit(edit, columns, {
            quote: quoteSqlIdent,
            placeholder: (index) => `$${index}`,
            target: quoteQualified([edit.namespace ?? "public", edit.relation], quoteSqlIdent)
        });
        const client = await this.open();
        const result = await client.query(prepared.text, prepared.params);
        return { changed: result.rowCount ?? 0 };
    }

    /** Add one row; a column left out takes its default. See `row-edit.ts`. */
    async insertRow(insert: rowEdit.RowInsert): Promise<rowEdit.RowWriteResult> {
        if (this.address.readOnly) throw new data.ReadOnlyError("adding a row");
        const columns = await this.columns(insert.namespace, insert.relation);
        const prepared = rowEdit.prepareInsert(
            insert,
            columns,
            this.dialect(insert.namespace, insert.relation),
            "postgres"
        );
        const client = await this.open();
        const result = await client.query(prepared.text, prepared.params);
        return { changed: result.rowCount ?? 0 };
    }

    /**
     * Remove rows by their whole primary key, in one transaction: either every
     * row named goes, or - when the engine refuses one, a foreign key pointing at
     * it - none of them do.
     */
    async deleteRows(removal: rowEdit.RowDelete): Promise<rowEdit.RowWriteResult> {
        if (this.address.readOnly) throw new data.ReadOnlyError("removing rows");
        const columns = await this.columns(removal.namespace, removal.relation);
        const prepared = rowEdit.prepareDelete(
            removal,
            columns,
            this.dialect(removal.namespace, removal.relation)
        );
        const client = await this.open();
        await client.query("BEGIN");
        try {
            const result = await client.query(prepared.text, prepared.params);
            await client.query("COMMIT");
            return { changed: result.rowCount ?? 0 };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        }
    }

    async createTable(draft: rowEdit.TableDraft): Promise<void> {
        if (this.address.readOnly) throw new data.ReadOnlyError("creating a table");
        const text = rowEdit.prepareCreateTable(
            draft,
            "postgres",
            quoteSqlIdent,
            (namespace, name) => quoteQualified([namespace ?? "public", name], quoteSqlIdent)
        );
        const client = await this.open();
        await client.query(text);
    }

    private dialect(namespace: string | null, relation: string) {
        return {
            quote: quoteSqlIdent,
            placeholder: (index: number) => `$${index}`,
            target: quoteQualified([namespace ?? "public", relation], quoteSqlIdent)
        };
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = null;
        if (client) await client.end().catch(() => undefined);
    }
}

interface CappedResult {
    readonly columns: string[];
    readonly rows: unknown[][];
    readonly rowCount: number | null;
    readonly truncated: boolean;
}

/**
 * Run one statement and keep at most `MAX_STATEMENT_ROWS` of what it returns.
 *
 * Rows arrive one at a time on the `row` event and are not collected by the
 * driver once something listens for them, so the ones past the limit are read
 * and dropped rather than held. `extended` sends it through the extended
 * protocol, which takes exactly one statement.
 */
function capped(client: Client, text: string, extended: boolean): Promise<CappedResult> {
    return new Promise((resolve, reject) => {
        const rows: unknown[][] = [];
        let truncated = false;
        // `queryMode` is pg's and missing from its declarations.
        const config: QueryArrayConfig & { queryMode?: "extended" } = {
            text,
            rowMode: "array",
            ...(extended ? { queryMode: "extended" as const } : {})
        };
        const query = new Query(config);
        query.on("row", (row: unknown[]) => {
            if (rows.length < data.MAX_STATEMENT_ROWS) rows.push(row);
            else truncated = true;
        });
        query.on("error", reject);
        query.on("end", (ended: unknown) => {
            // A statement the splitter left whole can still be several to the
            // simple protocol; its last answer is the one that is drawn.
            const last = (Array.isArray(ended) ? ended[ended.length - 1] : ended) as
                | { fields?: { name: string }[]; rowCount?: number | null }
                | undefined;
            resolve({
                columns: last?.fields?.map((field) => field.name) ?? [],
                rows,
                rowCount: last?.rowCount ?? null,
                truncated
            });
        });
        client.query(query);
    });
}
