"use client";

/**
 * One list of records - companies, people or opportunities - as a table.
 *
 * Opening it reads the view (columns, widths, totals, sorts), what the reader
 * may do and who may own a record; the rows follow once the view is known. Both
 * are painted from what this tab kept before they are read again, so a revisit
 * shows the list as it was left with no wait.
 *
 * Every change lands on screen first and is undone, with a note saying why, if
 * the server refuses it.
 */

import { useCrmT } from "./i18n";
import { useRecords } from "./use-records";
import { messageOf, unwrap } from "./call";
import { RecordTable } from "./record-table";
import * as actions from "../actions/records";
import { hostUi } from "@polaris/app-host/client";
import type { InputValue } from "../model/values";
import { BulkEditDialog } from "./bulk-edit-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readConfig, type Aggregate, type ViewColumn, type ViewConfig } from "../model/views";
import { Building2, Columns3, Pencil, Plus, Search, SearchX, ShieldOff, Target, Trash2, User, X } from "lucide-react";
import {
    primaryField,
    type CrmObject,
    type CrmRecord,
    type FieldDef,
    type FieldValue
} from "../model/objects";
import {
    Button,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    EmptyState,
    Input,
    useToast
} from "@polaris/ui";

/** How long typing in the search box has to pause before the list is read. */
const SEARCH_DELAY_MS = 250;
/** How long a change to the columns waits for the next one before it is kept. */
const SAVE_DELAY_MS = 600;

const OBJECT_ICON: Readonly<Record<CrmObject, typeof Building2>> = {
    companies: Building2,
    people: User,
    opportunities: Target
};

function useDebounced<T>(value: T, delay: number): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setSettled(value), delay);
        return () => window.clearTimeout(timer);
    }, [value, delay]);
    return settled;
}

function TableSkeleton() {
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden rounded-lg border border-border bg-card" aria-hidden>
            {Array.from({ length: 9 }, (_, index) => (
                <div key={index} className="flex h-9 items-center gap-6 border-b border-border px-3">
                    <span className="block h-3 w-40 animate-pulse rounded bg-muted" />
                    <span className="block h-3 w-24 animate-pulse rounded bg-muted" />
                    <span className="block h-3 w-32 animate-pulse rounded bg-muted" />
                </div>
            ))}
        </div>
    );
}

