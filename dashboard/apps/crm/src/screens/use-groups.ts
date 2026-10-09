"use client";

/**
 * The rows of a list split by one field - the sections of a grouped table, the
 * columns of a board. Every group's first page arrives in one read, painted
 * from what this tab kept first; each group asks for its next page on its own.
 *
 * Offers the same changes as a flat list (`RowStore`), so the screen edits,
 * creates and trashes rows the same way in both. A change to the field the
 * list is grouped by moves the row to its new group; `move` puts a card at a
 * chosen place in a column.
 */

import { unwrap } from "./call";
import { useCrmT } from "./i18n";
import * as actions from "../actions/records";
import type { RowStore } from "./use-records";
import type { ViewSort } from "../model/views";
import { hostUi } from "@polaris/app-host/client";
import type { ViewFilter } from "../model/filters";
import type { CrmObject, CrmRecord, FieldValue } from "../model/objects";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** What the tab keeps of each group: its first page. */
const KEPT_ROWS = 50;

export interface RowGroup {
    /** The choice of the grouping field this group holds. */
    readonly value: string;
    readonly rows: readonly CrmRecord[];
    /** How many rows of this group match, across every page. */
    readonly total: number;
}

export interface GroupsState extends RowStore {
    readonly groups: readonly RowGroup[] | null;
    /** The group whose next page is on its way. */
    readonly loadingGroup: string | null;
    readonly loadMore: (value: string) => void;
    /** Put a record in a group, before the row with `beforeId` (null: at the
     *  end). Returns the place it was given between its new neighbours, and
     *  whether it went after a group whose last cards are not loaded yet. */
    readonly move: (
        record: CrmRecord,
        value: string,
        beforeId: string | null
    ) => { readonly position: number; readonly last: boolean };
}

type Kept = { groups: { value: string; records: CrmRecord[]; total: number }[] };

/** The place between two neighbours: halfway, or a step past the one there is. */
export function placeBetween(before: number | undefined, after: number | undefined): number {
    if (before !== undefined && after !== undefined) return (before + after) / 2;
    if (after !== undefined) return after - 1;
    if (before !== undefined) return before + 1;
    return 0;
}

