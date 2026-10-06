/**
 * The Databases app, as tools an assistant can call.
 *
 * Every database is opened through the app's own resolver (`addressOf`), the
 * one place that decides whether this account may open a connection at all -
 * one it saved, one Polaris runs in a project it owns, or Polaris' own for
 * whoever runs the instance - and the one place a password is decrypted. These
 * tools never see a connection id as a permission, and never hand back an
 * address, a login or a password: the model is told a database's name, its
 * engine and what is in it.
 *
 * Four tools on two scopes. `databases.read` lists what may be opened, reads
 * what is in one, and runs a statement on an address forced read-only - so the
 * engine's own read-only transaction refuses a write (Postgres and MySQL; the
 * document and key-value engines refuse by their command lists, as the app
 * does), not a guess at what the statement says. `databases.write` runs a
 * statement on the connection as it is, so a connection somebody marked
 * read-only stays read-only here too.
 *
 * A connected app reaches only the databases its person let it (the grant's
 * `databaseIds`, read on every call), and a database outside that is refused
 * in the same words whether or not it exists.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import type { DataConnectionView } from "@/lib/data/connections";
import { reachesDatabase } from "../oauth/database-reach";
import { defineMcpSearch, preferMatches } from "../search";
import { McpRefusal, defineMcpTool, type McpCaller, type McpTool } from "../protocol";

/**
 * The database services, loaded when a tool runs rather than when the
 * catalogue does: the connection store reaches every engine's client, and
 * listing tools should not load four database drivers.
 */
async function services() {
    const [connections, browser, open, driver] = await Promise.all([
        import("@/lib/data/connections"),
        import("@/lib/data/browser"),
        import("@/lib/data/open"),
        import("@/lib/data/driver")
    ]);
    return { connections, browser, open, driver };
}

/** The rows one statement's answer carries back at most, unless asked for
 *  fewer. The driver itself stops reading at a thousand. */
const ROWS_DEFAULT = 100;
const ROWS_MAX = 500;

/** How much of one value is sent. A column of documents is not something a
 *  model should take in whole, row after row. */
const CELL_MAX = 2000;

/** The longest statement either tool takes. */
const STATEMENT_MAX = 64_000;

const NOT_ALLOWED =
    "This connection is not allowed to reach that database. Its person can allow it under Account > AI assistants.";

/** The account a call acts for, or a refusal. */
async function actorFor(caller: McpCaller): Promise<string> {
    const { actingUser } = await import("../acting-user");
    const user = await actingUser(caller.userId);
    if (!user) throw new McpRefusal("This account cannot use Databases.");
    return user.id;
}

/** Whether the connected app may reach this database at all. Checked before
 *  anything is resolved, so a refused id costs nothing and says nothing. */
function requireReach(caller: McpCaller, databaseId: string): void {
    if (!reachesDatabase(caller.databaseIds, databaseId)) throw new McpRefusal(NOT_ALLOWED);
}

/**
 * SQLSTATE classes whose message is about the statement somebody wrote rather
 * than the connection it went over: data (22), integrity (23), transaction
 * state (25, the read-only refusal among them), rollback (40), syntax and
 * access rules (42), and a statement cancelled for its time (57014).
 * Connection (08) and authentication (28) failures name hosts and accounts,
 * and stay in the log.
 */
const STATEMENT_CLASSES = new Set(["22", "23", "25", "40", "42"]);

/**
 * What an engine said about a statement, when that is what failed - or null,
 * for everything else. Postgres puts the SQLSTATE in `code`, MySQL in
 * `sqlState` with its sentence in `sqlMessage`.
 */
export function statementFailure(caught: unknown): string | null {
    if (!(caught instanceof Error)) return null;
    const fields = caught as Error & { code?: unknown; sqlState?: unknown; sqlMessage?: unknown };
    const state =
        typeof fields.sqlState === "string"
            ? fields.sqlState
            : typeof fields.code === "string"
              ? fields.code
              : "";
    if (!/^[0-9A-Z]{5}$/.test(state)) return null;
    if (!STATEMENT_CLASSES.has(state.slice(0, 2)) && state !== "57014") return null;
    const said = typeof fields.sqlMessage === "string" ? fields.sqlMessage : caught.message;
    return said.slice(0, 500);
}

