/**
 * MySQL and MariaDB, which are one driver here because they are one protocol and
 * one catalogue. Where they differ is in what they call a version, and that is
 * printed rather than branched on.
 *
 * A schema and a database are the same thing in this engine, so the namespace is
 * the database - which is also why the browser can move between them on one
 * connection while a Postgres connection is stuck in the database it opened.
 *
 * The filter is built over the columns the table actually has, concatenated and
 * compared once, because there is no row-to-text cast to lean on. Every name in
 * it came from the catalogue read a moment earlier and is quoted anyway.
 *
 * Read-only is the engine's: every typed statement runs inside `START
 * TRANSACTION READ ONLY` and is rolled back, so MySQL refuses the write itself -
 * including one tucked into a `/*!` comment, which MySQL runs as code.
 */

import * as net from "node:net";
import * as data from "../driver";
import * as rowEdit from "../row-edit";
import * as mysql from "mysql2/promise";
import { prepareCellEdit } from "../cell-edit";
import type { Connection as CallbackConnection, FieldPacket, ResultSetHeader } from "mysql2";
import {
    quoteQualified,
    quoteBacktickIdent,
    splitStatements,
    anyStatementWrites
} from "@polaris/core";

/** Schemas that belong to the server rather than to anybody's application. */
const SYSTEM_SCHEMAS = ["information_schema", "performance_schema", "mysql", "sys"];

export class MysqlDriver implements data.DataDriver {
    readonly shape = "sql" as const;
    private connection: mysql.Connection | null = null;

    constructor(private readonly address: data.DataAddress) {}

    private async open(): Promise<mysql.Connection> {
        if (this.connection) return this.connection;
        const tls = this.address.tls;
        // mysql2 checks the certificate against `host`, so `host` is the name
        // the connection was saved with and the socket is dialled separately -
        // at the address Polaris resolved and judged, or at a tunnel's port.
        const name = tls.mode === "disable" ? null : tls.name;
        const connection = await mysql.createConnection({
            host: name ?? this.address.host,
            port: this.address.port,
            ...(name && name !== this.address.host
                ? { stream: () => net.connect(this.address.port, this.address.host) }
                : {}),
            database: this.address.database ?? undefined,
            user: this.address.username ?? undefined,
            password: this.address.password ?? undefined,
            ssl:
                tls.mode === "disable"
                    ? undefined
                    : tls.mode === "require"
                      ? {
                            rejectUnauthorized: false,
                            ...(tls.clientCert && tls.clientKey
                                ? { cert: tls.clientCert, key: tls.clientKey }
                                : {})
                        }
                      : {
                            rejectUnauthorized: true,
                            verifyIdentity: tls.mode === "verify-full",
                            ...(tls.ca ? { ca: tls.ca } : {}),
                            ...(tls.clientCert && tls.clientKey
                                ? { cert: tls.clientCert, key: tls.clientKey }
                                : {})
                        },
            connectTimeout: 8000,
            // Several statements in one box is the point of the statement box.
            multipleStatements: false,
            // Numbers wider than a double arrive as strings rather than as a
            // rounded number that is not the value in the row.
            supportBigNumbers: true,
            bigNumberStrings: true,
            dateStrings: true
        });
        connection.on("error", () => {
            if (this.connection === connection) this.connection = null;
            connection.destroy();
        });
        if (this.address.readOnly) await connection.query("SET SESSION TRANSACTION READ ONLY");
        // The server's own limit, so a statement the client gave up on does not
        // keep running there. MySQL and MariaDB name it differently; whichever
        // this server does not know is refused and ignored.
        const seconds = data.STATEMENT_TIMEOUT_MS / 1000;
        await connection
            .query(`SET SESSION max_execution_time = ${data.STATEMENT_TIMEOUT_MS}`)
            .catch(() => connection.query(`SET SESSION max_statement_time = ${seconds}`))
            .catch(() => undefined);
        this.connection = connection;
        return connection;
    }

    async version(): Promise<string> {
        const connection = await this.open();
        const [rows] = await connection.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version");
        return String(rows[0]?.version ?? "MySQL");
    }

    async namespaces(): Promise<data.DataNamespace[]> {
        const connection = await this.open();
        const [rows] = await connection.query<mysql.RowDataPacket[]>(
            `SELECT s.SCHEMA_NAME AS \`name\`, COUNT(t.TABLE_NAME) AS \`count\`
               FROM information_schema.SCHEMATA s
               LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
              WHERE s.SCHEMA_NAME NOT IN (?, ?, ?, ?)
              GROUP BY s.SCHEMA_NAME
              ORDER BY s.SCHEMA_NAME`,
            SYSTEM_SCHEMAS
        );
        return rows.map((row) => ({
            name: String(row.name),
            kind: "database" as const,
            count: Number(row.count)
        }));
    }

