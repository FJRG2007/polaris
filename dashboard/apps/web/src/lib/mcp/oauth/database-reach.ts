/**
 * Which databases one connected app may reach through the database tools.
 *
 * Null is every database the person can open in the Databases app, which is
 * what a grant made before this was kept reached, and what a new one reaches
 * until the person says otherwise. A list is those connections and no other,
 * by the id the Databases app gives them: a saved connection's uuid,
 * `managed:<uuid>` for a database Polaris runs, `polaris` for the instance's
 * own. It only ever narrows: a database in the list that the person can no
 * longer open is still refused, by the same check the Databases app makes.
 *
 * Client-safe: the edit dialog reads it to draw what is held.
 */

import { z } from "zod";

/** More than any one person keeps; a ceiling on what a request may store. */
export const DATABASE_LIST_MAX = 200;

/** A connection id as the Databases app names one. */
export const databaseIdSchema = z
    .string()
    .max(80)
    .regex(
        /^(polaris|managed:[0-9a-f-]{36}|[0-9a-f-]{36})$/i,
        // i18n-ignore a request no screen sends, refused before it is read
        "Not a database connection"
    );

/** What a request may set: a list, or null for every database. */
export const databaseReachSchema = z
    .array(databaseIdSchema)
    .max(DATABASE_LIST_MAX)
    .transform((ids) => [...new Set(ids)])
    .nullable();

export type DatabaseReach = readonly string[] | null;

/** The reach a grant's stored column reads as. Anything unreadable is the
 *  empty list - no database - rather than every one: a column that cannot be
 *  read must never widen what the connection reaches. */
export function readDatabaseReach(stored: string | null | undefined): DatabaseReach {
    if (stored === null || stored === undefined) return null;
    try {
        const parsed = databaseReachSchema.safeParse(JSON.parse(stored));
        return parsed.success ? (parsed.data ?? []) : [];
    } catch {
        return [];
    }
}

/** The column a reach is stored as. */
export function storedDatabaseReach(reach: DatabaseReach): string | null {
    return reach === null ? null : JSON.stringify([...reach]);
}

/** Whether a connection id is within a reach. */
export function reachesDatabase(reach: DatabaseReach | undefined, id: string): boolean {
    return reach === null || reach === undefined || reach.includes(id);
}

/** Whether going from one reach to another only takes databases away. */
export function databaseReachNarrows(before: DatabaseReach, after: DatabaseReach): boolean {
    if (after === null) return before === null;
    if (before === null) return true;
    return after.every((id) => before.includes(id));
}

/** Whether two reaches are the same, whatever the order of their ids. */
export function sameDatabaseReach(left: DatabaseReach, right: DatabaseReach): boolean {
    if (left === null || right === null) return left === right;
    return left.length === right.length && left.every((id) => right.includes(id));
}
