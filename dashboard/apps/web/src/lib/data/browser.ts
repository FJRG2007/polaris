/**
 * The reads the screens do, one connection at a time.
 *
 * Between the actions and the drivers because both sides need something the
 * other should not have: the actions must never see an address or a credential,
 * and a driver must never be handed a connection id to resolve for itself. This
 * resolves the one into the other, opens a driver for exactly one call and closes
 * it again.
 *
 * Nothing here is cached. A database browser showing what was true a minute ago
 * is worse than one that takes a moment, and the expensive part of these calls is
 * the query rather than the connection.
 */

import * as data from "./driver";
import { serverDatabases, withDriver, withDriverOn } from "./open";
import { addressOf } from "./connections";
import type { RedisValue } from "./drivers/redis";
import type { RowDelete, RowInsert, RowWriteResult, TableDraft } from "./row-edit";

/** What a page of rows may ask for. Everything is bounded here rather than
 *  trusted: it arrives from a browser. */
export interface RowRequest {
    readonly limit?: number;
    readonly offset?: number;
    readonly orderBy?: string | null;
    readonly descending?: boolean;
    readonly filter?: string | null;
    readonly cursor?: string | null;
}

/** What one Redis key holds, as the panel draws it. */
export type KeyValueView = RedisValue;

/** The engine's own version string. The connection test, and what the header
 *  says once it is open. */
export async function version(userId: string, connectionId: string): Promise<string> {
    return versionAt(await addressOf(userId, connectionId));
}

export async function versionAt(address: data.DataAddress): Promise<string> {
    return withDriver(address, (driver) => driver.version());
}

/**
 * What is inside a connection, and inside one of its namespaces.
 *
 * Both in one call because the tree draws both and asking twice is two
 * connections: the second would open, list one thing and close again.
 */
export async function browse(
    userId: string,
    connectionId: string,
    namespace: string | null,
    database: string | null = null
): Promise<{
    shape: data.DataShape;
    namespaces: data.DataNamespace[];
    relations: data.DataRelation[];
    /**
     * The schema these relations were actually read from.
     *
     * Returned rather than left for the caller to work out, and that is the whole
     * point: the screen used to make the same choice for itself, disagreed with
     * this one, and ended up naming a schema in its selector while listing
     * another's tables - which then asked for those tables under the wrong
     * schema. One answer, sent back, and there is nothing left to drift.
     */
    namespace: string | null;
    /** The other databases on the server this connection may open, for an
     *  engine whose connection is bound to one (Postgres). Null elsewhere. */
    databases: string[] | null;
    /** The database these were read from; null where the engine has no list. */
    database: string | null;
}> {
    return browseAt(await addressOf(userId, connectionId), namespace, database);
}

/** `browse`, for an address already resolved and authorized by the caller. */
export async function browseAt(
    address: data.DataAddress,
    namespace: string | null,
    database: string | null = null
): Promise<{
    shape: data.DataShape;
    namespaces: data.DataNamespace[];
    relations: data.DataRelation[];
    namespace: string | null;
    databases: string[] | null;
    database: string | null;
}> {
    return withDriverOn(address, database, async (driver) => {
        const namespaces = await driver.namespaces();
        // The one it was asked for, or the one a database is worth opening on -
        // `public` before the engine's own bookkeeping. A tree that opens on
        // nothing is a tree somebody has to click before it says anything.
        const chosen = namespace ?? data.openingNamespace(namespaces);
        const relations = chosen === null ? [] : await driver.relations(chosen);
        // `pg_database` is shared by every database on the server, so the list
        // read from inside the switched-to one is the same list.
        const databases = driver.databases ? await serverDatabases(address, driver) : null;
        const opened = databases === null ? null : (database ?? address.database ?? null);
        return {
            shape: driver.shape,
            namespaces,
            relations,
            namespace: chosen,
            databases,
            database: opened
        };
    });
}

/** A page of one table, collection or keyspace. */
export async function rows(
    userId: string,
    connectionId: string,
    namespace: string | null,
    relation: string,
    request: RowRequest,
    database: string | null = null
): Promise<data.DataPage> {
    return rowsAt(await addressOf(userId, connectionId), namespace, relation, request, database);
}

export async function rowsAt(
    address: data.DataAddress,
    namespace: string | null,
    relation: string,
    request: RowRequest,
    database: string | null = null
): Promise<data.DataPage> {
    return withDriverOn(address, database, async (driver) => {
        // The relation has to be one this connection actually holds. The name
        // goes into a statement in a position no parameter can occupy, so being
        // on the list the engine just gave us is the gate in front of the
        // quoting rather than a substitute for it.
        const known = await driver.relations(namespace);
        if (!known.some((entry) => entry.name === relation)) {
            throw new data.DataRequestError("There is nothing here by that name.");
        }
        return driver.rows(namespace, relation, {
            limit: data.pageSize(request.limit),
            offset: Math.max(0, Math.floor(request.offset ?? 0)),
            orderBy: request.orderBy ?? null,
            descending: request.descending === true,
            filter: request.filter ?? null,
            cursor: request.cursor ?? null
        });
    });
}