    async relations(namespace: string | null): Promise<data.DataRelation[]> {
        const connection = await this.open();
        const schema = namespace ?? this.address.database;
        const [rows] = await connection.query<mysql.RowDataPacket[]>(
            // The aliases are quoted because `rows` is a reserved word in
            // MariaDB and a bare one is a syntax error rather than an alias.
            `SELECT TABLE_NAME AS \`name\`, TABLE_TYPE AS \`type\`, TABLE_ROWS AS \`rows\`
               FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME`,
            [schema]
        );
        return rows.map((row) => ({
            name: String(row.name),
            namespace: schema ?? null,
            kind: String(row.type) === "VIEW" ? ("view" as const) : ("table" as const),
            // An estimate from the storage engine, and absent for a view.
            rows: row.rows === null || row.rows === undefined ? null : Number(row.rows)
        }));
    }

    async columns(namespace: string | null, relation: string): Promise<data.DataColumn[]> {
        const connection = await this.open();
        const [rows] = await connection.query<mysql.RowDataPacket[]>(
            `SELECT COLUMN_NAME AS \`name\`, COLUMN_TYPE AS \`type\`, IS_NULLABLE AS \`nullable\`, COLUMN_KEY AS \`ckey\`
               FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
              ORDER BY ORDINAL_POSITION`,
            [namespace ?? this.address.database, relation]
        );
        return rows.map((row) => ({
            name: String(row.name),
            type: String(row.type),
            nullable: String(row.nullable) === "YES",
            primaryKey: String(row.ckey) === "PRI"
        }));
    }

    async rows(
        namespace: string | null,
        relation: string,
        query: data.RowQuery
    ): Promise<data.DataPage> {
        const connection = await this.open();
        const columns = await this.columns(namespace, relation);
        if (columns.length === 0)
            throw new data.DataRequestError("That table has no columns to read.");
        const target = quoteQualified(
            [namespace ?? this.address.database ?? null, relation],
            quoteBacktickIdent
        );

        const order = query.orderBy
            ? columns.find((column) => column.name === query.orderBy)
            : undefined;
        if (query.orderBy && !order) throw new data.DataRequestError("No such column to order by.");

        const params: unknown[] = [];
        let where = "";
        if (query.filter?.trim()) {
            const concat = columns.map((column) => quoteBacktickIdent(column.name)).join(", ");
            params.push(`%${query.filter.trim()}%`);
            where = ` WHERE CONCAT_WS(' ', ${concat}) LIKE ?`;
        }

        const orderBy = order
            ? ` ORDER BY ${quoteBacktickIdent(order.name)} ${query.descending ? "DESC" : "ASC"}`
            : "";
        // Not parameters: MySQL takes LIMIT and OFFSET as literals in a prepared
        // statement only from 8.0.22 onwards, and MariaDB not at all. They are
        // integers this module produced, clamped before they got here.
        const limit = Math.floor(query.limit);
        const offset = Math.floor(query.offset);
        const [rows] = await connection.query<mysql.RowDataPacket[]>(
            `SELECT * FROM ${target}${where}${orderBy} LIMIT ${limit} OFFSET ${offset}`,
            params
        );

        return { columns, rows: rows as Record<string, unknown>[], total: null };
    }

    async count(
        namespace: string | null,
        relation: string,
        filter: string | null
    ): Promise<number> {
        const connection = await this.open();
        const target = quoteQualified(
            [namespace ?? this.address.database ?? null, relation],
            quoteBacktickIdent
        );
        const params: unknown[] = [];
        let where = "";
        if (filter?.trim()) {
            const columns = await this.columns(namespace, relation);
            const concat = columns.map((column) => quoteBacktickIdent(column.name)).join(", ");
            params.push(`%${filter.trim()}%`);
            where = ` WHERE CONCAT_WS(' ', ${concat}) LIKE ?`;
        }
        const [rows] = await connection.query<mysql.RowDataPacket[]>(
            `SELECT COUNT(*) AS total FROM ${target}${where}`,
            params
        );
        return Number(rows[0]?.total ?? 0);
    }

    async run(sql: string): Promise<data.QueryResult[]> {
        const readOnly = this.address.readOnly;
        if (readOnly && anyStatementWrites(sql, "mysql")) {
            throw new data.ReadOnlyError("one of those statements");
        }
        const connection = await this.open();
        const results: data.QueryResult[] = [];
        for (const statement of splitStatements(sql, "mysql")) {
            const started = Date.now();
            let result: CappedResult;
            if (readOnly) {
                await connection.query("START TRANSACTION READ ONLY");
                try {
                    result = await capped(callbackOf(connection), statement);
                } finally {
                    await connection.query("ROLLBACK").catch(() => undefined);
                }
            } else {
                result = await capped(callbackOf(connection), statement);
            }
            results.push({
                statement,
                columns: result.columns,
                rows: result.rows,
                affected: result.affected,
                ms: Date.now() - started,
                ...(result.truncated ? { note: data.TRUNCATED_NOTE } : {})
            });
        }
        return results;
    }

