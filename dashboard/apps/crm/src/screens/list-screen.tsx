"use client";

/**
 * One list of records - companies, people or opportunities - drawn the way its
 * chosen view says: a table (in sections when it is grouped) or a board.
 *
 * Opening it reads the views (layout, columns, widths, totals, sorts, filter,
 * grouping), what the reader may do and who may own a record; the rows follow
 * once the view is known. Both are painted from what this tab kept before they
 * are read again, so a revisit shows the list as it was left with no wait. The
 * view picked last is remembered in this browser.
 *
 * Every change lands on screen first and is undone, with a note saying why, if
 * the server refuses it.
 */

import { Board } from "./board";
import { useCrmT } from "./i18n";
import * as views from "../model/views";
import { useGroups } from "./use-groups";
import { messageOf, unwrap } from "./call";
import * as filters from "../model/filters";
import { RecordTable } from "./record-table";
import * as actions from "../actions/records";
import { FilterButton } from "./filter-panel";
import { hostUi } from "@polaris/app-host/client";
import type { InputValue } from "../model/values";
import { BulkEditDialog } from "./bulk-edit-dialog";
import { GroupMenu, SortMenu } from "./arrange-menus";
import { useViewName, ViewPicker } from "./view-picker";
import { useRecords, type RowStore } from "./use-records";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Building2,
    Columns3,
    Kanban,
    Pencil,
    Plus,
    Search,
    SearchX,
    ShieldOff,
    Table2,
    Target,
    Trash2,
    User,
    X
} from "lucide-react";
import {
    fieldOf,
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
    SegmentedControl,
    useToast
} from "@polaris/ui";

/** How long typing in the search box has to pause before the list is read. */
const SEARCH_DELAY_MS = 250;
/** How long a change to the view waits for the next one before it is kept. */
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

/**
 * A view's filter as the list is read with it: only its whole rules, and a
 * moment after the last change - typing a value does not read the list on
 * every letter. A view just opened is read with its filter at once.
 */
