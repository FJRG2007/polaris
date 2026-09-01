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
 * The grid edits now, and the care that went into it is the point rather than the
 * feature: a cell that saves as you leave it is the one thing in a database
 * client that can quietly destroy somebody's afternoon. So an edit is a
 * double-click and then a deliberate commit, it only exists on a table with a
 * primary key, it is aimed by that key and by nothing else, and a read-only
 * connection does not offer it at all. Everything about which statement it
 * becomes is `prepareCellEdit`, on the server, and none of it is decided here.
 *
 * Rows select the way rows select everywhere else in Polaris - a click, a
 * Ctrl-click, a Shift-range - and the right-click menu is the same component the
 * file browser uses, so what somebody has learnt in Drive works here.
 */

import Fuse from "fuse.js";
import * as actions from "./actions";
import { StatsPanel } from "./stats-panel";
import { CodeSurface } from "@/components/code-surface";
import type { KeyValueView } from "@/lib/data/browser";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
    Button,
    Card,
    CardBody,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
    Input,
    MenuShortcut,
    SegmentedControl,
    Select,
    Skeleton,
    cn
} from "@polaris/ui";
import type { DataColumn, DataNamespace, DataPage, DataRelation, QueryResult } from "@/lib/data/driver";
import {
    Check,
    ChevronLeft,
    ChevronRight,
    Copy,
    Loader2,
    Pencil,
    Play,
    RefreshCw,
    Search,
    Table2,
    X
} from "lucide-react";

/** How many rows a page holds. The server clamps it too; this is what is asked
 *  for. */
const PAGE = 100;

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
            // What the server actually read from, never a second guess at it.
            // Choosing here as well is how the selector came to name one schema
            // while the list held another's tables - and opening one of those
            // then asked for it under the name in the box.
            setNamespace(result.namespace ?? null);
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
                            readOnly={readOnly}
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

/** The selection as JSON, which is what somebody pasting into an editor wants. */
function rowsAsJson(rows: readonly Record<string, unknown>[]): string {
    if (rows.length === 0) return "";
    return JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2);
}

/**
 * The selection as tab-separated text, with a header row.
 *
 * What a spreadsheet reads when it is pasted into, which is the other half of
 * why anybody copies rows out of a database at all.
 */
function rowsAsText(
    rows: readonly Record<string, unknown>[],
    columns: readonly DataColumn[]
): string {
    if (rows.length === 0) return "";
    const header = columns.map((column) => column.name).join("\t");
    const body = rows.map((row) => columns.map((column) => cellText(row[column.name])).join("\t"));
    return [header, ...body].join("\n");
}

/**
 * One cell, open for editing.
 *
 * Enter commits and Escape abandons, which is what every grid does - and the
 * commit is deliberate rather than automatic. A cell that saved on blur would
 * write to the database because somebody clicked somewhere else, and that is the
 * single worst thing a database client can do.
 *
 * Leaving it also abandons, for the same reason: the safe reading of "I clicked
 * away" is that the edit was not meant.
 */
function CellEditor({
    value,
    saving,
    onChange,
    onCommit,
    onCancel
}: {
    value: string;
    saving: boolean;
    onChange: (next: string) => void;
    onCommit: () => void;
    onCancel: () => void;
}) {
    return (
        <span className="flex items-center gap-1">
            <input
                autoFocus
                value={value}
                disabled={saving}
                spellCheck={false}
                onChange={(event) => onChange(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        onCommit();
                    }
                    if (event.key === "Escape") {
                        event.preventDefault();
                        onCancel();
                    }
                }}
                onBlur={onCancel}
                className="min-w-0 flex-1 rounded border border-border-strong bg-background px-1 py-0.5 font-mono text-xs outline-none"
                aria-label="New value"
            />
            {/* Pressed with the pointer rather than the keyboard: the field's own
                blur would otherwise abandon the edit before the button was
                reached, so both act on pointer-down. */}
            <button
                type="button"
                aria-label="Save this value"
                title="Save"
                disabled={saving}
                onMouseDown={(event) => {
                    event.preventDefault();
                    onCommit();
                }}
                className="text-success shrink-0 rounded p-0.5 hover:bg-muted"
            >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            </button>
            <button
                type="button"
                aria-label="Leave it as it was"
                title="Cancel"
                onMouseDown={(event) => {
                    event.preventDefault();
                    onCancel();
                }}
                className="text-muted-foreground shrink-0 rounded p-0.5 hover:bg-muted"
            >
                <X className="size-3.5" />
            </button>
        </span>
    );
}

