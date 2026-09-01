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
import { withDriver } from "./open";
import { addressOf } from "./connections";
import type { RedisValue } from "./drivers/redis";

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
    const address = await addressOf(userId, connectionId);
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
    namespace: string | null
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
}> {
    const address = await addressOf(userId, connectionId);
    return withDriver(address, async (driver) => {
        const namespaces = await driver.namespaces();
        // The one it was asked for, or the one a database is worth opening on -
        // `public` before the engine's own bookkeeping. A tree that opens on
        // nothing is a tree somebody has to click before it says anything.
        const chosen = namespace ?? data.openingNamespace(namespaces);
        const relations = chosen === null ? [] : await driver.relations(chosen);
        return { shape: driver.shape, namespaces, relations, namespace: chosen };
    });
}

/** A page of one table, collection or keyspace. */
export async function rows(
    userId: string,
    connectionId: string,
    namespace: string | null,
    relation: string,
    request: RowRequest
): Promise<data.DataPage> {
    const address = await addressOf(userId, connectionId);
    return withDriver(address, async (driver) => {
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
    edit: data.CellEdit
): Promise<data.CellEditResult> {
    const address = await addressOf(userId, connectionId);
    return withDriver(address, async (driver) => {
        if (!driver.updateCell) {
            throw new data.DataRequestError("Values in this kind of database are not edited from the grid.");
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
    statement: string
): Promise<data.QueryResult[]> {
    const address = await addressOf(userId, connectionId);
    return withDriver(address, (driver) => driver.run(statement));
}

/** What one Redis key holds. */
export async function keyValue(
    userId: string,
    connectionId: string,
    namespace: string | null,
    key: string
): Promise<KeyValueView> {
    const address = await addressOf(userId, connectionId);
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