/**
 * Change one cell of one row.
 *
 * The same gate the row read goes through, and for the same reason: the relation
 * has to be one this connection actually holds, because its name goes into a
 * statement in a position no parameter can occupy. Everything after that is the
 * driver's, and the rules that keep the edit aimed at one row are
 * `prepareCellEdit`.
 *
 * An engine with no `updateCell` is refused with a sentence rather than a crash.
 * A Redis key is a value and a Mongo document is a document; neither has a row
 * with a primary key to aim at, and pretending otherwise here would be worse
 * than saying so.
 */
export async function updateCell(
    userId: string,
    connectionId: string,
    edit: data.CellEdit,
    database: string | null = null
): Promise<data.CellEditResult> {
    return updateCellAt(await addressOf(userId, connectionId), edit, database);
}

export async function updateCellAt(
    address: data.DataAddress,
    edit: data.CellEdit,
    database: string | null = null
): Promise<data.CellEditResult> {
    return withDriverOn(address, database, async (driver) => {
        if (!driver.updateCell) {
            throw new data.DataRequestError(
                "Values in this kind of database are not edited from the grid."
            );
        }
        const known = await driver.relations(edit.namespace);
        if (!known.some((entry) => entry.name === edit.relation)) {
            throw new data.DataRequestError("There is nothing here by that name.");
        }
        return driver.updateCell(edit);
    });
}

/** Whatever somebody typed into the statement box. */
export async function run(
    userId: string,
    connectionId: string,
    statement: string,
    database: string | null = null
): Promise<data.QueryResult[]> {
    return runAt(await addressOf(userId, connectionId), statement, database);
}

export async function runAt(
    address: data.DataAddress,
    statement: string,
    database: string | null = null
): Promise<data.QueryResult[]> {
    return withDriverOn(address, database, (driver) => driver.run(statement));
}

/** What one Redis key holds. */
export async function keyValue(
    userId: string,
    connectionId: string,
    namespace: string | null,
    key: string
): Promise<KeyValueView> {
    return keyValueAt(await addressOf(userId, connectionId), namespace, key);
}

export async function keyValueAt(
    address: data.DataAddress,
    namespace: string | null,
    key: string
): Promise<KeyValueView> {
    if (address.engine !== "redis") {
        throw new data.DataRequestError("Only a Redis key has a value to open.");
    }
    return withDriver(address, async (driver) => {
        const { RedisDriver } = await import("./drivers/redis");
        if (!(driver instanceof RedisDriver)) {
            throw new data.DataRequestError("Only a Redis key has a value to open.");
        }
        return driver.value(namespace, key);
    });
}

/**
 * The relation has to be one this connection holds before anything is written to
 * it - its name goes where no parameter can - and the engine has to be one with
 * rows to add and remove.
 */
async function knownRelation(
    driver: data.DataDriver,
    namespace: string | null,
    relation: string
): Promise<void> {
    const known = await driver.relations(namespace);
    if (!known.some((entry) => entry.name === relation && entry.kind === "table")) {
        throw new data.DataRequestError("There is nothing here by that name.");
    }
}

const NO_ROW_WRITES = "Rows in this kind of database are not added or removed from the grid.";

/** Add one row. */
export async function insertRow(
    userId: string,
    connectionId: string,
    insert: RowInsert,
    database: string | null = null
): Promise<RowWriteResult> {
    return insertRowAt(await addressOf(userId, connectionId), insert, database);
}

export async function insertRowAt(
    address: data.DataAddress,
    insert: RowInsert,
    database: string | null = null
): Promise<RowWriteResult> {
    return withDriverOn(address, database, async (driver) => {
        if (!driver.insertRow) throw new data.DataRequestError(NO_ROW_WRITES);
        await knownRelation(driver, insert.namespace, insert.relation);
        return driver.insertRow(insert);
    });
}

/** Remove rows, each named by its primary key. */
export async function deleteRows(
    userId: string,
    connectionId: string,
    removal: RowDelete,
    database: string | null = null
): Promise<RowWriteResult> {
    return deleteRowsAt(await addressOf(userId, connectionId), removal, database);
}

export async function deleteRowsAt(
    address: data.DataAddress,
    removal: RowDelete,
    database: string | null = null
): Promise<RowWriteResult> {
    return withDriverOn(address, database, async (driver) => {
        if (!driver.deleteRows) throw new data.DataRequestError(NO_ROW_WRITES);
        await knownRelation(driver, removal.namespace, removal.relation);
        return driver.deleteRows(removal);
    });
}

/** Create a table in a schema the connection holds. */
export async function createTable(
    userId: string,
    connectionId: string,
    draft: TableDraft,
    database: string | null = null
): Promise<void> {
    return createTableAt(await addressOf(userId, connectionId), draft, database);
}

export async function createTableAt(
    address: data.DataAddress,
    draft: TableDraft,
    database: string | null = null
): Promise<void> {
    return withDriverOn(address, database, async (driver) => {
        if (!driver.createTable) {
            throw new data.DataRequestError(
                "Tables in this kind of database are not created from here."
            );
        }
        const namespaces = await driver.namespaces();
        if (
            draft.namespace !== null &&
            !namespaces.some((entry) => entry.name === draft.namespace)
        ) {
            throw new data.DataRequestError("There is nothing here by that name.");
        }
        await driver.createTable(draft);
    });
}