/** A page of rows, with the controls that move through them. */
function RowsPanel({
    connectionId,
    namespace,
    relation,
    shape,
    readOnly
}: {
    connectionId: string;
    namespace: string | null;
    relation: string;
    shape: string;
    /** Whether the connection refuses writes. Editing is not offered at all on
     *  one that does - a cell that opens and then fails on save is worse than a
     *  cell that never opened. */
    readOnly: boolean;
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
    /** Which rows are picked out, by their index on this page. A page is the
     *  unit here: an index means nothing once the offset moves, so the set is
     *  emptied whenever the rows underneath change. */
    const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
    /** Where a Shift-range reaches back to: the last row clicked on its own. */
    const [anchor, setAnchor] = useState<number | null>(null);
    /** The cell being edited, and what is currently typed into it. */
    const [editing, setEditing] = useState<{ row: number; column: string } | null>(null);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);

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

    // A selection is a set of positions on the page in front of somebody. The
    // moment the rows underneath change - another page, another sort, another
    // filter - those positions point at different rows, so the set goes rather
    // than quietly coming to mean something else.
    useEffect(() => {
        setPicked(new Set());
        setAnchor(null);
        setEditing(null);
    }, [page]);

    const columns = page?.columns ?? [];
    const cursorPaged = shape === "keyvalue";
    /** The columns that identify a row. No primary key means no way to aim an
     *  edit at one row, which is what decides whether editing exists at all. */
    const keyColumns = useMemo(() => columns.filter((column) => column.primaryKey), [columns]);
    const editable = !readOnly && !cursorPaged && keyColumns.length > 0;

    /** What a click on a row means, read the way every list in Polaris reads it. */
    const pick = (index: number, event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
        if (event.shiftKey && anchor !== null) {
            const [from, to] = anchor <= index ? [anchor, index] : [index, anchor];
            const range = new Set(picked);
            for (let at = from; at <= to; at += 1) range.add(at);
            setPicked(range);
            return;
        }
        if (event.metaKey || event.ctrlKey) {
            const next = new Set(picked);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            setPicked(next);
            setAnchor(index);
            return;
        }
        setPicked(new Set([index]));
        setAnchor(index);
    };

    /**
     * Right-clicking a row that is not in the selection takes it over.
     *
     * The same rule the file browser follows, and the reason it exists is the
     * accident it prevents: right-clicking one row while four others are
     * selected, and having the menu act on the four.
     */
    const adoptForMenu = (index: number) => {
        if (picked.has(index)) return;
        setPicked(new Set([index]));
        setAnchor(index);
    };

    /** The rows behind the current selection, in the order they are drawn. */
    const pickedRows = useMemo(
        () => (page?.rows ?? []).filter((_row, index) => picked.has(index)),
        [page, picked]
    );

    const copy = (text: string) => {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
    };

    /** Start editing a cell, with what is in it already typed. */
    const beginEdit = (index: number, column: DataColumn) => {
        if (!editable || column.primaryKey) return;
        const value = (page?.rows[index] ?? {})[column.name];
        setEditing({ row: index, column: column.name });
        setDraft(value === null || value === undefined ? "" : cellText(value));
    };

    /**
     * Commit the cell, then read the page again.
     *
     * Re-read rather than patched in place: the engine may have stored something
     * other than what was typed - a trimmed string, a rounded number, a trigger's
     * doing - and a grid that showed the typed value would be lying about what is
     * in the database until the next refresh.
     */
    const commitEdit = async () => {
        const target = editing;
        if (!target || !page) return;
        const row = page.rows[target.row];
        const column = columns.find((entry) => entry.name === target.column);
        if (!row || !column) {
            setEditing(null);
            return;
        }
        const before = row[target.column];
        const wanted = draft === "" && column.nullable ? null : draft;
        // Nothing typed is nothing to send. A no-op UPDATE still writes a row
        // version and still fires triggers.
        if (wanted === (before === null || before === undefined ? null : cellText(before))) {
            setEditing(null);
            return;
        }

        setSaving(true);
        setError("");
        const key: Record<string, unknown> = {};
        for (const entry of keyColumns) key[entry.name] = row[entry.name];
        const result = await actions.updateCellAction(connectionId, {
            namespace,
            relation,
            column: target.column,
            value: wanted,
            key
        });
        setSaving(false);
        setEditing(null);
        if (result.error) {
            setError(result.error);
            return;
        }
        if (result.changed === 0) {
            // The row was there when the page was drawn and is not now, or its
            // key has moved. Said rather than swallowed: a silent no-op reads as
            // a save that worked.
            setError("Nothing was changed - that row is no longer there.");
        }
        await read();
    };

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
                    {picked.size > 0
                        ? `${picked.size} selected`
                        : page
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
                                    <ContextMenu key={index}>
                                        <ContextMenuTrigger asChild>
                                            <tr
                                                className={cn(
                                                    "border-t border-border",
                                                    "cursor-default hover:bg-card-hover",
                                                    picked.has(index) && "bg-primary/10 hover:bg-primary/15"
                                                )}
                                                onContextMenu={() => adoptForMenu(index)}
                                                onClick={(event) => {
                                                    if (cursorPaged) {
                                                        void actions
                                                            .redisValueAction(
                                                                connectionId,
                                                                namespace,
                                                                String(row.key)
                                                            )
                                                            .then((result) => {
                                                                if (result.error)
                                                                    setError(result.error);
                                                                else setOpened(result.value ?? null);
                                                            });
                                                        return;
                                                    }
                                                    pick(index, event);
                                                }}
                                            >
                                                {columns.map((column) => {
                                                    const open =
                                                        editing?.row === index &&
                                                        editing.column === column.name;
                                                    return (
                                                        <td
                                                            key={column.name}
                                                            className={cn(
                                                                "max-w-xs px-3 py-1.5 align-top font-mono text-xs",
                                                                !open && "truncate"
                                                            )}
                                                            title={open ? undefined : cellText(row[column.name])}
                                                            onDoubleClick={() => beginEdit(index, column)}
                                                        >
                                                            {open ? (
                                                                <CellEditor
                                                                    value={draft}
                                                                    saving={saving}
                                                                    onChange={setDraft}
                                                                    onCommit={() => void commitEdit()}
                                                                    onCancel={() => setEditing(null)}
                                                                />
                                                            ) : (
                                                                cell(row[column.name])
                                                            )}
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        </ContextMenuTrigger>
                                        <ContextMenuContent className="w-56">
                                            <ContextMenuItem
                                                onSelect={() => copy(rowsAsJson(pickedRows))}
                                            >
                                                <Copy className="size-3.5" />
                                                {picked.size > 1
                                                    ? `Copy ${picked.size} rows as JSON`
                                                    : "Copy row as JSON"}
                                            </ContextMenuItem>
                                            <ContextMenuItem
                                                onSelect={() => copy(rowsAsText(pickedRows, columns))}
                                            >
                                                <Copy className="size-3.5" />
                                                Copy as text
                                            </ContextMenuItem>
                                            {editable ? (
                                                <>
                                                    <ContextMenuSeparator />
                                                    {/* Named, because "edit" on a
                                                        row is ambiguous and this
                                                        only ever changes one
                                                        cell. */}
                                                    <ContextMenuItem
                                                        onSelect={() => {
                                                            const first = columns.find(
                                                                (column) => !column.primaryKey
                                                            );
                                                            if (first) beginEdit(index, first);
                                                        }}
                                                    >
                                                        <Pencil className="size-3.5" />
                                                        Edit a value
                                                        <MenuShortcut>Double-click</MenuShortcut>
                                                    </ContextMenuItem>
                                                </>
                                            ) : null}
                                        </ContextMenuContent>
                                    </ContextMenu>
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
            {/* Painted while it is typed, through the same surface the code
                viewer and the snippet editor use - a transparent textarea over
                the highlighted text, so the caret lands where the character is.
                A statement box with no colour is the one part of a database
                client where an unclosed quote is invisible until the engine
                refuses the whole thing.

                Only SQL is painted. A key-value store's commands are not SQL and
                highlighting them as if they were would colour the wrong words,
                which is worse than colouring none. */}
            <div
                className="h-32 shrink-0 overflow-hidden rounded-lg border border-border bg-surface focus-within:border-border-strong"
                onKeyDown={(event) => {
                    // The shortcut every client has: run it without reaching for
                    // the mouse, and a newline still just makes a newline.
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void run();
                    }
                }}
            >
                <CodeSurface
                    code={statement}
                    language={shape === "sql" ? "sql" : null}
                    onChange={setStatement}
                    ariaLabel={placeholderFor(shape)}
                    className="h-full"
                />
            </div>
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
