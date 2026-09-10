/**
 * What the connection table says about each row, and which rows it shows.
 *
 * Pure, so the table and its tests agree on the same answers. Search and the
 * engine filter run over the rows the screen already holds: a list of databases
 * is a short one, and asking the server again for a substring would be slower
 * than reading it.
 */

import { dbEngineLabel } from "@polaris/core";
import type { DataConnectionView } from "@/lib/data/connections";

export interface ConnectionFilters {
    readonly search: string;
    /** An engine id, or "all". */
    readonly engine: string;
}

export const NO_FILTERS: ConnectionFilters = { search: "", engine: "all" };

/** What a connection test answered: the engine's version, or why it failed. */
export interface TestOutcome {
    readonly ok: boolean;
    readonly detail: string;
}

/** Where a database lives, as the reader tells them apart. */
export type ConnectionHome = "polaris" | "managed" | "external";

export const HOME_LABELS: Record<ConnectionHome, string> = {
    polaris: "Polaris itself",
    managed: "Run by Polaris",
    external: "External"
};

/** A saved connection that points at a database Polaris runs is still that
 *  database, so it is filed with the managed ones rather than as an outside host. */
export function homeOf(connection: DataConnectionView): ConnectionHome {
    if (connection.origin === "polaris") return "polaris";
    return connection.managedDatabaseId ? "managed" : "external";
}

export interface ConnectionStatus {
    readonly tone: "success" | "danger" | "neutral";
    readonly label: string;
    /** The whole answer, for the title of a chip that only has room for a word. */
    readonly detail: string | null;
}

/**
 * Reachable or not, and how that is known.
 *
 * A test somebody ran is the freshest answer, so it wins. Before one, the only
 * thing known without opening a socket is that a database Polaris runs on
 * another server with no published port cannot be reached from here; everything
 * else is unknown until tested, and says so rather than implying it is up.
 */
export function statusOf(
    connection: DataConnectionView,
    test: TestOutcome | undefined
): ConnectionStatus {
    if (test) {
        return test.ok
            ? { tone: "success", label: "Reachable", detail: test.detail || null }
            : { tone: "danger", label: "Unreachable", detail: test.detail || null };
    }
    if (connection.unreachable) {
        return { tone: "danger", label: "Unreachable", detail: connection.note };
    }
    return { tone: "neutral", label: "Not checked", detail: null };
}

/**
 * The version number out of an engine's own version string.
 *
 * PostgreSQL answers `SELECT version()` with the compiler and the platform
 * after the number, and MariaDB appends its distribution; a column has room for
 * the number. Null when there is none to find, so the caller shows nothing
 * rather than the whole sentence.
 */
export function shortVersion(version: string): string | null {
    return /\d+(?:\.\d+)*/.exec(version)?.[0] ?? null;
}

/** The engines present in the list, by name, for the filter's options. */
export function enginesIn(
    connections: readonly DataConnectionView[]
): { value: string; label: string }[] {
    const seen = new Set(connections.map((connection) => connection.engine));
    return [...seen]
        .map((engine) => ({ value: engine, label: dbEngineLabel(engine) }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

export function filterConnections(
    connections: readonly DataConnectionView[],
    filters: ConnectionFilters
): DataConnectionView[] {
    const needle = filters.search.trim().toLowerCase();
    return connections.filter((connection) => {
        if (filters.engine !== "all" && connection.engine !== filters.engine) return false;
        if (!needle) return true;
        return [
            connection.name,
            connection.where,
            connection.database,
            connection.username,
            dbEngineLabel(connection.engine),
            HOME_LABELS[homeOf(connection)]
        ]
            .filter((value): value is string => Boolean(value))
            .some((value) => value.toLowerCase().includes(needle));
    });
}
