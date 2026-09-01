"use client";

/**
 * One database, open.
 *
 * Three panes, which is the shape every database client has settled on because
 * it matches how the work goes: what is in here on the left, what is in the
 * thing you picked in the middle, and a box for the statement you would rather
 * have written yourself underneath.
 *
 * The grid is honest about what it is showing. A page is a page - a hundred rows
 * with the offset said out loud, not an infinite scroll that quietly holds a
 * million rows in a browser tab - and a value that is not a scalar is drawn as
 * the JSON it is rather than as `[object Object]`.
 *
 * Nothing is written from here yet: the statement box is how a change is made,
 * and a connection has to have read-only turned off before the engine will take
 * one. An editable grid is the next thing this wants, and it is deliberately not
 * the first: a cell that saves as you leave it is the one feature of a database
 * client that can quietly destroy somebody's afternoon.
 */

import Fuse from "fuse.js";
import * as actions from "./actions";
import { StatsPanel } from "./stats-panel";
import type { KeyValueView } from "@/lib/data/browser";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, CardBody, Input, SegmentedControl, Select, Skeleton, cn } from "@polaris/ui";
import type { DataColumn, DataNamespace, DataPage, DataRelation, QueryResult } from "@/lib/data/driver";
import {
    ChevronLeft,
    ChevronRight,
    Loader2,
    Play,
    RefreshCw,
    Search,
    Table2
} from "lucide-react";

/** How many rows a page holds. The server clamps it too; this is what is asked
 *  for. */
const PAGE = 100;

/**
 * The schemas a database has that nobody keeps their own tables in.
 *
 * Postgres hands back `information_schema` and its `pg_*` catalogues alongside
 * the one somebody actually uses, and they sort first. Opening on one of those
 * means the first thing anybody sees is a hundred system views, and the schema
 * with their work in it is one selector away with nothing saying so.
 */
const SYSTEM_NAMESPACES = new Set(["information_schema", "pg_catalog", "pg_toast", "sys", "mysql", "performance_schema"]);

/**
 * Which schema to open on.
 *
 * `public` where there is one, which is where a Postgres database keeps its
 * tables unless somebody has deliberately arranged otherwise - and that is
 * essentially every database Polaris will be pointed at. Otherwise the first one
 * that is not the engine's own bookkeeping, and only then whatever came first.
 *
 * Opening on a guess rather than asking, because a database browser that opens on
 * an empty pane makes everybody's first action the same click. Anybody who wants
 * a different schema still picks one.
 */
function openingNamespace(namespaces: readonly DataNamespace[]): string | null {
    const named = namespaces.map((entry) => entry.name);
    if (named.includes("public")) return "public";
    return named.find((name) => !SYSTEM_NAMESPACES.has(name)) ?? named[0] ?? null;
}