/**
 * Run the app's own work, passing on what it wrote for a reader - a database
 * that cannot be opened, a name that is not there - and what an engine said
 * about the statement. Anything else describes the connection and goes to the
 * log.
 */
async function attempt<T>(run: () => Promise<T>, readOnlyHint?: string): Promise<T> {
    const { connections, driver } = await services();
    try {
        return await run();
    } catch (caught) {
        if (caught instanceof McpRefusal) throw caught;
        if (caught instanceof driver.ReadOnlyError)
            throw new McpRefusal(readOnlyHint ?? caught.message);
        if (
            caught instanceof connections.DataConnectionError ||
            caught instanceof driver.DataRequestError
        )
            throw new McpRefusal(caught.message);
        const said = statementFailure(caught);
        if (said) throw new McpRefusal(`The database refused it: ${said}`);
        throw caught;
    }
}

/** One value as the model reads it: bytes described, long text shortened. */
function cell(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `(${value.byteLength} bytes)`;
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string")
        return value.length > CELL_MAX ? `${value.slice(0, CELL_MAX)}... (cut)` : value;
    if (typeof value === "object") {
        const text = JSON.stringify(value);
        return text.length > CELL_MAX ? `${text.slice(0, CELL_MAX)}... (cut)` : value;
    }
    return value;
}

interface StatementResult {
    readonly statement: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly unknown[])[];
    readonly affected: number | null;
    readonly ms: number;
    readonly note?: string;
}

/** A statement's answers, cut to what a model should read, in text and as
 *  structured content. */
function answered(results: readonly StatementResult[], maxRows: number) {
    const shaped = results.map((result) => {
        const truncated = result.rows.length > maxRows || Boolean(result.note);
        return {
            statement: result.statement.slice(0, 200),
            columns: [...result.columns],
            rows: result.rows.slice(0, maxRows).map((row) => row.map(cell)),
            affected: result.affected,
            ms: result.ms,
            truncated
        };
    });
    const text = shaped
        .map((result) => {
            if (result.affected !== null && result.columns.length === 0)
                return `${result.affected} ${result.affected === 1 ? "row" : "rows"} changed.`;
            if (result.columns.length === 0) return "Done.";
            const lines = [
                result.columns.join("\t"),
                ...result.rows.map((row) =>
                    row
                        .map((value) =>
                            value === null
                                ? "NULL"
                                : typeof value === "object"
                                  ? JSON.stringify(value)
                                  : String(value)
                        )
                        .join("\t")
                )
            ];
            const more = result.truncated
                ? `\n(Showing the first ${result.rows.length} rows.)`
                : "";
            return `${lines.join("\n")}${more}`;
        })
        .join("\n\n");
    return { text: text || "No result.", structured: { results: shaped } };
}

const databaseId = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe("The database's id, as databases_list returned it.");

const statement = z.string().trim().min(1).max(STATEMENT_MAX);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const listInput = z.object({
    query: z
        .string()
        .trim()
        .max(100)
        .default("")
        .describe("Only databases whose name, engine or project contains this."),
    engine: z
        .enum(["postgres", "mysql", "mariadb", "mongo", "redis"])
        .optional()
        .describe("Only databases of this engine.")
});

