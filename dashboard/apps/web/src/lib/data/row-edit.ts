/**
 * Adding a row, removing rows and creating a table, as statements that can only
 * do that.
 *
 * The same discipline as `cell-edit.ts`, and shared by both SQL drivers for the
 * same reason: the statement is decided once, here, purely, so what a request
 * turns into can be read in a test beside the request.
 *
 * - **Values are bound, never spliced.** A row's values travel as parameters and
 *   the engine reads each against its column's type.
 * - **Names are checked, then quoted.** A column of an existing table has to be
 *   one the driver just read from the catalogue; a name for a new table or column
 *   has to be a plain identifier, and is quoted anyway.
 * - **Rows are removed by their whole primary key and nothing else.** A WHERE made
 *   of whatever was on screen removes every row that looks the same.
 * - **A new table's types and defaults come from a fixed list.** DDL cannot take a
 *   parameter, so nothing typed reaches it as SQL: a type is picked from
 *   `TABLE_TYPES`, a default is either a value (quoted as a literal, after the
 *   characters that could escape a literal are refused) or one of the expressions
 *   in `DEFAULT_EXPRESSIONS`.
 */

import * as data from "./driver";
import type { SqlDialect } from "./cell-edit";

/** The two SQL dialects the browser writes. MariaDB is MySQL here. */
export type SqlFlavor = "postgres" | "mysql";

/** One new row: the columns given a value. A column left out takes its default. */
export interface RowInsert {
    readonly namespace: string | null;
    readonly relation: string;
    /** Null is SQL NULL; a string is bound as a parameter. */
    readonly values: Readonly<Record<string, string | null>>;
}

/** Rows to remove, each named by its whole primary key. */
export interface RowDelete {
    readonly namespace: string | null;
    readonly relation: string;
    readonly keys: readonly Readonly<Record<string, unknown>>[];
}

export interface RowWriteResult {
    readonly changed: number;
}

/** A column's type, as the form offers it. */
export const TABLE_TYPES = [
    "text",
    "varchar",
    "integer",
    "bigint",
    "serial",
    "bigserial",
    "decimal",
    "double",
    "boolean",
    "date",
    "timestamp",
    "timestamptz",
    "uuid",
    "json",
    "bytes"
] as const;

export type TableType = (typeof TABLE_TYPES)[number];

/** What each offered type is called by each engine. */
const TYPE_SQL: Readonly<Record<TableType, Readonly<Record<SqlFlavor, string>>>> = {
    text: { postgres: "TEXT", mysql: "TEXT" },
    varchar: { postgres: "VARCHAR(255)", mysql: "VARCHAR(255)" },
    integer: { postgres: "INTEGER", mysql: "INT" },
    bigint: { postgres: "BIGINT", mysql: "BIGINT" },
    serial: { postgres: "SERIAL", mysql: "INT AUTO_INCREMENT" },
    bigserial: { postgres: "BIGSERIAL", mysql: "BIGINT AUTO_INCREMENT" },
    decimal: { postgres: "NUMERIC", mysql: "DECIMAL(20,6)" },
    double: { postgres: "DOUBLE PRECISION", mysql: "DOUBLE" },
    boolean: { postgres: "BOOLEAN", mysql: "BOOLEAN" },
    date: { postgres: "DATE", mysql: "DATE" },
    timestamp: { postgres: "TIMESTAMP", mysql: "DATETIME" },
    timestamptz: { postgres: "TIMESTAMPTZ", mysql: "TIMESTAMP" },
    uuid: { postgres: "UUID", mysql: "CHAR(36)" },
    json: { postgres: "JSONB", mysql: "JSON" },
    bytes: { postgres: "BYTEA", mysql: "BLOB" }
};

/** Types whose default, when typed as a value, has to read as a number. */
const NUMERIC_TYPES: ReadonlySet<TableType> = new Set(["integer", "bigint", "decimal", "double"]);

/** Types numbered by the engine, which take no default of their own. */
const AUTO_TYPES: ReadonlySet<TableType> = new Set(["serial", "bigserial"]);

/** The default expressions the form offers, by engine. */
export const DEFAULT_EXPRESSIONS = ["now", "uuid"] as const;

export type DefaultExpression = (typeof DEFAULT_EXPRESSIONS)[number];

const EXPRESSION_SQL: Readonly<Record<DefaultExpression, Readonly<Record<SqlFlavor, string>>>> = {
    now: { postgres: "now()", mysql: "CURRENT_TIMESTAMP" },
    // gen_random_uuid() is built in from PostgreSQL 13; MySQL takes an
    // expression default in parentheses from 8.0.13, MariaDB from 10.2.
    uuid: { postgres: "gen_random_uuid()", mysql: "(UUID())" }
};

