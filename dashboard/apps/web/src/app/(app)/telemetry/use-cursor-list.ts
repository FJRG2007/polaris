"use client";

/**
 * A list read one page at a time, as the reader scrolls.
 *
 * Every Telemetry list (projects, issues, events, an issue's log) is a cursor
 * walk over the database rather than a whole table sent at once: the first page
 * paints, the next is asked for when the last rows come into view, and a change
 * of filter starts over without waiting on a page still in flight.
 */

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

export interface CursorPage<T> {
    readonly items: readonly T[];
    readonly next: string | null;
}

export interface CursorList<T> {
    /** Null until the first page arrives, which is what a skeleton waits on. */
    readonly items: readonly T[] | null;
    readonly setItems: (change: SetStateAction<readonly T[]>) => void;
    readonly more: boolean;
    readonly paging: boolean;
    readonly error: string;
    readonly loadMore: () => void;
    readonly reload: () => void;
}

export function useCursorList<T, P extends CursorPage<T> = CursorPage<T>>(
    read: (
        cursor: string | null,
        signal: AbortSignal
    ) => Promise<{ data?: P; error?: string } | undefined>,
    /** Starts the walk over when it changes: the filter, the sort, the project. */
    key: string,
    onPage?: (page: P) => void
): CursorList<T> {
    const [items, setRows] = useState<readonly T[] | null>(null);
    const [next, setNext] = useState<string | null>(null);
    const [paging, setPaging] = useState(false);
    const [error, setError] = useState("");
    const [round, setRound] = useState(0);
    const generation = useRef(0);
    const pending = useRef<AbortController | null>(null);
    const reader = useRef(read);
    reader.current = read;
    const seen = useRef(onPage);
    seen.current = onPage;

    const fetchPage = useCallback(async (cursor: string | null) => {
        const mine = generation.current;
        pending.current?.abort();
        const controller = new AbortController();
        pending.current = controller;
        setPaging(true);
        try {
            const result = await reader.current(cursor, controller.signal);
            if (mine !== generation.current || controller.signal.aborted) return;
            if (!result || result.error || !result.data) {
                setError(result?.error ?? "");
                if (cursor === null) setRows((rows) => rows ?? []);
                return;
            }
            const page = result.data;
            setError("");
            seen.current?.(page);
            setRows((rows) => (cursor === null || !rows ? [...page.items] : [...rows, ...page.items]));
            setNext(page.next);
        } catch (caught) {
            if (controller.signal.aborted) return;
            setError(caught instanceof Error ? caught.message : "");
            if (cursor === null) setRows((rows) => rows ?? []);
        } finally {
            if (mine === generation.current) setPaging(false);
        }
    }, []);

    useEffect(() => {
        generation.current += 1;
        setRows(null);
        setNext(null);
        void fetchPage(null);
        return () => pending.current?.abort();
    }, [key, round, fetchPage]);

    const loadMore = useCallback(() => {
        if (next && !paging) void fetchPage(next);
    }, [next, paging, fetchPage]);

    const setItems = useCallback(
        (change: SetStateAction<readonly T[]>) =>
            setRows((rows) =>
                typeof change === "function" ? change(rows ?? []) : change
            ),
        []
    );

    return {
        items,
        setItems,
        more: next !== null,
        paging,
        error,
        loadMore,
        reload: () => setRound((value) => value + 1)
    };
}