const listTool: McpTool<z.infer<typeof listInput>> = {
    name: "databases_list",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List databases",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The databases this account can open in Polaris - connections it saved, databases Polaris runs in its projects - with each one's engine and whether it is read-only. Never an address or a password. Read-only.",
    input: listInput,
    category: "databases",
    scope: "databases.read",
    readOnly: true,
    async run(input, caller) {
        const userId = await actorFor(caller);
        const { connections } = await services();
        const wanted = input.query.toLowerCase();
        const rows = (await connections.listOpenable(userId))
            .filter((entry) => reachesDatabase(caller.databaseIds, entry.id))
            .filter((entry) => !input.engine || entry.engine === input.engine)
            .map((entry) => ({
                id: entry.id,
                name: entry.name,
                engine: entry.engine,
                origin: entry.origin,
                // A saved connection's `where` is its host and port; only a
                // managed one's (its project and environment) is said.
                project: entry.origin === "managed" ? entry.where : null,
                database: entry.origin === "managed" ? null : entry.database,
                readOnly: entry.readOnly,
                reachable: !entry.unreachable,
                note: entry.unreachable ? entry.note : null
            }))
            .filter(
                (row) =>
                    !wanted ||
                    [row.name, row.engine, row.project ?? "", row.database ?? ""].some((value) =>
                        value.toLowerCase().includes(wanted)
                    )
            );
        if (rows.length === 0) return { text: "No databases.", structured: { databases: [] } };
        return {
            text: rows
                .map(
                    (row) =>
                        `${row.id}  ${row.name} (${row.engine}${row.project ? `, ${row.project}` : ""})${row.readOnly ? " - read-only" : ""}${row.reachable ? "" : " - cannot be reached from here"}`
                )
                .join("\n"),
            structured: { databases: rows }
        };
    }
};

const schemaInput = z.object({
    databaseId,
    namespace: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe(
            "A schema (SQL), database (MongoDB) or keyspace (Redis). Absent opens the one the database is usually worked in."
        ),
    relation: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe("A table or collection in that namespace: answers its columns.")
});

const schemaTool: McpTool<z.infer<typeof schemaInput>> = {
    name: "databases_schema",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Database structure",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "What is inside one database: its schemas and the tables, views or collections in one of them, or, given a relation, that table's columns and types. Read-only.",
    input: schemaInput,
    category: "databases",
    scope: "databases.read",
    readOnly: true,
    async run(input, caller) {
        requireReach(caller, input.databaseId);
        const userId = await actorFor(caller);
        const { connections, browser, open, driver } = await services();
        const address = await attempt(() => connections.addressOf(userId, input.databaseId));
        // Reading the structure writes nothing, and the session says so.
        const reading = { ...address, readOnly: true };
        if (input.relation) {
            const namespace = input.namespace ?? null;
            const relation = input.relation;
            const columns = await attempt(() =>
                open.withDriver(reading, async (opened) => {
                    // A name that goes where no parameter can: it has to be one
                    // the database just listed, as the browser requires.
                    const known = await opened.relations(namespace);
                    if (!known.some((entry) => entry.name === relation))
                        throw new driver.DataRequestError("There is nothing here by that name.");
                    return opened.columns(namespace, relation);
                })
            );
            return {
                text: columns
                    .map(
                        (column) =>
                            `${column.name}  ${column.type}${column.nullable ? "" : " not null"}${column.primaryKey ? " primary key" : ""}`
                    )
                    .join("\n"),
                structured: { namespace, relation, columns }
            };
        }
        const browsed = await attempt(() => browser.browseAt(reading, input.namespace ?? null));
        const lines = [
            `Namespaces: ${browsed.namespaces.map((entry) => entry.name).join(", ") || "none"}`,
            `In ${browsed.namespace ?? "(none)"}:`,
            ...browsed.relations.map(
                (entry) =>
                    `  ${entry.name} (${entry.kind}${entry.rows === null ? "" : `, about ${entry.rows} rows`})`
            )
        ];
        return {
            text: lines.join("\n"),
            structured: {
                shape: browsed.shape,
                namespaces: browsed.namespaces,
                namespace: browsed.namespace,
                relations: browsed.relations
            }
        };
    }
};

const queryInput = z.object({
    databaseId,
    statement: statement.describe(
        "What to run, in the database's own language: SQL, a MongoDB command as JSON, or a Redis command. Several SQL statements may be separated by semicolons."
    ),
    maxRows: z
        .number()
        .int()
        .min(1)
        .max(ROWS_MAX)
        .default(ROWS_DEFAULT)
        .describe("The most rows to read back from each statement.")
});

