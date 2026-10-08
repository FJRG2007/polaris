"use client";

/**
 * A list read a page at a time from the server, as somebody scrolls.
 *
 * The first page arrives with the screen, rendered on the server, so nothing
 * waits on a request to paint. Every page after it is asked for with the cursor
 * the one before ended on. Changing what the list is narrowed by - a search, a
 * cut - starts it again from the top, and an answer that arrives for a question
 * nobody is asking any more is dropped rather than painted over the current one.
 * When the request for a new search fails, the rows of the old one go with it -
 * they answer a question nobody is asking - and `retry` asks the failed request
 * again rather than the next page of a list no longer on screen.
 *
 * `refresh` reads again everything already on screen, in one request, for the
 * moments a list has to catch up with a change: an action taken on a row, or a
 * poll. Reading the first page again instead would throw away the hundred rows
 * somebody had scrolled down to. It runs by itself whenever the server renders
 * the screen again - a `router.refresh()` after an action hands down a new first
 * page - so a screen that already refreshes after every change keeps doing just
 * that.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface ListPage<T> {
    readonly items: T[];
    readonly next: string | null;
}

/** How a page is asked for: from a cursor (null for the top), with how many
 *  rows, under whatever the list is narrowed by. */
export type LoadPage<T, P> = (
    cursor: string | null,
    params: P,
    limit?: number
) => Promise<ListPage<T> | { error: string }>;

/** The most a refresh reads back at once - the same ceiling the server keeps. */
const REFRESH_MAX = 200;

export interface PagedList<T> {
    readonly items: T[];
    readonly hasMore: boolean;
    readonly loading: boolean;
    readonly error: string | null;
    /** Ask for the next page, unless one is on its way or there is none. */
    readonly loadMore: () => void;
    /** Read again what is on screen. */
    readonly refresh: () => Promise<void>;
    /** Ask again for whatever failed last. */
    readonly retry: () => void;
}

interface Request {
    readonly cursor: string | null;
    readonly replace: boolean;
    readonly limit?: number;
    /** A new question: what was on screen no longer answers it. */
    readonly restart: boolean;
}

export function usePagedList<T, P>({
    first,
    params,
    initialParams,
    load
}: {
    /** The first page under `initialParams`, as the server rendered it - the
     *  prop itself, held as it arrives. A new object here is read as the server
     *  having drawn the screen again, so one built during render would refresh
     *  on every render. */
    first: ListPage<T>;
    params: P;
    initialParams: P;
    load: LoadPage<T, P>;
}): PagedList<T> {
    const [items, setItems] = useState(first.items);
    const [next, setNext] = useState(first.next);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Which question the list is answering. An answer for an older one is
     *  thrown away. */
    const generation = useRef(0);
    const paramsKey = JSON.stringify(params);
    const shownKey = useRef(JSON.stringify(initialParams));
    const latest = useRef({ params, load, next, items, loading });
    latest.current = { params, load, next, items, loading };

    const failed = useRef<Request | null>(null);

    const ask = useCallback(async (request: Request) => {
        const { cursor, replace, limit, restart } = request;
        const asked = generation.current;
        const fail = (reason: string): void => {
            failed.current = request;
            setError(reason);
            if (!restart) return;
            setItems([]);
            setNext(null);
        };
        setLoading(true);
        setError(null);
        try {
            const page = await latest.current.load(cursor, latest.current.params, limit);
            if (asked !== generation.current) return;
            if ("error" in page) {
                fail(page.error);
                return;
            }
            failed.current = null;
            setItems((held) => (replace ? page.items : [...held, ...page.items]));
            setNext(page.next);
        } catch {
            if (asked === generation.current) fail("failed");
        } finally {
            if (asked === generation.current) setLoading(false);
        }
    }, []);

    // A new search or cut: start again from the top. The first render's own
    // question was answered by the server already.
    useEffect(() => {
        if (paramsKey === shownKey.current) return;
        shownKey.current = paramsKey;
        generation.current += 1;
        failed.current = null;
        void ask({ cursor: null, replace: true, restart: true });
    }, [paramsKey, ask]);

    const loadMore = useCallback(() => {
        const { next: cursor, loading: busy } = latest.current;
        if (!cursor || busy) return;
        void ask({ cursor, replace: false, restart: false });
    }, [ask]);

    const refresh = useCallback(async () => {
        generation.current += 1;
        const shown = Math.min(REFRESH_MAX, Math.max(latest.current.items.length, 1));
        await ask({ cursor: null, replace: true, limit: shown, restart: false });
    }, [ask]);

    const retry = useCallback(() => {
        const request = failed.current;
        if (!request || latest.current.loading) return;
        if (request.replace) generation.current += 1;
        void ask(request);
    }, [ask]);

    // The server drew the screen again. What it handed down is the top of the
    // list; what is on screen may be far more than that, so it is read again.
    const firstSeen = useRef(first);
    useEffect(() => {
        if (firstSeen.current === first) return;
        firstSeen.current = first;
        void refresh();
    }, [first, refresh]);

    return { items, hasMore: next !== null, loading, error, loadMore, refresh, retry };
}
