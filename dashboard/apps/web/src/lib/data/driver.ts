/**
 * What a database looks like to the browser, whichever engine it is.
 *
 * One contract over five engines, deliberately narrow. Everything the screens do
 * is here - what is in it, what is in that, a page of rows, and a statement
 * somebody typed - and nothing else is, because every method added has to be
 * answered five times and answered honestly. An engine that cannot do one of
 * them says so through `shape` rather than by throwing at the point somebody
 * pressed the button.
 *
 * Three shapes, because a key-value store is not a table with the labels
 * changed and pretending otherwise is how a browser ends up lying about what it
 * is showing. A SQL engine has schemas, tables and columns; a document store has
 * databases and collections whose fields differ row to row; a key-value store
 * has numbered databases and keys with types. The screens branch on this once,
 * at the top, rather than each control guessing.
 *
 * Connections are opened for one call and closed after it. A pool held across
 * requests would be faster and would also mean a credential that was revoked, a
 * container that was replaced, or a session somebody ended still had a live
 * socket into somebody's database - which is the wrong trade for a tool that
 * exists to be pointed at production.
 */

import type { DbEngine } from "@polaris/core";

/** The engines the browser can open. The same set Polaris can provision, which
 *  is not a coincidence: a database Polaris made is the first thing anybody
 *  points this at. */
export type DataEngine = DbEngine;

/** How an engine is browsed, and therefore which screen is drawn for it. */
export type DataShape = "sql" | "document" | "keyvalue";

export const ENGINE_SHAPE: Readonly<Record<DataEngine, DataShape>> = {
    postgres: "sql",
    mysql: "sql",
    mariadb: "sql",
    mongo: "document",
    redis: "keyvalue"
};

/** Everything needed to reach one database, already resolved from wherever it
 *  was stored. Never logged, never returned to a browser. */
export interface DataAddress {
    readonly engine: DataEngine;
    readonly host: string;
    readonly port: number;
    /** The database to open on connect. A SQL engine needs one; Redis takes a
     *  number and Mongo can be told later. */
    readonly database?: string | null;
    readonly username?: string | null;
    readonly password?: string | null;
    /**
     * The database an account is defined in, when it is not the one being
     * opened. MongoDB only, where it is the difference between signing in and
     * being told the password is wrong: a database Polaris provisions has its
     * user inside that database, and an account somebody made by hand almost
     * always lives in `admin`, which is what the driver falls back to when this
     * is absent.
     */
    readonly authSource?: string | null;
    readonly tls: boolean;
    /** Refuses anything that would write. Enforced by the driver, not by the
     *  screen: a statement box is a statement box. */
    readonly readOnly: boolean;
}

/** A container of things: a schema, a database, a numbered Redis keyspace. */
export interface DataNamespace {
    readonly name: string;
    /** What to call it on screen, in this engine's own words. */
    readonly kind: "schema" | "database" | "keyspace";
    /** How many things are in it, when the engine says so cheaply. */
    readonly count?: number | null;
}

/** A thing rows are read from. */
export interface DataRelation {
    readonly name: string;
    readonly namespace: string | null;
    readonly kind: "table" | "view" | "collection" | "keys";
    /** An estimate, when the engine keeps one. Never a count(*) over a table
     *  nobody asked to count - that is a full scan somebody did not ask for. */
    readonly rows: number | null;
}

export interface DataColumn {
    readonly name: string;
    readonly type: string;
    readonly nullable: boolean;
    readonly primaryKey: boolean;
}

/** One page of rows, with the columns they were read under. */
export interface DataPage {
    readonly columns: readonly DataColumn[];
    readonly rows: readonly Record<string, unknown>[];
    /** The total the page came out of, when it is known without a scan. */
    readonly total: number | null;
    /** A cursor for the next page, for an engine that pages by cursor rather
     *  than by offset (Redis). */
    readonly cursor?: string | null;
}

export interface RowQuery {
    readonly limit: number;
    readonly offset: number;
    /** A column to order by. Validated against the relation's own columns before
     *  it reaches a statement - it is an identifier, and identifiers cannot be
     *  parameters. */
    readonly orderBy?: string | null;
    readonly descending?: boolean;
    /** A substring somebody typed. Applied by the driver in the way that engine
     *  can do cheaply, or ignored when it cannot. */
    readonly filter?: string | null;
    /** Where to resume, for a cursor-paged engine. */
    readonly cursor?: string | null;
}

/** What running a statement answered. One entry per statement, because one box
 *  can hold several. */
export interface QueryResult {
    readonly statement: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly unknown[])[];
    /** Rows changed, for a statement that changed some. Null for a read. */
    readonly affected: number | null;
    readonly ms: number;
    /** Anything the engine said that is not rows - a notice, a truncation. */
    readonly note?: string;
}

export interface DataDriver {
    readonly shape: DataShape;
    /** The engine's own version string, which doubles as the connection test. */
    version(): Promise<string>;
    namespaces(): Promise<DataNamespace[]>;
    relations(namespace: string | null): Promise<DataRelation[]>;
    columns(namespace: string | null, relation: string): Promise<DataColumn[]>;
    rows(namespace: string | null, relation: string, query: RowQuery): Promise<DataPage>;
    /** Whatever somebody typed. Refused in its entirety when the connection is
     *  read-only and any of it writes. */
    run(statement: string): Promise<QueryResult[]>;
    close(): Promise<void>;
}

/** How many rows a page holds unless somebody says otherwise. A screenful of a
 *  wide table, and small enough that a mistyped filter is not a download. */
export const PAGE_ROWS = 100;

/** The hard ceiling on one page, whatever is asked for. */
export const MAX_ROWS = 1000;

/** Refused because the connection is read-only. Its own class so a screen can
 *  say the one useful thing about it rather than printing an engine's error. */
export class ReadOnlyError extends Error {
    constructor(what: string) {
        super(`This connection is read-only, and ${what} would change the database. Turn read-only off on the connection if you meant to.`);
        this.name = "ReadOnlyError";
    }
}

/** Refused before it was sent: a name that cannot be an identifier, a limit
 *  outside what the browser will ask for. */
export class DataRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DataRequestError";
    }
}

/** The page size to actually use for a request that asked for one. */
export function pageSize(asked: number | undefined): number {
    if (!asked || !Number.isFinite(asked)) return PAGE_ROWS;
    return Math.min(MAX_ROWS, Math.max(1, Math.floor(asked)));
}