const queryTool: McpTool<z.infer<typeof queryInput>> = {
    name: "databases_query",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Query a database",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Run a read-only statement on one database and read the rows back. Runs in a read-only session, so anything that would write is refused by the database itself; databases_execute changes data. Each statement stops after 30 seconds.",
    input: queryInput,
    category: "databases",
    scope: "databases.read",
    readOnly: true,
    async run(input, caller) {
        requireReach(caller, input.databaseId);
        const userId = await actorFor(caller);
        const { connections, browser } = await services();
        const address = await attempt(() => connections.addressOf(userId, input.databaseId));
        const results = await attempt(
            () => browser.runAt({ ...address, readOnly: true }, input.statement),
            "databases_query only reads, and that statement would change the database. databases_execute runs it, with the databases.write scope."
        );
        return answered(results, input.maxRows);
    }
};

// ---------------------------------------------------------------------------
// Changing
// ---------------------------------------------------------------------------

const executeInput = z.object({
    databaseId,
    statement: statement.describe(
        "What to run, in the database's own language. Several SQL statements may be separated by semicolons; each runs on its own."
    ),
    maxRows: z
        .number()
        .int()
        .min(1)
        .max(ROWS_MAX)
        .default(ROWS_DEFAULT)
        .describe("The most rows to read back from a statement that returns some.")
});

const executeTool: McpTool<z.infer<typeof executeInput>> = {
    name: "databases_execute",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Change a database",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Run a statement that changes one database - insert, update, delete, create, alter, drop - as the Databases app's statement box does. Takes effect at once and cannot be undone from here: run only what the person asked for. A connection marked read-only still refuses.",
    input: executeInput,
    category: "databases",
    scope: "databases.write",
    readOnly: false,
    destructive: true,
    async run(input, caller) {
        requireReach(caller, input.databaseId);
        const userId = await actorFor(caller);
        const { connections, browser } = await services();
        const address = await attempt(() => connections.addressOf(userId, input.databaseId));
        const results = await attempt(() => browser.runAt(address, input.statement));
        // Which database and how many statements; never the statement, which
        // can carry values nobody meant for the audit trail.
        const { recordAudit } = await import("@/lib/audit-service");
        await recordAudit({
            actorId: userId,
            action: "databases.statement.run",
            targetType: "dataConnection",
            targetId: input.databaseId,
            metadata: {
                via: "mcp",
                statements: results.length,
                ...(caller.grantId ? { grantId: caller.grantId } : {}),
                ...(caller.keyId ? { keyId: caller.keyId } : {})
            }
        });
        return answered(results, input.maxRows);
    }
};

const DATABASE_FIELDS: readonly core.SearchField<DataConnectionView>[] = [
    { text: (entry) => entry.name, weight: 1 },
    { text: (entry) => entry.engine, weight: 0.4 },
    { text: (entry) => (entry.origin === "managed" ? entry.where : null), weight: 0.4 }
];

/**
 * What `polaris_search` finds here: every database this connection may open,
 * with the same reach and the same silence about addresses as databases_list.
 */
export const DATABASE_SEARCH = defineMcpSearch({
    id: "databases.connections",
    app: "databases",
    category: "databases",
    scope: "databases.read",
    async search(query, caller, limit) {
        const userId = await actorFor(caller);
        const { connections } = await services();
        const rows = (await connections.listOpenable(userId)).filter((entry) =>
            reachesDatabase(caller.databaseIds, entry.id)
        );
        return preferMatches(rows, query, DATABASE_FIELDS, limit).map((entry) => ({
            id: entry.id,
            name: entry.name,
            kind: "database",
            where: entry.origin === "managed" ? entry.where : null,
            keywords: [entry.engine],
            next: [
                { tool: "databases_schema", args: { databaseId: entry.id } },
                { tool: "databases_query", args: { databaseId: entry.id } }
            ]
        }));
    }
});

export const DATABASE_TOOLS: readonly McpTool<never>[] = [
    defineMcpTool(listTool),
    defineMcpTool(schemaTool),
    defineMcpTool(queryTool),
    defineMcpTool(executeTool)
];