export function useGroups(
    object: CrmObject,
    query: {
        /** The field the rows are grouped by; null reads nothing. */
        readonly key: string | null;
        readonly search: string;
        readonly sorts: readonly ViewSort[];
        readonly filter: ViewFilter;
        /** A board's order when it has no sorts: where its cards were put. */
        readonly byPosition: boolean;
        readonly enabled: boolean;
    }
): GroupsState {
    const t = useCrmT();
    const sortsKey = query.sorts.map((sort) => `${sort.key}.${sort.direction}`).join(",");
    const filterKey = JSON.stringify(query.filter);
    const groupKey = query.key;
    const key = `crm:groups:${object}:${groupKey}:${query.byPosition}:${sortsKey}:${filterKey}:${query.search}`;
    const load = useCallback(
        async (): Promise<Kept> =>
            unwrap(
                () =>
                    actions.listGroupsAction({
                        object,
                        key: groupKey,
                        search: query.search,
                        sorts: query.sorts,
                        filter: query.filter,
                        byPosition: query.byPosition
                    }),
                t("errors.loadFailed")
            ).then(({ groups }) => ({
                groups: groups.map((group) => ({
                    value: group.value,
                    records: group.records,
                    total: group.total
                }))
            })),
        // The sorts and the filter are read through their keys.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [object, groupKey, query.search, query.byPosition, sortsKey, filterKey, t]
    );
    const first = hostUi.liveRead.useLiveRead({
        cacheKey: key,
        load,
        enabled: query.enabled && groupKey !== null
    });
    const fromKept = (kept: Kept | null | undefined): RowGroup[] | null =>
        kept
            ? kept.groups.map((group) => ({
                  value: group.value,
                  rows: group.records,
                  total: group.total
              }))
            : null;

    const [listing, setListing] = useState<readonly RowGroup[] | null>(null);
    const [loadingGroup, setLoadingGroup] = useState<string | null>(null);
    const current = useRef<readonly RowGroup[] | null>(null);
    current.current = listing ?? fromKept(first.data);
    const shown = useRef(key);
    shown.current = key;
    const echo = useRef<unknown>(null);

    useEffect(() => {
        setListing(null);
    }, [key]);

    useEffect(() => {
        if (!first.data || first.data === echo.current) return;
        setListing(fromKept(first.data));
    }, [first.data]);

    const commit = useCallback(
        (next: readonly RowGroup[]) => {
            current.current = next;
            setListing(next);
            const kept: Kept = {
                groups: next.map((group) => ({
                    value: group.value,
                    records: [...group.rows.slice(0, KEPT_ROWS)],
                    total: group.total
                }))
            };
            echo.current = kept;
            first.replace(kept);
        },
        // `replace` belongs to the key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [key]
    );

    const loadMore = useCallback(
        (value: string) => {
            const group = current.current?.find((one) => one.value === value);
            if (loadingGroup || !group || !groupKey || group.rows.length >= group.total) return;
            const forKey = key;
            setLoadingGroup(value);
            unwrap(
                () =>
                    actions.listRecordsAction({
                        object,
                        search: query.search,
                        sorts: query.sorts,
                        filter: query.filter,
                        byPosition: query.byPosition,
                        group: { key: groupKey, value },
                        offset: group.rows.length
                    }),
                t("errors.loadFailed")
            )
                .then((page) => {
                    if (shown.current !== forKey) return;
                    setListing((previous) =>
                        (previous ?? current.current ?? []).map((one) => {
                            if (one.value !== value) return one;
                            const known = new Set(one.rows.map((row) => row.id));
                            return {
                                ...one,
                                rows: [
                                    ...one.rows,
                                    ...page.records.filter((row) => !known.has(row.id))
                                ],
                                total: page.total
                            };
                        })
                    );
                })
                .catch(() => undefined)
                .finally(() => setLoadingGroup(null));
        },
        [
            loadingGroup,
            groupKey,
            key,
            object,
            query.search,
            query.sorts,
            query.filter,
            query.byPosition,
            t
        ]
    );

    /** The groups with each row run through `change`; a row whose grouping
     *  field now holds another choice is moved to the top of that group. */
    const regroup = useCallback(
        (change: (row: CrmRecord) => CrmRecord) => {
            const listed = current.current;
            if (!listed || !groupKey) return;
            const moving: CrmRecord[] = [];
            const kept = listed.map((group) => {
                const rows: CrmRecord[] = [];
                let left = 0;
                for (const row of group.rows) {
                    const next = change(row);
                    if (
                        next.values[groupKey] !== undefined &&
                        next.values[groupKey] !== group.value
                    ) {
                        moving.push(next);
                        left += 1;
                    } else {
                        rows.push(next);
                    }
                }
                return { ...group, rows, total: group.total - left };
            });
            commit(
                kept.map((group) => {
                    const arriving = moving.filter((row) => row.values[groupKey] === group.value);
                    return arriving.length === 0
                        ? group
                        : {
                              ...group,
                              rows: [...arriving, ...group.rows],
                              total: group.total + arriving.length
                          };
                })
            );
        },
        [commit, groupKey]
    );

    const put = useCallback(
        (records: readonly CrmRecord[]) => {
            const byId = new Map(records.map((record) => [record.id, record]));
            regroup((row) => byId.get(row.id) ?? row);
        },
        [regroup]
    );

    const patch = useCallback(
        (changes: readonly { id: string; values: Readonly<Record<string, FieldValue>> }[]) => {
            const byId = new Map(changes.map((change) => [change.id, change.values]));
            regroup((row) => {
                const values = byId.get(row.id);
                return values ? { ...row, values: { ...row.values, ...values } } : row;
            });
        },
        [regroup]
    );

    const prepend = useCallback(
        (record: CrmRecord) => {
            const listed = current.current;
            if (!listed || !groupKey) return;
            commit(
                listed.map((group) =>
                    group.value === record.values[groupKey]
                        ? {
                              ...group,
                              rows: [record, ...group.rows.filter((row) => row.id !== record.id)],
                              total: group.total + 1
                          }
                        : group
                )
            );
        },
        [commit, groupKey]
    );

    const drop = useCallback(
        (ids: readonly string[]) => {
            const listed = current.current;
            if (!listed) return;
            const gone = new Set(ids);
            commit(
                listed.map((group) => {
                    const rows = group.rows.filter((row) => !gone.has(row.id));
                    return {
                        ...group,
                        rows,
                        total: Math.max(0, group.total - (group.rows.length - rows.length))
                    };
                })
            );
        },
        [commit]
    );

    const move = useCallback(
        (record: CrmRecord, value: string, beforeId: string | null) => {
            const listed = current.current;
            if (!listed || !groupKey) return { position: record.position, last: false };
            const target = listed.find((group) => group.value === value);
            const others = (target?.rows ?? []).filter((row) => row.id !== record.id);
            const at =
                beforeId === null ? others.length : others.findIndex((row) => row.id === beforeId);
            const index = at < 0 ? others.length : at;
            const position = placeBetween(others[index - 1]?.position, others[index]?.position);
            const unloaded = (target?.total ?? 0) - (target?.rows.length ?? 0);
            const last = index === others.length && unloaded > 0;
            const moved: CrmRecord = {
                ...record,
                position,
                values: { ...record.values, [groupKey]: value }
            };
            commit(
                listed.map((group) => {
                    const had = group.rows.some((row) => row.id === record.id);
                    if (group.value === value) {
                        const rows = [...others];
                        rows.splice(index, 0, moved);
                        return { ...group, rows, total: group.total + (had ? 0 : 1) };
                    }
                    if (!had) return group;
                    return {
                        ...group,
                        rows: group.rows.filter((row) => row.id !== record.id),
                        total: Math.max(0, group.total - 1)
                    };
                })
            );
            return { position, last };
        },
        [commit, groupKey]
    );

    const snapshot = useCallback(() => current.current, []);
    const restore = useCallback(
        (kept: unknown) => {
            if (kept) commit(kept as readonly RowGroup[]);
        },
        [commit]
    );

    const groups = current.current;
    const rows = useMemo(() => (groups ? groups.flatMap((group) => group.rows) : null), [groups]);
    return {
        groups,
        rows,
        total: groups ? groups.reduce((sum, group) => sum + group.total, 0) : 0,
        error: groups ? null : first.error,
        loadingGroup,
        loadMore,
        put,
        patch,
        prepend,
        drop,
        move,
        snapshot,
        restore,
        refresh: first.refresh
    };
}