/** Which types each expression makes sense on, so `now` cannot land on a number. */
const EXPRESSION_TYPES: Readonly<Record<DefaultExpression, ReadonlySet<TableType>>> = {
    now: new Set(["timestamp", "timestamptz", "date"]),
    uuid: new Set(["uuid", "varchar", "text"])
};

/** The default expressions that fit a column of this type, for the form. */
export function expressionsFor(type: TableType): DefaultExpression[] {
    return DEFAULT_EXPRESSIONS.filter((expression) => EXPRESSION_TYPES[expression].has(type));
}

/** True for a type the engine numbers by itself, which takes no default. */
export function isAutoType(type: TableType): boolean {
    return AUTO_TYPES.has(type);
}

export type ColumnDefault =
    | { readonly kind: "none" }
    | { readonly kind: "value"; readonly value: string }
    | { readonly kind: "expression"; readonly expression: DefaultExpression };

export interface ColumnDraft {
    readonly name: string;
    readonly type: TableType;
    readonly nullable: boolean;
    readonly primaryKey: boolean;
    readonly unique: boolean;
    readonly defaultValue: ColumnDefault;
}

export interface TableDraft {
    readonly namespace: string | null;
    readonly name: string;
    readonly columns: readonly ColumnDraft[];
}

/** How many columns one new table may be given here, and how many rows one
 *  delete may name. Past these it is a migration, and belongs in one. */
export const MAX_NEW_COLUMNS = 100;
export const MAX_DELETE_ROWS = 200;

/** A plain identifier: what a name has to be before it is quoted into DDL. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** True when `name` can name a new table or column. */
export function isPlainIdentifier(name: string): boolean {
    return IDENTIFIER.test(name);
}

/**
 * A typed default as a literal, or a refusal.
 *
 * A backslash, a control character or anything past 200 characters is refused
 * rather than escaped: with those gone, doubling the single quote is the whole of
 * the escaping on either engine and whatever setting the server runs with
 * (`standard_conforming_strings`, `NO_BACKSLASH_ESCAPES`), so the literal cannot
 * be read two ways.
 */