function useAppliedFilter(
    object: CrmObject,
    viewId: string | null,
    filter: filters.ViewFilter | null
): filters.ViewFilter {
    const key = JSON.stringify(filters.completeFilter(object, filter ?? filters.EMPTY_FILTER));
    const [settled, setSettled] = useState({ key, viewId });
    useEffect(() => {
        if (settled.viewId !== viewId) {
            setSettled({ key, viewId });
            return;
        }
        const timer = window.setTimeout(() => setSettled({ key, viewId }), SEARCH_DELAY_MS);
        return () => window.clearTimeout(timer);
        // `settled` is what this effect writes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, viewId]);
    const applied = settled.viewId === viewId ? settled.key : key;
    return useMemo(() => JSON.parse(applied) as filters.ViewFilter, [applied]);
}

/** The view this browser last opened for a kind of record. */
function rememberedView(object: CrmObject): string | null {
    try {
        return window.localStorage.getItem(`crm:view:${object}`);
    } catch {
        return null;
    }
}

function rememberView(object: CrmObject, id: string): void {
    try {
        window.localStorage.setItem(`crm:view:${object}`, id);
    } catch {
        // Private windows and blocked storage: the default view opens next time.
    }
}

function TableSkeleton() {
    return (
        <div
            className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden rounded-lg border border-border bg-card"
            aria-hidden
        >
            {Array.from({ length: 9 }, (_, index) => (
                <div
                    key={index}
                    className="flex h-9 items-center gap-6 border-b border-border px-3"
                >
                    <span className="block h-3 w-40 animate-pulse rounded bg-muted" />
                    <span className="block h-3 w-24 animate-pulse rounded bg-muted" />
                    <span className="block h-3 w-32 animate-pulse rounded bg-muted" />
                </div>
            ))}
        </div>
    );
}

function BoardSkeleton() {
    return (
        <div className="flex min-h-0 flex-1 gap-3 overflow-hidden" aria-hidden>
            {Array.from({ length: 4 }, (_, index) => (
                <div
                    key={index}
                    className="flex w-[17rem] shrink-0 flex-col gap-2 rounded-lg border border-border bg-muted/40 p-2"
                >
                    <span className="block h-4 w-24 animate-pulse rounded bg-muted" />
                    {Array.from({ length: 3 }, (_, card) => (
                        <span key={card} className="block h-16 animate-pulse rounded-md bg-muted" />
                    ))}
                </div>
            ))}
        </div>
    );
}

interface Layout {
    readonly viewId: string;
    readonly kind: views.ViewKind;
    readonly config: views.ViewConfig;
}

export function ListScreen({ object }: { object: CrmObject }) {
    const t = useCrmT();
    const toast = useToast();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const viewName = useViewName();
    const primary = primaryField(object);
    const Icon = OBJECT_ICON[object];

    // The views, the reader's abilities and the shelf's people.
    const loadOpening = useCallback(
        () => unwrap(() => actions.openListAction({ object }), t("errors.loadFailed")),
        [object, t]
    );
    const opening = hostUi.liveRead.useLiveRead({
        cacheKey: `crm:open:${object}`,
        load: loadOpening
    });
    const openingRef = useRef(opening);
    openingRef.current = opening;
    const can = opening.data?.can[object] ?? null;
    const people = opening.data?.people ?? [];
    const allViews = useMemo(() => {
        const data = opening.data;
        if (!data) return [];
        // An answer kept from before views were listed carries only the default.
        return data.views?.length ? data.views : data.view ? [data.view] : [];
    }, [opening.data]);

    const [chosenId, setChosenId] = useState<string | null>(() => rememberedView(object));
    const view = allViews.find((one) => one.id === chosenId) ?? allViews[0] ?? null;

    // How the view is drawn on screen. Changed here first and kept on the
    // server a moment later; a read of the views that lands while a change is
    // waiting to be kept does not put the old layout back.
    const [local, setLocal] = useState<Layout | null>(null);
    const savingFor = useRef<string | null>(null);
    const pending = useRef<{ timer: number; run: () => void } | null>(null);
    useEffect(() => {
        if (savingFor.current !== view?.id) setLocal(null);
    }, [opening.data, view?.id]);
    const layout = useMemo<Layout | null>(() => {
        if (!view) return null;
        if (local && local.viewId === view.id) return local;
        return { viewId: view.id, kind: view.kind, config: views.readConfig(object, view.config) };
    }, [view, local, object]);
    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    const config = layout?.config ?? null;
    const kind = layout?.kind ?? "table";

    /** A change waiting to be kept is kept now - before another view opens. */
    const flush = useCallback(() => {
        const waiting = pending.current;
        if (!waiting) return;
        window.clearTimeout(waiting.timer);
        pending.current = null;
        waiting.run();
    }, []);
    useEffect(
        () => () => {
            if (pending.current) window.clearTimeout(pending.current.timer);
        },
        []
    );

    const shape = useCallback(
        (change: { readonly config?: views.ViewConfig; readonly kind?: views.ViewKind }) => {
            const opened = openingRef.current.data;
            const current = layoutRef.current;
            if (!opened || !current) return;
            const next: Layout = {
                viewId: current.viewId,
                kind: change.kind ?? current.kind,
                config: change.config ?? current.config
            };
            setLocal(next);
            savingFor.current = next.viewId;
            const changed = (one: views.ViewSummary) =>
                one.id === next.viewId ? { ...one, kind: next.kind, config: next.config } : one;
            openingRef.current.replace({
                ...opened,
                view: opened.view ? changed(opened.view) : opened.view,
                views: (opened.views ?? []).map(changed)
            });
            // Somebody who may not change records may still shape the list for
            // themselves; only an editor's layout is kept for everyone.
            if (!opened.can[object].edit) return;
            if (pending.current) window.clearTimeout(pending.current.timer);
            const run = () => {
                unwrap(
                    () =>
                        actions.saveViewAction({
                            object,
                            viewId: next.viewId,
                            config: next.config,
                            kind: next.kind
                        }),
                    t("errors.generic")
                )
                    .catch((caught) =>
                        toast.show({ title: t("errors.viewNotSaved"), body: messageOf(caught) })
                    )
                    .finally(() => {
                        if (!pending.current && savingFor.current === next.viewId) {
                            savingFor.current = null;
                        }
                    });
            };
            pending.current = {
                timer: window.setTimeout(() => {
                    pending.current = null;
                    run();
                }, SAVE_DELAY_MS),
                run
            };
        },
        [object, t, toast]
    );

    const [typed, setTyped] = useState("");
    const search = useDebounced(typed.trim(), SEARCH_DELAY_MS);
    const sorts = useMemo(() => config?.sorts ?? [], [config]);
    const readable = Boolean(can?.read);
    const filter = useAppliedFilter(object, view?.id ?? null, config?.filter ?? null);
    const activeFilters = config ? filters.activeRules(object, config.filter) : 0;
    const boardBy = config && kind === "kanban" ? views.boardField(object, config) : null;
    const groupField: FieldDef | null =
        kind === "kanban"
            ? boardBy
            : config?.groupBy
              ? (fieldOf(object, config.groupBy) ?? null)
              : null;
    const ready = config !== null && readable;
    const flat = useRecords(object, {
        search,
        sorts,
        filter,
        enabled: ready && groupField === null
    });
    const grouped = useGroups(object, {
        key: groupField?.key ?? null,
        search,
        sorts,
        filter,
        byPosition: kind === "kanban",
        enabled: ready && groupField !== null
    });
    const store: RowStore = groupField ? grouped : flat;

    // Totals over the whole match, under a table.
    const asked = useMemo(
        () =>
            (config?.columns ?? [])
                .filter((column) => !column.hidden && column.aggregate)
                .map((column) => ({
                    key: column.key,
                    aggregate: column.aggregate as views.Aggregate
                })),
        [config]
    );
    const askedKey = asked.map((one) => `${one.key}.${one.aggregate}`).join(",");
    const filterKey = JSON.stringify(filter);
    const loadTotals = useCallback(
        () =>
            unwrap(
                () => actions.totalsAction({ object, search, filter, asked }),
                t("errors.loadFailed")
            ).then((answer) => answer.totals),
        // `asked` and `filter` are read through their keys.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [object, search, askedKey, filterKey, t]
    );
    const totals = hostUi.liveRead.useLiveRead({
        cacheKey: `crm:totals:${object}:${askedKey}:${filterKey}:${search}`,
        load: loadTotals,
        enabled: readable && kind === "table" && asked.length > 0
    });
    const refreshTotals = totals.refresh;

    const [selected, setSelected] = useState<string[]>([]);
    const [drafting, setDrafting] = useState(false);
    const [bulkOpen, setBulkOpen] = useState(false);
    // Chosen rows that have left the screen - trashed, or filtered away - are
    // no longer chosen.
    const rowIds = useMemo(() => new Set((store.rows ?? []).map((row) => row.id)), [store.rows]);
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
            store.patch([{ id: record.id, values: { [field.key]: shown } }]);
            unwrap(
                () =>
                    actions.updateRecordAction({
                        object,
                        id: record.id,
                        values: { [field.key]: stored }
                    }),
                t("errors.generic")
            )
                .then(({ record: saved }) => {
                    if (latest.current.get(slot) !== turn) return;
                    store.patch([
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
                    store.patch([{ id: record.id, values: { [field.key]: before } }]);
                    failed(t("errors.notSaved"), caught);
                });
        },
        [object, store, refreshTotals, failed, t]
    );

    const bulkEdit = useCallback(
        (field: FieldDef, stored: InputValue, shown: FieldValue) => {
            const ids = [...selected];
            const rows = (store.rows ?? []).filter((row) => ids.includes(row.id));
            const before = rows.map((row) => ({
                id: row.id,
                values: { [field.key]: row.values[field.key] ?? null }
            }));
            store.patch(ids.map((id) => ({ id, values: { [field.key]: shown } })));
            unwrap(
                () => actions.updateRecordsAction({ object, ids, values: { [field.key]: stored } }),
                t("errors.generic")
            )
                .then(({ records: saved }) => {
                    store.put(saved);
                    refreshTotals();
                    toast.show({ title: t("bulk.done", { count: saved.length }) });
                })
                .catch((caught) => {
                    store.patch(before);
                    failed(t("errors.notSaved"), caught);
                });
        },
        [object, store, refreshTotals, selected, toast, failed, t]
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
        const kept = store.snapshot();
        store.drop(ids);
        setSelected([]);
        unwrap(() => actions.trashRecordsAction({ object, ids }), t("errors.generic"))
            .then(({ count }) => {
                refreshTotals();
                toast.show({ title: t("trash.done", { count }) });
            })
            .catch((caught) => {
                store.restore(kept);
                failed(t("errors.notTrashed"), caught);
            });
    }, [confirm, object, store, refreshTotals, selected, toast, failed, t]);

    const drafts = useRef(0);
    /** A new record with this name, and the group's choice when it is made in
     *  a board column. */
    const create = useCallback(
        (value: InputValue, choice?: { key: string; value: string }) => {
            setDrafting(false);
            drafts.current += 1;
            const values: Record<string, unknown> = { [primary.key]: value };
            if (choice) values[choice.key] = choice.value;
            // Until the answer, a new row in a grouped list sits in the group a
            // record starts in: the field's first choice.
            const shownIn =
                choice ?? (groupField ? { key: groupField.key, value: groupField.options![0]! } : null);
            const temporary: CrmRecord = {
                id: `draft:${drafts.current}`,
                position: Number.NEGATIVE_INFINITY,
                deletedAt: null,
                values: {
                    [primary.key]: value as FieldValue,
                    ...(shownIn ? { [shownIn.key]: shownIn.value } : {})
                }
            };
            store.prepend(temporary);
            unwrap(() => actions.createRecordAction({ object, values }), t("errors.generic"))
                .then(({ record }) => {
                    store.drop([temporary.id]);
                    store.prepend(record);
                    refreshTotals();
                })
                .catch((caught) => {
                    store.drop([temporary.id]);
                    failed(t("errors.notCreated"), caught);
                });
        },
        [object, primary.key, groupField, store, refreshTotals, failed, t]
    );

    const moveCard = useCallback(
        (record: CrmRecord, value: string, beforeId: string | null) => {
            if (!groupField) return;
            const kept = grouped.snapshot();
            const position = grouped.move(record, value, beforeId);
            unwrap(
                () =>
                    actions.moveRecordAction({
                        object,
                        id: record.id,
                        key: groupField.key,
                        value,
                        position
                    }),
                t("errors.generic")
            )
                .then(({ record: saved }) => grouped.put([saved]))
                .catch((caught) => {
                    grouped.restore(kept);
                    failed(t("errors.notMoved"), caught);
                });
        },
        [object, groupField, grouped, failed, t]
    );

    // The views: switching, saving a new one, renaming and removing.
    const pick = useCallback(
        (next: views.ViewSummary) => {
            flush();
            setChosenId(next.id);
            rememberView(object, next.id);
            setSelected([]);
            setDrafting(false);
        },
        [flush, object]
    );

    const createView = useCallback(
        async (name: string, viewKind: views.ViewKind) => {
            if (!config) return;
            const { view: made } = await unwrap(
                () => actions.createViewAction({ object, name, kind: viewKind, config }),
                t("errors.generic")
            );
            const opened = openingRef.current.data;
            if (opened) {
                openingRef.current.replace({ ...opened, views: [...(opened.views ?? []), made] });
            }
            pick(made);
            toast.show({ title: t("views.created", { name: made.name }) });
        },
        [config, object, pick, t, toast]
    );

    const renameView = useCallback(
        async (target: views.ViewSummary, name: string) => {
            const opened = openingRef.current.data;
            if (!opened) return;
            const named = (label: string) => (one: views.ViewSummary) =>
                one.id === target.id ? { ...one, name: label } : one;
            openingRef.current.replace({ ...opened, views: (opened.views ?? []).map(named(name)) });
            unwrap(
                () => actions.renameViewAction({ object, viewId: target.id, name }),
                t("errors.generic")
            ).catch((caught) => {
                const now = openingRef.current.data;
                if (now) {
                    openingRef.current.replace({
                        ...now,
                        views: (now.views ?? []).map(named(target.name))
                    });
                }
                failed(t("errors.viewNotRenamed"), caught);
            });
        },
        [object, failed, t]
    );

    const deleteView = useCallback(
        async (target: views.ViewSummary) => {
            const ok = await confirm({
                title: t("views.deleteTitle", { name: viewName(target) }),
                description: t("views.deleteDescription"),
                confirmLabel: t("views.delete"),
                danger: true
            });
            const opened = openingRef.current.data;
            if (!ok || !opened) return;
            if (pending.current?.run && savingFor.current === target.id) {
                window.clearTimeout(pending.current.timer);
                pending.current = null;
            }
            const before = opened.views ?? [];
            openingRef.current.replace({
                ...opened,
                views: before.filter((one) => one.id !== target.id)
            });
            const fallback = before[0];
            if (fallback && chosenId === target.id) pick(fallback);
            unwrap(
                () => actions.deleteViewAction({ object, viewId: target.id }),
                t("errors.generic")
            )
                .then(() => toast.show({ title: t("views.deleted", { name: viewName(target) }) }))
                .catch((caught) => {
                    const now = openingRef.current.data;
                    if (now) openingRef.current.replace({ ...now, views: before });
                    failed(t("errors.viewNotDeleted"), caught);
                });
        },
        [chosenId, confirm, object, pick, toast, failed, t, viewName]
    );

    const columns = useMemo(
        () => (config?.columns ?? []).filter((column) => !column.hidden),
        [config]
    );
    const setConfig = (next: Partial<views.ViewConfig>) => {
        if (!config) return;
        shape({ config: { ...config, ...next } });
    };
    const setColumns = (next: views.ViewColumn[]) => {
        if (!config) return;
        // `next` is the visible columns in their new order; the hidden ones
        // keep their places after them.
        const shown = new Set(next.map((column) => column.key));
        setConfig({
            columns: [...next, ...config.columns.filter((column) => !shown.has(column.key))]
        });
    };
    const toggleColumn = (key: string) => {
        if (!config) return;
        setConfig({
            columns: config.columns.map((column) =>
                column.key === key ? { ...column, hidden: !column.hidden } : column
            )
        });
    };
    const sortBy = (key: string, direction: "asc" | "desc" | null) => {
        if (!config) return;
        setConfig({
            sorts: direction
                ? [{ key, direction }]
                : config.sorts.filter((sort) => sort.key !== key)
        });
    };
    const aggregate = (key: string, value: views.Aggregate | null) => {
        if (!config) return;
        setConfig({
            columns: config.columns.map((column) =>
                column.key === key ? { ...column, aggregate: value } : column
            )
        });
    };
    const setKind = (next: views.ViewKind) => {
        if (next === kind) return;
        setSelected([]);
        setDrafting(false);
        shape({ kind: next });
    };

    const title = t(`objects.${object}.plural`);
    const canEdit = Boolean(can?.edit);
    const canDelete = Boolean(can?.delete);
    const rows = store.rows;
    const boardable = views.groupFields(object).length > 0;
    const narrowed = Boolean(search) || activeFilters > 0;
    const failure =
        (!opening.data && opening.error) || (readable && !rows && store.error) || null;

    const clearNarrowing = () => {
        setTyped("");
        if (activeFilters > 0) setConfig({ filter: filters.EMPTY_FILTER });
    };

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
                            store.refresh();
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
        body = kind === "kanban" ? <BoardSkeleton /> : <TableSkeleton />;
    } else if (kind === "kanban" && boardBy && grouped.groups) {
        body = (
            <Board
                object={object}
                field={boardBy}
                groups={grouped.groups}
                columns={columns}
                canEdit={canEdit}
                sorted={config.sorts.length > 0}
                loadingGroup={grouped.loadingGroup}
                onLoadMore={grouped.loadMore}
                onMove={moveCard}
                onCreate={(value, name) => create(name, { key: boardBy.key, value })}
            />
        );
    } else if (rows.length === 0 && !drafting && narrowed) {
        body = (
            <EmptyState
                icon={<SearchX />}
                title={search ? t("empty.noMatches", { search }) : t("empty.filtered")}
                action={
                    <Button variant="outline" onClick={clearNarrowing}>
                        {activeFilters > 0 ? t("actions.clearFilters") : t("actions.clearSearch")}
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
                hasMore={rows.length < flat.total}
                loadingMore={flat.loadingMore}
                onLoadMore={flat.loadMore}
                grouping={
                    groupField && grouped.groups
                        ? {
                              field: groupField,
                              groups: grouped.groups,
                              loadingGroup: grouped.loadingGroup,
                              onLoadMore: grouped.loadMore
                          }
                        : null
                }
            />
        );
    }

    const shaping = !config || !readable;

    return (
        <div data-crm-ready className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="mr-auto flex min-w-0 items-baseline gap-2">
                    <h1
                        className="truncate text-[1.0625rem] font-semibold leading-tight tracking-tight"
                        title={title}
                    >
                        {title}
                    </h1>
                    {rows ? (
                        <span className="shrink-0 text-[0.8125rem] tabular-nums text-muted-foreground">
                            {format.number(store.total)}
                        </span>
                    ) : null}
                    {opening.data?.shelfName ? (
                        <span
                            className="truncate text-[0.8125rem] text-muted-foreground"
                            title={opening.data.shelfName}
                        >
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
                {canEdit && kind === "table" ? (
                    <Button
                        size="sm"
                        onClick={() => setDrafting(true)}
                        disabled={!config || drafting}
                    >
                        <Plus className="size-4" />
                        {t(`objects.${object}.new`)}
                    </Button>
                ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <div className="mr-auto flex min-w-0 max-w-full items-center">
                    <ViewPicker
                        object={object}
                        views={allViews}
                        current={view}
                        canEdit={canEdit}
                        disabled={!readable}
                        onPick={pick}
                        onCreate={createView}
                        onRename={renameView}
                        onDelete={(target) => void deleteView(target)}
                    />
                </div>
                <SegmentedControl
                    size="sm"
                    value={kind}
                    onValueChange={setKind}
                    aria-label={t("views.layout")}
                    options={[
                        {
                            value: "table",
                            label: (
                                <span className="flex items-center gap-1.5">
                                    <Table2 className="size-3.5 shrink-0" />
                                    {t("views.kinds.table")}
                                </span>
                            ),
                            disabled: shaping
                        },
                        {
                            value: "kanban",
                            label: (
                                <span className="flex items-center gap-1.5">
                                    <Kanban className="size-3.5 shrink-0" />
                                    {t("views.kinds.kanban")}
                                </span>
                            ),
                            title: boardable ? undefined : t("views.noBoard"),
                            disabled: shaping || !boardable
                        }
                    ]}
                />
                <FilterButton
                    object={object}
                    filter={config?.filter ?? filters.EMPTY_FILTER}
                    people={people}
                    disabled={shaping}
                    onChange={(next) => setConfig({ filter: next })}
                />
                <SortMenu
                    object={object}
                    sorts={sorts}
                    disabled={shaping}
                    onChange={(next) => setConfig({ sorts: next })}
                />
                {kind === "table" || views.groupFields(object).length > 1 ? (
                    <GroupMenu
                        object={object}
                        board={kind === "kanban"}
                        value={groupField}
                        disabled={shaping}
                        onChange={(key) =>
                            setConfig(kind === "kanban" ? { boardBy: key } : { groupBy: key })
                        }
                    />
                ) : null}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" disabled={shaping}>
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
                                        {column.hidden ? null : (
                                            <span className="size-1.5 rounded-sm bg-current" />
                                        )}
                                    </span>
                                    <span className="truncate">
                                        {t(
                                            `fields.${object}.${column.key}` as Parameters<
                                                typeof t
                                            >[0]
                                        )}
                                    </span>
                                </DropdownMenuItem>
                            ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>

            {body}

            {selected.length > 0 && kind === "table" ? (
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
                        <Button
                            size="sm"
                            variant="ghost"
                            className="text-danger"
                            onClick={() => void trash()}
                        >
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
