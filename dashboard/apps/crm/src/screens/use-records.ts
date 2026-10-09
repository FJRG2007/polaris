"use client";

/**
 * The rows of one list: the first page painted from what this tab kept and then
 * read again, the pages after it fetched as the reader scrolls, and every change
 * made on screen applied at once (the caller undoes it if the server refuses).
 *
 * A change is also written into what the tab keeps, so coming back to the list
 * paints it as it was left rather than as it was before the change.
 */

import { unwrap } from "./call";
import { useCrmT } from "./i18n";
import * as actions from "../actions/records";
import type { ViewSort } from "../model/views";
import type { ViewFilter } from "../model/filters";
import { hostUi } from "@polaris/app-host/client";
import type { CrmObject, CrmRecord, FieldValue } from "../model/objects";
import { useCallback, useEffect, useRef, useState } from "react";

/** What the tab keeps of a list: its first page. */
const KEPT_ROWS = 50;

/** What every way of holding a list's rows offers the screen that edits them,
 *  flat or in groups. */
export interface RowStore {
    /** Null until there is something to show; every row on screen, in order. */
    readonly rows: readonly CrmRecord[] | null;
    /** How many rows match, across every page (and every group). */
    readonly total: number;
    readonly error: string | null;
    /** Put records on screen as given - an optimistic change, its answer or its
     *  rollback. Records not on screen are ignored. */
    readonly put: (records: readonly CrmRecord[]) => void;
    /** Change some fields of records on screen, leaving their other fields as
     *  they are now - so two edits in flight on one row do not undo each other. */
    readonly patch: (
        changes: readonly { id: string; values: Readonly<Record<string, FieldValue>> }[]
    ) => void;
    /** A new record, at the top. */
    readonly prepend: (record: CrmRecord) => void;
    /** Take records off screen (moved to the trash). */
    readonly drop: (ids: readonly string[]) => void;
    /** What is on screen now, to hand back to `restore` after a refused change. */
    readonly snapshot: () => unknown;
    readonly restore: (snapshot: unknown) => void;
    /** Read the first page again. */
    readonly refresh: () => void;
}

export interface RecordsState extends RowStore {
    /** A page after the first is on its way. */
    readonly loadingMore: boolean;
    readonly loadMore: () => void;
}

interface Listing {
    readonly rows: readonly CrmRecord[];
    readonly total: number;
}

export function useRecords(
    object: CrmObject,
    query: {
        readonly search: string;
        readonly sorts: readonly ViewSort[];
        /** Only its whole rules: a rule being typed does not read the list. */
        readonly filter: ViewFilter;
        /** Off until the view the sorts come from is known, so the list is not
         *  read once unsorted and again sorted. What the tab kept still paints. */
        readonly enabled?: boolean;
    }
): RecordsState {
    const t = useCrmT();
    const sortsKey = query.sorts.map((sort) => `${sort.key}.${sort.direction}`).join(",");
    const filterKey = JSON.stringify(query.filter);
    const key = `crm:list:${object}:${sortsKey}:${filterKey}:${query.search}`;
    const load = useCallback(
        async () =>
            unwrap(
                () =>
                    actions.listRecordsAction({
                        object,
                        search: query.search,
                        sorts: query.sorts,
                        filter: query.filter,
                        offset: 0
                    }),
                t("errors.loadFailed")
            ).then(({ records, total }) => ({ records, total })),
        // The sorts and the filter are read through their keys: a new array
        // with the same sorts is the same read.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [object, query.search, sortsKey, filterKey, t]
    );
    const first = hostUi.liveRead.useLiveRead({
        cacheKey: key,
        load,
        enabled: query.enabled ?? true
    });
    const [listing, setListing] = useState<Listing | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const current = useRef<Listing | null>(null);
    // What is on screen: the listing, or the first page before it is copied in.
    current.current =
        listing ?? (first.data ? { rows: first.data.records, total: first.data.total } : null);
    // The query on screen, so a late page for a search somebody has since
    // changed is thrown away rather than appended.
    const shown = useRef(key);
    shown.current = key;
    // What this hook last wrote into the kept copy, so that value coming back
    // as `first.data` is not taken for a fresh read.
    const echo = useRef<unknown>(null);

    useEffect(() => {
        setListing(null);
    }, [key]);

    useEffect(() => {
        if (!first.data || first.data === echo.current) return;
        setListing({ rows: first.data.records, total: first.data.total });
    }, [first.data]);

    const commit = useCallback(
        (next: Listing) => {
            // Read by the next change before React renders this one.
            current.current = next;
            setListing(next);
            const kept = { records: [...next.rows.slice(0, KEPT_ROWS)], total: next.total };
            echo.current = kept;
            first.replace(kept);
        },
        // `replace` belongs to the key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [key]
    );

    const loadMore = useCallback(() => {
        const listed = current.current;
        if (loadingMore || !listed || listed.rows.length >= listed.total) return;
        const forKey = key;
        setLoadingMore(true);
        unwrap(
            () =>
                actions.listRecordsAction({
                    object,
                    search: query.search,
                    sorts: query.sorts,
                    filter: query.filter,
                    offset: listed.rows.length
                }),
            t("errors.loadFailed")
        )
            .then((page) => {
                if (shown.current !== forKey) return;
                setListing((previous) => {
                    const rows = previous?.rows ?? [];
                    const known = new Set(rows.map((row) => row.id));
                    return {
                        rows: [...rows, ...page.records.filter((row) => !known.has(row.id))],
                        total: page.total
                    };
                });
            })
            .catch(() => undefined)
            .finally(() => setLoadingMore(false));
    }, [loadingMore, key, object, query.search, query.sorts, query.filter, t]);

    const put = useCallback(
        (records: readonly CrmRecord[]) => {
            const listed = current.current;
            if (!listed) return;
            const byId = new Map(records.map((record) => [record.id, record]));
            commit({
                rows: listed.rows.map((row) => byId.get(row.id) ?? row),
                total: listed.total
            });
        },
        [commit]
    );

    const patch = useCallback(
        (changes: readonly { id: string; values: Readonly<Record<string, FieldValue>> }[]) => {
            const listed = current.current;
            if (!listed) return;
            const byId = new Map(changes.map((change) => [change.id, change.values]));
            commit({
                rows: listed.rows.map((row) => {
                    const values = byId.get(row.id);
                    return values ? { ...row, values: { ...row.values, ...values } } : row;
                }),
                total: listed.total
            });
        },
        [commit]
    );

    const prepend = useCallback(
        (record: CrmRecord) => {
            const listed = current.current ?? { rows: [], total: 0 };
            commit({
                rows: [record, ...listed.rows.filter((row) => row.id !== record.id)],
                total: listed.total + 1
            });
        },
        [commit]
    );

    const drop = useCallback(
        (ids: readonly string[]) => {
            const listed = current.current;
            if (!listed) return;
            const gone = new Set(ids);
            const rows = listed.rows.filter((row) => !gone.has(row.id));
            commit({ rows, total: Math.max(0, listed.total - (listed.rows.length - rows.length)) });
        },
        [commit]
    );

    const snapshot = useCallback(() => current.current, []);
    const restore = useCallback(
        (kept: unknown) => {
            if (kept) commit(kept as Listing);
        },
        [commit]
    );

    const visible = current.current;
    return {
        rows: visible?.rows ?? null,
        total: visible?.total ?? 0,
        error: visible ? null : first.error,
        loadingMore,
        loadMore,
        put,
        patch,
        prepend,
        drop,
        snapshot,
        restore,
        refresh: first.refresh
    };
}
