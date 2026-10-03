"use client";

/**
 * Where the workbench reads from and writes to.
 *
 * The workbench is one screen with two homes: the Databases app, where a
 * connection is something somebody saved, and a Deploy database's Database tab,
 * where it is the database itself and nothing is saved. Each home hands the
 * workbench the same set of calls bound to its own server actions, so the grid,
 * the statement box, the new-table form and the live stats are one component
 * rather than two copies that drift.
 *
 * Authorization is not here: every call lands on a server action that resolves
 * and checks what it was given.
 */

import * as actions from "./actions";
import type { KeyValueView, RowRequest } from "@/lib/data/browser";
import { createContext, useContext, type ReactNode } from "react";
import type { DatabaseStats } from "@/lib/data/stats";
import type { DatabaseInsights } from "@/lib/data/insights";
import type { RowDelete, RowInsert, TableDraft } from "@/lib/data/row-edit";
import type {
    DataColumn,
    DataNamespace,
    DataPage,
    DataRelation,
    QueryResult
} from "@/lib/data/driver";

type Reply<T> = Promise<T & { error?: string }>;

export interface CellEditRequest {
    namespace: string | null;
    relation: string;
    column: string;
    value: string | null;
    key: Record<string, unknown>;
}

export interface DataSource {
    /** What the open tabs are remembered under in this browser. */
    readonly key: string;
    browse(namespace: string | null): Reply<{
        shape?: string;
        namespaces?: DataNamespace[];
        relations?: DataRelation[];
        namespace?: string | null;
    }>;
    rows(
        namespace: string | null,
        relation: string,
        query: RowRequest
    ): Reply<{ page?: DataPage; columns?: DataColumn[] }>;
    run(statement: string): Reply<{ results?: QueryResult[] }>;
    updateCell(edit: CellEditRequest): Reply<{ changed?: number }>;
    insertRow(insert: RowInsert): Reply<{ changed?: number }>;
    deleteRows(removal: RowDelete): Reply<{ changed?: number }>;
    createTable(draft: TableDraft): Reply<object>;
    redisValue(namespace: string | null, key: string): Reply<{ value?: KeyValueView }>;
    stats(): Reply<{ stats?: DatabaseStats }>;
    insights(): Reply<{ insights?: DatabaseInsights }>;
}

/** A saved connection, or one of the two offered without saving. */
export function connectionSource(connectionId: string): DataSource {
    return {
        key: connectionId,
        browse: (namespace) => actions.browseAction(connectionId, namespace),
        rows: (namespace, relation, query) =>
            actions.rowsAction(connectionId, namespace, relation, query),
        run: (statement) => actions.runAction(connectionId, statement),
        updateCell: (edit) => actions.updateCellAction(connectionId, edit),
        insertRow: (insert) => actions.insertRowAction(connectionId, insert),
        deleteRows: (removal) => actions.deleteRowsAction(connectionId, removal),
        createTable: (draft) => actions.createTableAction(connectionId, draft),
        redisValue: (namespace, key) => actions.redisValueAction(connectionId, namespace, key),
        stats: () => actions.statsAction(connectionId),
        insights: () => actions.insightsAction(connectionId)
    };
}

const Source = createContext<DataSource | null>(null);

export function DataSourceProvider({
    source,
    children
}: {
    source: DataSource;
    children: ReactNode;
}) {
    return <Source.Provider value={source}>{children}</Source.Provider>;
}

export function useDataSource(): DataSource {
    const source = useContext(Source);
    if (!source) throw new Error("The workbench needs a DataSourceProvider above it.");
    return source;
}