export function defaultLiteral(type: TableType, value: string): string {
    if (value.length > 200)
        throw new data.DataRequestError("A default can be at most 200 characters.");
    // eslint-disable-next-line no-control-regex
    if (/[\\\u0000-\u001f\u007f]/.test(value)) {
        throw new data.DataRequestError("A default cannot hold a backslash or a line break.");
    }
    if (NUMERIC_TYPES.has(type)) {
        if (!/^-?\d+(\.\d+)?$/.test(value))
            throw new data.DataRequestError("That default has to be a number.");
        return value;
    }
    if (type === "boolean") {
        const lowered = value.toLowerCase();
        if (lowered !== "true" && lowered !== "false") {
            throw new data.DataRequestError("A yes/no column takes true or false as its default.");
        }
        return lowered.toUpperCase();
    }
    return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The CREATE TABLE for a draft, or a refusal.
 *
 * Throws rather than returning a flag, as `prepareCellEdit` does: every refusal
 * here is a statement that must not be sent.
 */
export function prepareCreateTable(
    draft: TableDraft,
    flavor: SqlFlavor,
    quote: (name: string) => string,
    qualify: (namespace: string | null, name: string) => string
): string {
    if (!isPlainIdentifier(draft.name)) {
        throw new data.DataRequestError(
            "A table name starts with a letter or an underscore and holds only letters, digits and underscores."
        );
    }
    if (draft.columns.length === 0)
        throw new data.DataRequestError("Give the table at least one column.");
    if (draft.columns.length > MAX_NEW_COLUMNS) {
        throw new data.DataRequestError(
            `A table made here can have at most ${MAX_NEW_COLUMNS} columns.`
        );
    }

    const seen = new Set<string>();
    const lines: string[] = [];
    const keys: string[] = [];
    for (const column of draft.columns) {
        if (!isPlainIdentifier(column.name)) {
            throw new data.DataRequestError(
                `"${column.name.slice(0, 64)}" cannot be a column name: letters, digits and underscores, starting with a letter.`
            );
        }
        const folded = column.name.toLowerCase();
        if (seen.has(folded))
            throw new data.DataRequestError(`There are two columns called ${column.name}.`);
        seen.add(folded);
        if (!(TABLE_TYPES as readonly string[]).includes(column.type)) {
            throw new data.DataRequestError(`Pick a type for ${column.name}.`);
        }
        const auto = AUTO_TYPES.has(column.type);
        if (auto && !column.primaryKey) {
            throw new data.DataRequestError(
                `${column.name} is numbered automatically, so it has to be the primary key.`
            );
        }

        const parts = [quote(column.name), TYPE_SQL[column.type][flavor]];
        if (column.primaryKey) keys.push(quote(column.name));
        // A key column is never null, whatever the box said.
        if (!column.nullable || column.primaryKey) parts.push("NOT NULL");
        if (column.unique && !column.primaryKey) parts.push("UNIQUE");

        const fallback = column.defaultValue;
        if (fallback.kind !== "none" && auto) {
            throw new data.DataRequestError(
                `${column.name} is numbered automatically and takes no default.`
            );
        }
        if (fallback.kind === "value") {
            parts.push(`DEFAULT ${defaultLiteral(column.type, fallback.value)}`);
        } else if (fallback.kind === "expression") {
            if (!(DEFAULT_EXPRESSIONS as readonly string[]).includes(fallback.expression)) {
                throw new data.DataRequestError("That default is not one Polaris offers.");
            }
            if (!EXPRESSION_TYPES[fallback.expression].has(column.type)) {
                throw new data.DataRequestError(
                    `That default does not fit the type of ${column.name}.`
                );
            }
            parts.push(`DEFAULT ${EXPRESSION_SQL[fallback.expression][flavor]}`);
        }
        lines.push(parts.join(" "));
    }
    if (keys.length > 0) lines.push(`PRIMARY KEY (${keys.join(", ")})`);
    return `CREATE TABLE ${qualify(draft.namespace, draft.name)} (${lines.join(", ")})`;
}

/**
 * The INSERT for one row, against the columns the table actually has.
 *
 * A column left out is not mentioned, so it takes its default - which is what an
 * auto-numbered key needs, and what "I did not fill that in" means.
 */
export function prepareInsert(
    insert: RowInsert,
    columns: readonly data.DataColumn[],
    dialect: SqlDialect,
    flavor: SqlFlavor
): { text: string; params: unknown[] } {
    const names = Object.keys(insert.values);
    const params: unknown[] = [];
    const quoted: string[] = [];
    for (const name of names) {
        const column = columns.find((entry) => entry.name === name);
        if (!column)
            throw new data.DataRequestError(`There is no column called ${name.slice(0, 64)}.`);
        const value = insert.values[name] ?? null;
        if (value === null && !column.nullable)
            throw new data.DataRequestError(`${column.name} cannot be empty.`);
        params.push(value);
        quoted.push(dialect.quote(column.name));
    }
    if (quoted.length === 0) {
        return {
            text:
                flavor === "postgres"
                    ? `INSERT INTO ${dialect.target} DEFAULT VALUES`
                    : `INSERT INTO ${dialect.target} () VALUES ()`,
            params
        };
    }
    const placeholders = params.map((_value, index) => dialect.placeholder(index + 1));
    return {
        text: `INSERT INTO ${dialect.target} (${quoted.join(", ")}) VALUES (${placeholders.join(", ")})`,
        params
    };
}

/**
 * The DELETE for the named rows, each by its whole primary key.
 *
 * Refused on a table with no primary key, on a key missing a column, and past
 * `MAX_DELETE_ROWS` - each of those is a WHERE that could reach rows nobody
 * picked.
 */
export function prepareDelete(
    removal: RowDelete,
    columns: readonly data.DataColumn[],
    dialect: SqlDialect
): { text: string; params: unknown[] } {
    const keyColumns = columns.filter((column) => column.primaryKey);
    if (keyColumns.length === 0) {
        throw new data.DataRequestError(
            "This table has no primary key, so there is no way to remove one row of it without risking the others. Use the statement box."
        );
    }
    if (removal.keys.length === 0) throw new data.DataRequestError("Pick the rows to remove.");
    if (removal.keys.length > MAX_DELETE_ROWS) {
        throw new data.DataRequestError(
            `Remove at most ${MAX_DELETE_ROWS} rows at a time from here.`
        );
    }
    const params: unknown[] = [];
    const groups = removal.keys.map((key) => {
        const conditions = keyColumns.map((column) => {
            if (!(column.name in key)) {
                throw new data.DataRequestError(
                    "That row cannot be identified - the page it came from did not carry its whole primary key."
                );
            }
            params.push(key[column.name]);
            return `${dialect.quote(column.name)} = ${dialect.placeholder(params.length)}`;
        });
        return `(${conditions.join(" AND ")})`;
    });
    return { text: `DELETE FROM ${dialect.target} WHERE ${groups.join(" OR ")}`, params };
}
