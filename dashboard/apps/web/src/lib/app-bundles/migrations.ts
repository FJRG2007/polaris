/**
 * An app's own tables, set up by the host from SQL the app ships in its bundle.
 *
 * An app that keeps data needs no dashboard release for its tables: they live in
 * a Postgres schema of its own (`app_<id>`), created and migrated here when the
 * app is installed or its bundle changes, never in the core Prisma schema. The
 * technique is the one Odoo modules (per-module data migrations run on module
 * upgrade, tracked per module), Directus extensions and Strapi plugins (each
 * plugin's migrations recorded in its own table) and PocketBase (ordered,
 * forward-only migration files with an applied-migrations table) converged on.
 *
 * The bundle carries them as an asset folder: `polaris.assets.migrations`
 * pointing at the app's `migrations/` folder, each file `NNNN_name.sql`, applied
 * in name order. The rules, checked before anything runs:
 *
 * - forward-only: an applied migration is never run again, and one whose text
 *   changed after it was applied stops the app instead of being skipped;
 * - additive: no DROP, TRUNCATE, RENAME or DELETE without WHERE - data is never
 *   taken away by an update;
 * - its own schema only: a statement naming any other schema (`public.`, a
 *   quoted one), or changing the search path, role or grants, is refused;
 * - all of a run in one transaction under an advisory lock keyed to the app, so
 *   a failure leaves nothing half-applied and two servers installing at once
 *   apply each migration exactly once.
 *
 * Server-only.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { BundleUnavailable } from "./store";
import { readdir, readFile } from "node:fs/promises";

/** What a run needs from the database: one transaction, raw statements in it. */
export interface MigrationTx {
    execute(sql: string, ...params: unknown[]): Promise<unknown>;
    query<T>(sql: string, ...params: unknown[]): Promise<T[]>;
}

export interface MigrationDb {
    transaction<T>(work: (tx: MigrationTx) => Promise<T>): Promise<T>;
}

export interface AppMigration {
    readonly name: string;
    readonly sql: string;
    readonly sha256: string;
}

/** A migration that could not be applied; the app stays off with this as its reason. */
export class AppMigrationFailed extends BundleUnavailable {}

const NAME = /^\d{4}_[a-z0-9_]{1,60}\.sql$/;
const APP_ID = /^[a-z][a-z0-9-]{1,47}$/;

/** The schema an app's tables live in. */
export function appSchema(id: string): string {
    if (!APP_ID.test(id)) throw new AppMigrationFailed(`"${id}" is not an app id.`);
    return `app_${id.replace(/-/g, "_")}`;
}

/** Comments and string literals blanked, so the checks read only what runs. */
function codeOf(sql: string): string {
    return sql
        .replace(/--[^\n]*/g, " ")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/gi, "''");
}

const REFUSED: readonly [RegExp, string][] = [
    [/\bdrop\b/i, "drops something"],
    [/\btruncate\b/i, "empties a table"],
    [/\brename\b/i, "renames something"],
    [/\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i, "deletes rows without a WHERE"],
    [/\bsearch_path\b/i, "changes the search path"],
    [/\b(set\s+role|set\s+session\s+authorization|grant|revoke|alter\s+(role|user|system|default\s+privileges))\b/i, "changes roles or grants"],
    [/\b(create|alter)\s+(extension|database|role|user|schema|publication|subscription)\b/i, "changes the database outside its schema"],
    [/\bcopy\b[\s\S]*\b(from|to)\s+program\b/i, "runs a program"]
];

/**
 * Why `sql` may not run as a migration of `id`, or null when it may. Every
 * schema-qualified name must be the app's own; an unqualified one resolves to
 * it, because the run sets the search path to that schema alone.
 */
export function migrationRefusal(id: string, sql: string): string | null {
    const code = codeOf(sql);
    for (const [pattern, why] of REFUSED) if (pattern.test(code)) return `it ${why}`;
    const own = appSchema(id);
    // A name after a word that takes a relation: `public.users`, `"other".t`.
    const named = /\b(?:from|join|into|update|table|references|on|view|sequence|type|function|trigger|index|exists)\s+("?)([a-z_][a-z0-9_$]*)\1\s*\.\s*"?[a-z_]/gi;
    for (const match of code.matchAll(named)) {
        const schema = (match[2] ?? "").toLowerCase();
        if (schema !== own) return `it names the schema "${schema}", which is not the app's`;
    }
    return null;
}

/**
 * The statements of a migration, split on the semicolons that end them: one
 * statement per call, since a prepared statement takes only one. Semicolons
 * inside quotes, comments and dollar-quoted bodies do not split.
 */
export function splitStatements(sql: string): string[] {
    const statements: string[] = [];
    let start = 0;
    let index = 0;
    while (index < sql.length) {
        const rest = sql.slice(index);
        const skip =
            /^--[^\n]*/.exec(rest) ??
            /^\/\*[\s\S]*?\*\//.exec(rest) ??
            /^'(?:[^']|'')*'/.exec(rest) ??
            /^"(?:[^"]|"")*"/.exec(rest) ??
            /^\$([a-z_]*)\$[\s\S]*?\$\1\$/i.exec(rest);
        if (skip) {
            index += skip[0].length;
            continue;
        }
        if (sql[index] === ";") {
            statements.push(sql.slice(start, index));
            start = index + 1;
        }
        index += 1;
    }
    statements.push(sql.slice(start));
    return statements.map((statement) => statement.trim()).filter((statement) => codeOf(statement).trim().length > 0);
}

