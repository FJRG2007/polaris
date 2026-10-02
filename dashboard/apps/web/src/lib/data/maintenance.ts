/**
 * The administrative statements a database's Stats and Config screens offer:
 * vacuuming one table, and installing or removing a PostgreSQL extension.
 *
 * None of them take SQL from a browser. A table is named by schema and name,
 * looked up in `pg_stat_user_tables` with both as parameters, and only then
 * quoted into the VACUUM. An extension has to be one the server itself lists in
 * `pg_available_extensions` (or, to remove it, in `pg_extension`), and is quoted
 * as an identifier. A removal never cascades: an extension something else
 * depends on is refused by the engine, which is the answer to give.
 *
 * Callers authorize, open a writable address and record the audit entry. The
 * statements run through a `Run`, so the checks can be read in a test, and every
 * value is bound as a parameter - only a name already found in the catalogue is
 * quoted into a statement.
 *
 * Server-only.
 */

import type { Run } from "./health";
import { DataRequestError } from "./driver";
import { quoteQualified, quoteSqlIdent } from "@polaris/core";

export interface ExtensionView {
    readonly name: string;
    readonly defaultVersion: string | null;
    readonly installedVersion: string | null;
    readonly comment: string | null;
}

/** Extensions Polaris will not remove from here: the database itself needs them. */
const KEPT_EXTENSIONS = new Set(["plpgsql"]);

/** How many extensions a list holds at most. A stock image ships about sixty. */
const EXTENSION_LIMIT = 500;

function rowsOf(results: Awaited<ReturnType<Run>>): Record<string, unknown>[] {
    const result = results[0];
    if (!result) return [];
    return result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
}

/** What the server ships and what is installed in this database. */
export async function listExtensions(run: Run): Promise<ExtensionView[]> {
    return rowsOf(
        await run(
            `SELECT name, default_version, installed_version, comment
               FROM pg_available_extensions ORDER BY name LIMIT ${EXTENSION_LIMIT}`
        )
    ).map((row) => ({
        name: String(row.name ?? ""),
        defaultVersion: row.default_version === null ? null : String(row.default_version ?? ""),
        installedVersion: row.installed_version === null || row.installed_version === undefined ? null : String(row.installed_version),
        comment: row.comment === null || row.comment === undefined ? null : String(row.comment)
    }));
}

/**
 * Install an extension the server ships.
 *
 * The name is matched against the server's own list first - the statement box is
 * where an arbitrary CREATE EXTENSION belongs, not this button.
 */
export async function installExtension(run: Run, name: string): Promise<void> {
    const known = rowsOf(
        await run("SELECT name FROM pg_available_extensions WHERE name = $1", [name])
    );
    if (known.length !== 1) throw new DataRequestError("This server does not ship that extension.");
    await run(`CREATE EXTENSION IF NOT EXISTS ${quoteSqlIdent(name)}`);
}

/** Remove an installed extension, never with CASCADE. */
export async function uninstallExtension(run: Run, name: string): Promise<void> {
    if (KEPT_EXTENSIONS.has(name)) throw new DataRequestError("That extension is part of the database and stays.");
    const known = rowsOf(await run("SELECT extname FROM pg_extension WHERE extname = $1", [name]));
    if (known.length !== 1) throw new DataRequestError("That extension is not installed here.");
    await run(`DROP EXTENSION IF EXISTS ${quoteSqlIdent(name)}`);
}

/**
 * VACUUM (ANALYZE) one table this database holds.
 *
 * Not FULL: a plain vacuum runs beside reads and writes, where FULL locks the
 * table for as long as it takes to rewrite it.
 */
export async function vacuumTable(run: Run, schema: string, table: string): Promise<void> {
    const known = rowsOf(
        await run(
            "SELECT relname FROM pg_stat_user_tables WHERE schemaname = $1 AND relname = $2",
            [schema, table]
        )
    );
    if (known.length !== 1) throw new DataRequestError("There is nothing here by that name.");
    await run(`VACUUM (ANALYZE) ${quoteQualified([schema, table], quoteSqlIdent)}`);
}