export function ListScreen({ object }: { object: CrmObject }) {
    const t = useCrmT();
    const toast = useToast();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const primary = primaryField(object);
    const Icon = OBJECT_ICON[object];

    // The view, the reader's abilities and the shelf's people.
    const loadOpening = useCallback(
        () => unwrap(() => actions.openListAction({ object }), t("errors.loadFailed")),
        [object, t]
    );
    const opening = hostUi.liveRead.useLiveRead({ cacheKey: `crm:open:${object}`, load: loadOpening });
    const can = opening.data?.can[object] ?? null;
    const people = opening.data?.people ?? [];

    // The columns as shown. Changed here first, kept on the server a moment
    // later; a read of the view that lands while a change is waiting to be kept
    // does not put the old columns back.
    const [config, setConfig] = useState<ViewConfig | null>(null);
    const saving = useRef<number | null>(null);
    useEffect(() => {
        if (!opening.data?.view || saving.current !== null) return;
        setConfig(readConfig(object, opening.data.view.config));
    }, [opening.data, object]);

    const openingRef = useRef(opening);
    openingRef.current = opening;
    const shape = useCallback(
        (next: ViewConfig) => {
            setConfig(next);
            const opened = openingRef.current.data;
            const view = opened?.view;
            if (!opened || !view) return;
            openingRef.current.replace({ ...opened, view: { ...view, config: next } });
            // Somebody who may not change records may still widen a column for
            // themselves; only an editor's layout is kept for everyone.
            if (!opened.can[object].edit) return;
            if (saving.current !== null) window.clearTimeout(saving.current);
            saving.current = window.setTimeout(() => {
                saving.current = null;
                unwrap(
                    () => actions.saveViewAction({ object, viewId: view.id, config: next }),
                    t("errors.generic")
                ).catch((caught) => toast.show({ title: t("errors.viewNotSaved"), body: messageOf(caught) }));
            }, SAVE_DELAY_MS);
        },
        [object, t, toast]
    );
    useEffect(
        () => () => {
            if (saving.current !== null) window.clearTimeout(saving.current);
        },
        []
    );

    const [typed, setTyped] = useState("");
    const search = useDebounced(typed.trim(), SEARCH_DELAY_MS);
    const sorts = useMemo(() => config?.sorts ?? [], [config]);
    const readable = Boolean(can?.read);
    const records = useRecords(object, { search, sorts, enabled: config !== null && readable });

    // Totals over the whole match.
    const asked = useMemo(
        () =>
            (config?.columns ?? [])
                .filter((column) => !column.hidden && column.aggregate)
                .map((column) => ({ key: column.key, aggregate: column.aggregate as Aggregate })),
        [config]
    );
    const askedKey = asked.map((one) => `${one.key}.${one.aggregate}`).join(",");
    const loadTotals = useCallback(
        () =>
            unwrap(() => actions.totalsAction({ object, search, asked }), t("errors.loadFailed")).then(
                (answer) => answer.totals
            ),
        // `asked` is read through its key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [object, search, askedKey, t]
    );
    const totals = hostUi.liveRead.useLiveRead({
        cacheKey: `crm:totals:${object}:${askedKey}:${search}`,
        load: loadTotals,
        enabled: readable && asked.length > 0
    });
    const refreshTotals = totals.refresh;

    const [selected, setSelected] = useState<string[]>([]);
    const [drafting, setDrafting] = useState(false);
    const [bulkOpen, setBulkOpen] = useState(false);
    // Chosen rows that have left the screen - trashed, or filtered away - are
    // no longer chosen.
    const rowIds = useMemo(() => new Set((records.rows ?? []).map((row) => row.id)), [records.rows]);
    useEffect(() => {
        setSelected((current) => {
            const kept = current.filter((id) => rowIds.has(id));
            return kept.length === current.length ? current : kept;
        });
    }, [rowIds]);

    const failed = useCallback(
        (title: string, caught: unknown) => toast.show({ title, body: messageOf(caught) }),
        [toast]
    );

    // The newest edit of each cell: an older answer arriving late is not
    // allowed to overwrite a newer value.
    const latest = useRef(new Map<string, number>());
    const edit = useCallback(
        (record: CrmRecord, field: FieldDef, stored: InputValue, shown: FieldValue) => {
            const slot = `${record.id}:${field.key}`;
            const turn = (latest.current.get(slot) ?? 0) + 1;
            latest.current.set(slot, turn);
            const before = record.values[field.key] ?? null;
            records.patch([{ id: record.id, values: { [field.key]: shown } }]);
            unwrap(
                () => actions.updateRecordAction({ object, id: record.id, values: { [field.key]: stored } }),
                t("errors.generic")
            )
                .then(({ record: saved }) => {
                    if (latest.current.get(slot) !== turn) return;
                    records.patch([
                        {
                            id: saved.id,
                            values: {
                                [field.key]: saved.values[field.key] ?? null,
                                updatedAt: saved.values.updatedAt ?? null
                            }
                        }
                    ]);
                    refreshTotals();
                })
                .catch((caught) => {
                    if (latest.current.get(slot) !== turn) return;
                    records.patch([{ id: record.id, values: { [field.key]: before } }]);
                    failed(t("errors.notSaved"), caught);
                });
        },
        [object, records, refreshTotals, failed, t]
    );

    const bulkEdit = useCallback(
        (field: FieldDef, stored: InputValue, shown: FieldValue) => {
            const ids = [...selected];
            const rows = (records.rows ?? []).filter((row) => ids.includes(row.id));
            const before = rows.map((row) => ({ id: row.id, values: { [field.key]: row.values[field.key] ?? null } }));
            records.patch(ids.map((id) => ({ id, values: { [field.key]: shown } })));
            unwrap(() => actions.updateRecordsAction({ object, ids, values: { [field.key]: stored } }), t("errors.generic"))
                .then(({ records: saved }) => {
                    records.put(saved);
                    refreshTotals();
                    toast.show({ title: t("bulk.done", { count: saved.length }) });
                })
                .catch((caught) => {
                    records.patch(before);
                    failed(t("errors.notSaved"), caught);
                });
        },
        [object, records, refreshTotals, selected, toast, failed, t]
    );

    const trash = useCallback(async () => {
        const ids = [...selected];
        const ok = await confirm({
            title: t("trash.title", { count: ids.length }),
            description: t("trash.description"),
            confirmLabel: t("trash.confirm"),
            danger: true
        });
        if (!ok) return;
        const rows = records.rows ?? [];
        const total = records.total;
        records.drop(ids);
        setSelected([]);
        unwrap(() => actions.trashRecordsAction({ object, ids }), t("errors.generic"))
            .then(({ count }) => {
                refreshTotals();
                toast.show({ title: t("trash.done", { count }) });
            })
            .catch((caught) => {
                records.restore(rows, total);
                failed(t("errors.notTrashed"), caught);
            });
    }, [confirm, object, records, refreshTotals, selected, toast, failed, t]);

    const drafts = useRef(0);
    const create = useCallback(
        (value: InputValue) => {
            setDrafting(false);
            drafts.current += 1;
            const temporary: CrmRecord = {
                id: `draft:${drafts.current}`,
                position: Number.NEGATIVE_INFINITY,
                deletedAt: null,
                values: { [primary.key]: value as FieldValue }
            };
            records.prepend(temporary);
            unwrap(() => actions.createRecordAction({ object, values: { [primary.key]: value } }), t("errors.generic"))
                .then(({ record }) => {
                    records.drop([temporary.id]);
                    records.prepend(record);
                    refreshTotals();
                })
                .catch((caught) => {
                    records.drop([temporary.id]);
                    failed(t("errors.notCreated"), caught);
                });
        },
        [object, primary.key, records, refreshTotals, failed, t]
    );

    const columns = useMemo(() => (config?.columns ?? []).filter((column) => !column.hidden), [config]);
    const setColumns = (next: ViewColumn[]) => {
        if (!config) return;
        // `next` is the visible columns in their new order; the hidden ones
        // keep their places after them.
        const shown = new Set(next.map((column) => column.key));
        shape({ ...config, columns: [...next, ...config.columns.filter((column) => !shown.has(column.key))] });
    };
    const toggleColumn = (key: string) => {
        if (!config) return;
        shape({
            ...config,
            columns: config.columns.map((column) => (column.key === key ? { ...column, hidden: !column.hidden } : column))
        });
    };
    const sortBy = (key: string, direction: "asc" | "desc" | null) => {
        if (!config) return;
        shape({ ...config, sorts: direction ? [{ key, direction }] : config.sorts.filter((sort) => sort.key !== key) });
    };
    const aggregate = (key: string, value: Aggregate | null) => {
        if (!config) return;
        shape({
            ...config,
            columns: config.columns.map((column) => (column.key === key ? { ...column, aggregate: value } : column))
        });
    };

    const title = t(`objects.${object}.plural`);
    const canEdit = Boolean(can?.edit);
    const canDelete = Boolean(can?.delete);
    const rows = records.rows;
    const failure = (!opening.data && opening.error) || (readable && !rows && records.error) || null;

    let body;
    if (failure) {
        body = (
            <EmptyState
                icon={<SearchX />}
                title={t("errors.loadFailed")}
                description={failure}
                action={
                    <Button
                        variant="outline"
                        onClick={() => {
                            opening.refresh();
                            records.refresh();
                        }}
                    >
                        {t("actions.retry")}
                    </Button>
                }
            />
        );
    } else if (opening.data && !readable) {
        body = (
            <EmptyState
                icon={<ShieldOff />}
                title={t("empty.forbiddenTitle")}
                description={t("empty.forbiddenBody")}
            />
        );
    } else if (!config || !rows) {
        body = <TableSkeleton />;
    } else if (rows.length === 0 && !drafting && search) {
        body = (
            <EmptyState
                icon={<SearchX />}
                title={t("empty.noMatches", { search })}
                action={
                    <Button variant="outline" onClick={() => setTyped("")}>
                        {t("actions.clearSearch")}
                    </Button>
                }
            />
        );
    } else if (rows.length === 0 && !drafting) {
        body = (
            <EmptyState
                icon={<Icon />}
                title={t(`empty.${object}.title`)}
                description={t(`empty.${object}.body`)}
                action={
                    canEdit ? (
                        <Button onClick={() => setDrafting(true)}>
                            <Plus className="size-4" />
                            {t(`objects.${object}.new`)}
                        </Button>
                    ) : null
                }
            />
        );
    } else {
        body = (
            <RecordTable
                object={object}
                columns={columns}
                sorts={config.sorts}
                rows={rows}
                totals={totals.data ?? []}
                people={people}
                canEdit={canEdit}
                canShape
                defaultCurrency={format.preferences.currency}
                selected={selected}
                onSelect={setSelected}
                onEdit={edit}
                onSort={sortBy}
                onColumns={setColumns}
                onAggregate={aggregate}
                draft={drafting ? { onCreate: create, onCancel: () => setDrafting(false) } : null}
                hasMore={rows.length < records.total}
                loadingMore={records.loadingMore}
                onLoadMore={records.loadMore}
            />
        );
    }

    return (
        <div data-crm-ready className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="mr-auto flex min-w-0 items-baseline gap-2">
                    <h1 className="truncate text-[1.0625rem] font-semibold leading-tight tracking-tight" title={title}>{title}</h1>
                    {rows ? (
                        <span className="shrink-0 text-[0.8125rem] tabular-nums text-muted-foreground">
                            {format.number(records.total)}
                        </span>
                    ) : null}
                    {opening.data?.shelfName ? (
                        <span className="truncate text-[0.8125rem] text-muted-foreground" title={opening.data.shelfName}>
                            {opening.data.shelfName}
                        </span>
                    ) : null}
                </div>
                <div className="relative w-full min-w-0 sm:w-56">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={typed}
                        maxLength={200}
                        onChange={(event) => setTyped(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") setTyped("");
                        }}
                        placeholder={t("list.search", { object: title })}
                        aria-label={t("list.search", { object: title })}
                        className="h-8 pl-8"
                        disabled={!readable}
                    />
                </div>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" disabled={!config || !readable}>
                            <Columns3 className="size-4" />
                            {t("columns.fields")}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                        {(config?.columns ?? [])
                            .filter((column) => column.key !== primary.key)
                            .map((column) => (
                                <DropdownMenuItem
                                    key={column.key}
                                    onSelect={(event) => {
                                        event.preventDefault();
                                        toggleColumn(column.key);
                                    }}
                                    className="gap-2"
                                >
                                    <span
                                        className={cn(
                                            "grid size-4 shrink-0 place-items-center rounded border",
                                            column.hidden
                                                ? "border-border-strong bg-field"
                                                : "border-primary bg-primary text-primary-foreground"
                                        )}
                                        aria-hidden
                                    >
                                        {column.hidden ? null : <span className="size-1.5 rounded-sm bg-current" />}
                                    </span>
                                    <span className="truncate">
                                        {t(`fields.${object}.${column.key}` as Parameters<typeof t>[0])}
                                    </span>
                                </DropdownMenuItem>
                            ))}
                    </DropdownMenuContent>
                </DropdownMenu>
                {canEdit ? (
                    <Button size="sm" onClick={() => setDrafting(true)} disabled={!config || drafting}>
                        <Plus className="size-4" />
                        {t(`objects.${object}.new`)}
                    </Button>
                ) : null}
            </div>

            {body}

            {selected.length > 0 ? (
                <div
                    role="toolbar"
                    aria-label={t("selection.toolbar")}
                    className="flex flex-wrap items-center gap-2 self-center rounded-lg border border-border-strong bg-elevated px-3 py-2 shadow-popover"
                >
                    <span className="text-[0.8125rem] font-medium tabular-nums">
                        {t("selection.count", { count: selected.length })}
                    </span>
                    {canEdit ? (
                        <Button size="sm" variant="ghost" onClick={() => setBulkOpen(true)}>
                            <Pencil className="size-4" />
                            {t("selection.edit")}
                        </Button>
                    ) : null}
                    {canDelete ? (
                        <Button size="sm" variant="ghost" className="text-danger" onClick={() => void trash()}>
                            <Trash2 className="size-4" />
                            {t("selection.trash")}
                        </Button>
                    ) : null}
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelected([])}
                        aria-label={t("selection.clear")}
                        title={t("selection.clear")}
                    >
                        <X className="size-4" />
                    </Button>
                </div>
            ) : null}

            {bulkOpen ? (
                <BulkEditDialog
                    object={object}
                    count={selected.length}
                    people={people}
                    defaultCurrency={format.preferences.currency}
                    onApply={bulkEdit}
                    onClose={() => setBulkOpen(false)}
                />
            ) : null}
            {confirmElement}
        </div>
    );
}