/** The migrations in a bundle folder, in the order they apply. */
export async function bundleMigrations(dir: string): Promise<AppMigration[]> {
    const folder = join(dir, "assets", "migrations");
    let names: string[];
    try {
        names = (await readdir(folder)).filter((name) => name.endsWith(".sql")).sort();
    } catch {
        return [];
    }
    const migrations: AppMigration[] = [];
    for (const name of names) {
        if (!NAME.test(name)) throw new AppMigrationFailed(`Its data migration "${name}" is not named NNNN_name.sql.`);
        const sql = await readFile(join(folder, name), "utf8");
        migrations.push({ name, sql, sha256: createHash("sha256").update(sql).digest("hex") });
    }
    return migrations;
}

/**
 * Apply what of `migrations` this database has not had yet, for app `id`.
 * Returns the names applied now. Throws `AppMigrationFailed`, with a sentence
 * for the screen, when one is refused or fails; nothing of the run is kept.
 */
export async function applyAppMigrations(
    db: MigrationDb,
    id: string,
    migrations: readonly AppMigration[]
): Promise<string[]> {
    if (migrations.length === 0) return [];
    const schema = appSchema(id);
    for (const migration of migrations) {
        const refusal = migrationRefusal(id, migration.sql);
        if (refusal) throw new AppMigrationFailed(`Its data could not be set up: ${migration.name} was refused because ${refusal}.`);
    }
    const ordered = [...migrations].sort((left, right) => left.name.localeCompare(right.name));
    try {
        return await db.transaction(async (tx) => {
            // Held to the end of the transaction: a second server waits here, then sees what this one applied.
            await tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", `polaris.app-migrations.${id}`);
            await tx.execute(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
            await tx.execute(
                `CREATE TABLE IF NOT EXISTS "${schema}"."_polaris_migrations" (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`
            );
            const applied = new Map(
                (await tx.query<{ name: string; sha256: string }>(`SELECT name, sha256 FROM "${schema}"."_polaris_migrations"`)).map(
                    (row) => [row.name, row.sha256]
                )
            );
            const done: string[] = [];
            for (const migration of ordered) {
                const before = applied.get(migration.name);
                if (before === migration.sha256) continue;
                if (before !== undefined) {
                    throw new AppMigrationFailed(
                        `Its data could not be set up: ${migration.name} changed after it was applied, and applied migrations are never run again.`
                    );
                }
                await tx.execute(`SET LOCAL search_path TO "${schema}"`);
                try {
                    for (const statement of splitStatements(migration.sql)) await tx.execute(statement);
                } catch (error) {
                    console.error(`polaris: ${id} migration ${migration.name} failed:`, error);
                    throw new AppMigrationFailed(`Its data could not be set up: ${migration.name} failed, and nothing of this update was kept.`);
                }
                await tx.execute(`INSERT INTO "${schema}"."_polaris_migrations" (name, sha256) VALUES ($1, $2)`, migration.name, migration.sha256);
                done.push(migration.name);
            }
            return done;
        });
    } catch (error) {
        if (error instanceof AppMigrationFailed) throw error;
        console.error(`polaris: ${id} migrations could not run:`, error);
        throw new AppMigrationFailed("Its data could not be set up: the database did not answer. It is tried again on its own.");
    }
}

/** The dashboard's own database, as a run reads it. */
export async function hostMigrationDb(): Promise<MigrationDb> {
    const { prisma } = await import("@polaris/db");
    return {
        transaction: (work) =>
            prisma.$transaction(
                (tx) =>
                    work({
                        execute: (sql, ...params) => tx.$executeRawUnsafe(sql, ...params),
                        query: <T>(sql: string, ...params: unknown[]) => tx.$queryRawUnsafe<T[]>(sql, ...params)
                    }),
                { timeout: 120_000, maxWait: 60_000 }
            )
    };
}

/**
 * The client an app reads and writes its own tables through: every statement in
 * a transaction whose search path is the app's schema alone, parameters bound,
 * never string-built. Users and permissions stay behind the host APIs.
 */
export function appDatabase(id: string, db?: MigrationDb) {
    const schema = appSchema(id);
    const within = async <T>(work: (tx: MigrationTx) => Promise<T>): Promise<T> =>
        (db ?? (await hostMigrationDb())).transaction(async (tx) => {
            await tx.execute(`SET LOCAL search_path TO "${schema}"`);
            return work(tx);
        });
    return {
        schema,
        query: <T>(sql: string, ...params: unknown[]) => within((tx) => tx.query<T>(sql, ...params)),
        execute: (sql: string, ...params: unknown[]) => within((tx) => tx.execute(sql, ...params)),
        transaction: within
    };
}