export function Workbench({ connectionId, readOnly }: { connectionId: string; readOnly: boolean }) {
    const [shape, setShape] = useState<string>("sql");
    const [namespaces, setNamespaces] = useState<DataNamespace[]>([]);
    const [namespace, setNamespace] = useState<string | null>(null);
    const [relations, setRelations] = useState<DataRelation[] | null>(null);
    const [relation, setRelation] = useState<string | null>(null);
    const [find, setFind] = useState("");
    const [tab, setTab] = useState<"data" | "query" | "stats">("data");
    const [error, setError] = useState("");

    const load = useCallback(
        async (chosen: string | null) => {
            setRelations(null);
            setError("");
            const result = await actions.browseAction(connectionId, chosen);
            if (result.error) {
                setError(result.error);
                setRelations([]);
                return;
            }
            setShape(result.shape ?? "sql");
            setNamespaces(result.namespaces ?? []);
            setRelations(result.relations ?? []);
            setNamespace(chosen ?? openingNamespace(result.namespaces ?? []));
            // A key-value store has one thing to look at, so it is opened rather
            // than offered as a list of one.
            if ((result.relations?.length ?? 0) === 1 && result.shape === "keyvalue") {
                setRelation(result.relations?.[0]?.name ?? null);
            }
        },
        [connectionId]
    );

    useEffect(() => {
        setRelation(null);
        void load(null);
    }, [load]);

    // Fuzzy, over what is already here: a schema is a few hundred names at most,
    // and the one somebody is looking for is usually half-remembered - "user_sess"
    // has to find `user_sessions`, and a transposition has to find it too. Ranked,
    // so the closest is at the top rather than wherever the catalogue put it.
    const fuse = useMemo(
        () => new Fuse(relations ?? [], { keys: ["name"], threshold: 0.3, ignoreLocation: true }),
        [relations]
    );
    const shown = useMemo(() => {
        const needle = find.trim();
        if (!needle) return relations ?? [];
        return fuse.search(needle).map((hit) => hit.item);
    }, [fuse, relations, find]);

    return (
        <div className="flex min-h-0 flex-1 gap-4">
            <aside className="flex w-64 shrink-0 flex-col gap-2">
                {namespaces.length > 1 && (
                    <Select
                        value={namespace ?? ""}
                        onValueChange={(next) => {
                            setRelation(null);
                            void load(next);
                        }}
                        aria-label="Which schema"
                        options={namespaces.map((entry) => ({
                            value: entry.name,
                            label:
                                entry.count === null || entry.count === undefined
                                    ? entry.name
                                    : `${entry.name} (${entry.count})`
                        }))}
                    />
                )}

                <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="pl-9"
                        placeholder="Find a table"
                        aria-label="Find a table"
                        value={find}
                        onChange={(event) => setFind(event.target.value)}
                    />
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
                    {relations === null ? (
                        <div className="flex flex-col gap-2 p-3" aria-hidden="true">
                            {[0, 1, 2, 3, 4].map((row) => (
                                <Skeleton key={row} className="h-4 w-full" />
                            ))}
                        </div>
                    ) : shown.length === 0 ? (
                        <p className="p-3 text-xs text-muted-foreground">
                            {relations.length === 0 ? "Nothing in here yet." : "Nothing matches."}
                        </p>
                    ) : (
                        <ul className="flex flex-col">
                            {shown.map((entry) => (
                                <li key={`${entry.namespace}.${entry.name}`}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setRelation(entry.name);
                                            setTab("data");
                                        }}
                                        className={cn(
                                            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-card-hover",
                                            entry.name === relation && "bg-muted text-foreground"
                                        )}
                                    >
                                        <Table2 className="size-3.5 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 flex-1 truncate" title={entry.name}>{entry.name}</span>
                                        {entry.rows !== null && (
                                            <span className="shrink-0 text-xs text-muted-foreground">
                                                {entry.rows}
                                            </span>
                                        )}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </aside>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                <div className="flex items-center gap-2">
                    <SegmentedControl
                        // Its own width, and not squeezed by the note beside it:
                        // a flex row will happily shrink it until "Data" is "D...".
                        className="shrink-0 self-start"
                        aria-label="What to show"
                        value={tab}
                        onValueChange={(next) => setTab(next)}
                        options={[
                            { value: "data", label: "Data" },
                            { value: "query", label: shape === "sql" ? "SQL" : "Command" },
                            { value: "stats", label: "Activity" }
                        ]}
                    />
                    {readOnly && (
                        <span className="text-xs text-muted-foreground">
                            Read-only. Nothing here can change the database.
                        </span>
                    )}
                </div>

                {error && (
                    <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                        {error}
                    </p>
                )}

                {tab === "stats" ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                        <StatsPanel connectionId={connectionId} />
                    </div>
                ) : tab === "data" ? (
                    relation ? (
                        <RowsPanel
                            connectionId={connectionId}
                            namespace={namespace}
                            relation={relation}
                            shape={shape}
                        />
                    ) : (
                        <Card>
                            <CardBody className="p-8 text-center text-sm text-muted-foreground">
                                Pick something on the left to see what is in it.
                            </CardBody>
                        </Card>
                    )
                ) : (
                    <QueryPanel connectionId={connectionId} shape={shape} />
                )}
            </div>
        </div>
    );
}

/** A page of rows, with the controls that move through them. */
function RowsPanel({
    connectionId,
    namespace,
    relation,
    shape
}: {
    connectionId: string;
    namespace: string | null;
    relation: string;
    shape: string;
}) {
    const [page, setPage] = useState<DataPage | null>(null);
    const [offset, setOffset] = useState(0);
    const [cursor, setCursor] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [applied, setApplied] = useState("");
    const [orderBy, setOrderBy] = useState<string | null>(null);
    const [descending, setDescending] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [opened, setOpened] = useState<KeyValueView | null>(null);

    const read = useCallback(async () => {
        setBusy(true);
        setError("");
        const result = await actions.rowsAction(connectionId, namespace, relation, {
            limit: PAGE,
            offset,
            orderBy,
            descending,
            filter: applied || null,
            cursor
        });
        setBusy(false);
        if (result.error) {
            setError(result.error);
            setPage(null);
            return;
        }
        setPage(result.page ?? null);
    }, [connectionId, namespace, relation, offset, orderBy, descending, applied, cursor]);

    useEffect(() => {
        void read();
    }, [read]);

    // A different table is a different page, a different sort and a different
    // filter. Carrying any of them over shows somebody the wrong rows under the
    // right heading.
    useEffect(() => {
        setOffset(0);
        setCursor(null);
        setOrderBy(null);
        setDescending(false);
        setFilter("");
        setApplied("");
        setOpened(null);
    }, [relation, namespace]);

    const columns = page?.columns ?? [];
    const cursorPaged = shape === "keyvalue";

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
                <form
                    className="relative min-w-48 flex-1"
                    onSubmit={(event) => {
                        event.preventDefault();
                        setOffset(0);
                        setCursor(null);
                        setApplied(filter);
                    }}
                >
                    <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        className="pl-9"
                        placeholder={cursorPaged ? "Match keys" : "Find in these rows"}
                        aria-label="Filter rows"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                    />
                </form>
                <Button size="icon" variant="ghost" title="Refresh" aria-label="Refresh" onClick={() => void read()}>
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                </Button>
                <span className="text-xs text-muted-foreground">
                    {page
                        ? cursorPaged
                            ? `${page.rows.length} keys${page.total === null ? "" : ` of about ${page.total}`}`
                            : `rows ${page.rows.length === 0 ? 0 : offset + 1}-${offset + page.rows.length}${page.total === null ? "" : ` of ${page.total}`}`
                        : ""}
                </span>
                <div className="flex items-center gap-1">
                    <Button
                        size="icon"
                        variant="ghost"
                        title="Previous page"
                        aria-label="Previous page"
                        disabled={cursorPaged || offset === 0}
                        onClick={() => setOffset(Math.max(0, offset - PAGE))}
                    >
                        <ChevronLeft className="size-4" />
                    </Button>
                    <Button
                        size="icon"
                        variant="ghost"
                        title="Next page"
                        aria-label="Next page"
                        disabled={
                            cursorPaged
                                ? !page?.cursor
                                : (page?.rows.length ?? 0) < PAGE
                        }
                        onClick={() => {
                            if (cursorPaged) setCursor(page?.cursor ?? null);
                            else setOffset(offset + PAGE);
                        }}
                    >
                        <ChevronRight className="size-4" />
                    </Button>
                </div>
            </div>

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error}
                </p>
            )}

            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border">
                {page === null ? (
                    <div className="flex flex-col gap-2 p-3" aria-hidden="true">
                        {[0, 1, 2, 3, 4, 5].map((row) => (
                            <Skeleton key={row} className="h-4 w-full" />
                        ))}
                    </div>
                ) : (
                    <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-surface/95 text-left text-xs text-muted-foreground backdrop-blur">
                            <tr>
                                {columns.map((column) => (
                                    <SortableHeader
                                        key={column.name}
                                        column={column}
                                        sortable={!cursorPaged}
                                        active={orderBy === column.name}
                                        descending={descending}
                                        onSort={() => {
                                            setOffset(0);
                                            if (orderBy === column.name) setDescending(!descending);
                                            else {
                                                setOrderBy(column.name);
                                                setDescending(false);
                                            }
                                        }}
                                    />
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {page.rows.length === 0 ? (
                                <tr>
                                    <td
                                        colSpan={Math.max(1, columns.length)}
                                        className="px-3 py-8 text-center text-muted-foreground"
                                    >
                                        {applied ? "Nothing matches that." : "Nothing in here."}
                                    </td>
                                </tr>
                            ) : (
                                page.rows.map((row, index) => (
                                    <tr
                                        key={index}
                                        className={cn(
                                            "border-t border-border",
                                            cursorPaged && "cursor-pointer hover:bg-card-hover"
                                        )}
                                        onClick={
                                            cursorPaged
                                                ? () => {
                                                      void actions
                                                          .redisValueAction(
                                                              connectionId,
                                                              namespace,
                                                              String(row.key)
                                                          )
                                                          .then((result) => {
                                                              if (result.error) setError(result.error);
                                                              else setOpened(result.value ?? null);
                                                          });
                                                  }
                                                : undefined
                                        }
                                    >
                                        {columns.map((column) => (
                                            <td
                                                key={column.name}
                                                className="max-w-xs truncate px-3 py-1.5 align-top font-mono text-xs"
                                                title={cellText(row[column.name])}
                                            >
                                                {cell(row[column.name])}
                                            </td>
                                        ))}
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                )}
            </div>

            {opened && <KeyPanel value={opened} onClose={() => setOpened(null)} />}
        </div>
    );
}

function SortableHeader({
    column,
    sortable,
    active,
    descending,
    onSort
}: {
    column: DataColumn;
    sortable: boolean;
    active: boolean;
    descending: boolean;
    onSort: () => void;
}) {
    return (
        <th className="whitespace-nowrap px-3 py-2 font-medium">
            <button
                type="button"
                disabled={!sortable}
                onClick={onSort}
                title={column.type}
                className={cn(
                    "flex items-center gap-1",
                    sortable && "hover:text-foreground",
                    active && "text-foreground"
                )}
            >
                {column.name}
                {column.primaryKey && <span className="text-primary">*</span>}
                {active && <span aria-hidden="true">{descending ? "↓" : "↑"}</span>}
            </button>
        </th>
    );
}

/** What one Redis key holds, beside the list. */
function KeyPanel({ value, onClose }: { value: KeyValueView; onClose: () => void }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-sm" title={value.key}>{value.key}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                        {value.type}
                        {value.ttl === null ? "" : ` - expires in ${Math.round(value.ttl / 1000)}s`}
                    </span>
                    <Button size="sm" variant="ghost" onClick={onClose}>
                        Close
                    </Button>
                </div>
                {value.value !== null ? (
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">
                        {value.value}
                    </pre>
                ) : value.entries ? (
                    <div className="max-h-64 overflow-auto rounded border border-border">
                        <table className="w-full text-xs">
                            <tbody>
                                {value.entries.map((entry, index) => (
                                    <tr key={index} className="border-t border-border first:border-t-0">
                                        {entry.field !== "" && (
                                            <td className="w-40 truncate px-2 py-1 font-mono text-muted-foreground">
                                                {entry.field}
                                            </td>
                                        )}
                                        <td className="px-2 py-1 font-mono">{entry.value}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground">
                        Polaris cannot read a {value.type} yet. Its type and expiry are above.
                    </p>
                )}
                {value.truncated && (
                    <p className="text-xs text-muted-foreground">
                        There is more of it than is shown.
                    </p>
                )}
            </CardBody>
        </Card>
    );
}

/** The statement box, and what came back. */
function QueryPanel({ connectionId, shape }: { connectionId: string; shape: string }) {
    const [statement, setStatement] = useState("");
    const [results, setResults] = useState<QueryResult[] | null>(null);
    const [running, setRunning] = useState(false);
    const [error, setError] = useState("");

    const run = async () => {
        if (!statement.trim() || running) return;
        setRunning(true);
        setError("");
        const result = await actions.runAction(connectionId, statement);
        setRunning(false);
        if (result.error) {
            setError(result.error);
            setResults(null);
            return;
        }
        setResults(result.results ?? []);
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
            <textarea
                value={statement}
                spellCheck={false}
                onChange={(event) => setStatement(event.target.value)}
                onKeyDown={(event) => {
                    // The shortcut every client has: run it without reaching for
                    // the mouse, and a newline still just makes a newline.
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void run();
                    }
                }}
                placeholder={placeholderFor(shape)}
                className="h-32 w-full resize-y rounded-lg border border-border bg-surface p-3 font-mono text-xs outline-none focus-visible:border-border-strong"
            />
            <div className="flex items-center gap-2">
                <Button onClick={() => void run()} disabled={!statement.trim() || running}>
                    {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                    Run
                </Button>
                <span className="text-xs text-muted-foreground">Ctrl+Enter</span>
            </div>

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error}
                </p>
            )}

            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
                {results?.map((result, index) => (
                    <div key={index} className="rounded-lg border border-border">
                        <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                            <span className="min-w-0 flex-1 truncate font-mono" title={result.statement}>{result.statement}</span>
                            <span className="shrink-0">
                                {result.affected === null
                                    ? `${result.rows.length} rows`
                                    : `${result.affected} changed`}{" "}
                                - {result.ms}ms
                            </span>
                        </div>
                        {result.rows.length > 0 && (
                            <div className="max-h-72 overflow-auto">
                                <table className="w-full text-xs">
                                    <thead className="bg-surface/60 text-left text-muted-foreground">
                                        <tr>
                                            {result.columns.map((column) => (
                                                <th key={column} className="px-3 py-1.5 font-medium">
                                                    {column}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {result.rows.map((row, rowIndex) => (
                                            <tr key={rowIndex} className="border-t border-border">
                                                {row.map((value, cellIndex) => (
                                                    <td
                                                        key={cellIndex}
                                                        className="max-w-xs truncate px-3 py-1 font-mono"
                                                        title={cellText(value)}
                                                    >
                                                        {cell(value)}
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

function placeholderFor(shape: string): string {
    if (shape === "keyvalue") return "GET some:key";
    if (shape === "document") return '{ "find": "users", "limit": 20 }';
    return "SELECT * FROM users LIMIT 20";
}

/** A value as a cell draws it. Null is said rather than left blank, because an
 *  empty string and a null are different things and a grid that shows both as
 *  nothing is lying about one of them. */
function cell(value: unknown): React.ReactNode {
    if (value === null || value === undefined) {
        return <span className="text-muted-foreground">null</span>;
    }
    if (value === "") return <span className="text-muted-foreground">empty</span>;
    return cellText(value);
}

function cellText(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}