    /**
     * Change one cell, aimed by primary key.
     *
     * MySQL's placeholders are positional and unnumbered, which is the only thing
     * this differs from Postgres on; everything else about which statement it
     * becomes is `prepareCellEdit`.
     */
    async updateCell(edit: data.CellEdit): Promise<data.CellEditResult> {
        if (this.address.readOnly) throw new data.ReadOnlyError("changing a value");
        const columns = await this.columns(edit.namespace, edit.relation);
        const prepared = prepareCellEdit(edit, columns, {
            quote: quoteBacktickIdent,
            placeholder: () => "?",
            target: quoteQualified([edit.namespace, edit.relation], quoteBacktickIdent)
        });
        const connection = await this.open();
        const [result] = await connection.query(prepared.text, prepared.params);
        return { changed: (result as { affectedRows?: number }).affectedRows ?? 0 };
    }

    /** Add one row; a column left out takes its default. See `row-edit.ts`. */
    async insertRow(insert: rowEdit.RowInsert): Promise<rowEdit.RowWriteResult> {
        if (this.address.readOnly) throw new data.ReadOnlyError("adding a row");
        const columns = await this.columns(insert.namespace, insert.relation);
        const prepared = rowEdit.prepareInsert(
            insert,
            columns,
            this.dialect(insert.namespace, insert.relation),
            "mysql"
        );
        const connection = await this.open();
        const [result] = await connection.query(prepared.text, prepared.params);
        return { changed: (result as { affectedRows?: number }).affectedRows ?? 0 };
    }

    /** Remove rows by their whole primary key, all of them or none. */
    async deleteRows(removal: rowEdit.RowDelete): Promise<rowEdit.RowWriteResult> {
        if (this.address.readOnly) throw new data.ReadOnlyError("removing rows");
        const columns = await this.columns(removal.namespace, removal.relation);
        const prepared = rowEdit.prepareDelete(
            removal,
            columns,
            this.dialect(removal.namespace, removal.relation)
        );
        const connection = await this.open();
        await connection.beginTransaction();
        try {
            const [result] = await connection.query(prepared.text, prepared.params);
            await connection.commit();
            return { changed: (result as { affectedRows?: number }).affectedRows ?? 0 };
        } catch (error) {
            await connection.rollback().catch(() => undefined);
            throw error;
        }
    }

    /** MySQL commits a CREATE TABLE on its own; there is nothing to roll back. */
    async createTable(draft: rowEdit.TableDraft): Promise<void> {
        if (this.address.readOnly) throw new data.ReadOnlyError("creating a table");
        const text = rowEdit.prepareCreateTable(
            draft,
            "mysql",
            quoteBacktickIdent,
            (namespace, name) => quoteQualified([namespace, name], quoteBacktickIdent)
        );
        const connection = await this.open();
        await connection.query(text);
    }

    private dialect(namespace: string | null, relation: string) {
        return {
            quote: quoteBacktickIdent,
            placeholder: () => "?",
            target: quoteQualified([namespace, relation], quoteBacktickIdent)
        };
    }

    async close(): Promise<void> {
        const connection = this.connection;
        this.connection = null;
        if (connection) await connection.end().catch(() => undefined);
    }
}

/** The callback connection under mysql2's promise wrapper, which is the one that
 *  streams rows as events. Untyped in mysql2's declarations, present at runtime. */
function callbackOf(connection: mysql.Connection): CallbackConnection {
    return (connection as unknown as { connection: CallbackConnection }).connection;
}

interface CappedResult {
    readonly columns: string[];
    readonly rows: unknown[][];
    readonly affected: number | null;
    readonly truncated: boolean;
}

/**
 * Run one statement and keep at most `MAX_STATEMENT_ROWS` of its rows, reading
 * past the rest rather than holding them. `timeout` makes mysql2 give up on a
 * statement that runs too long; the connection is closed after the call either
 * way.
 */
function capped(connection: CallbackConnection, sql: string): Promise<CappedResult> {
    return new Promise((resolve, reject) => {
        const rows: unknown[][] = [];
        let columns: string[] = [];
        let affected: number | null = null;
        let truncated = false;
        connection
            .query({ sql, rowsAsArray: true, timeout: data.STATEMENT_TIMEOUT_MS })
            .on("error", reject)
            .on("fields", (fields: FieldPacket[]) => {
                columns = fields.map((field) => field.name);
            })
            .on("result", (row: unknown) => {
                if (Array.isArray(row)) {
                    if (rows.length < data.MAX_STATEMENT_ROWS) rows.push(row);
                    else truncated = true;
                    return;
                }
                const header = row as ResultSetHeader;
                if (typeof header.affectedRows === "number") affected = header.affectedRows;
            })
            .on("end", () => resolve({ columns, rows, affected, truncated }));
    });
}
