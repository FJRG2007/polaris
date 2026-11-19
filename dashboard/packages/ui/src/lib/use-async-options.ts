"use client";

/**
 * The options of a picker read from the server a page at a time, as somebody
 * opens it, types into it and scrolls it.
 *
 * Nothing is read until the picker opens, and then only the first page. What
 * was typed is sent to the server, a moment after the typing stops, rather
 * than matched against a list the browser holds - a list of five thousand
 * servers is never in the browser at all. The next page is asked for with the
 * cursor the one before ended on.
 *
 * A first page read before is drawn at once from a short-lived cache and read
 * again behind it, and replaced only when the answer differs, so reopening a
 * picker does not flash a skeleton. A new search keeps the rows already on
 * screen until its answer lands (`refreshing`), as Discord's pickers do, and a
 * list with nothing to show waits `SKELETON_DELAY_MS` before it draws skeletons,
 * so an answer that arrives at once never flashes them. A request for a question nobody is asking
 * any more - an older search, a closed picker - is aborted, and its answer is
 * dropped if it arrives anyway.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** A page of options and where the next one starts, or null at the end. */
export interface AsyncPage<T> {
    readonly items: readonly T[];
    readonly next: string | null;
}

/** How a page is asked for. */
export type AsyncLoad<T> = (request: {
    readonly query: string;
    readonly cursor: string | null;
    readonly signal: AbortSignal;
}) => Promise<AsyncPage<T>>;

export interface AsyncOptionsState<T> {
    readonly items: readonly T[];
    /** No first page yet for this question and nothing else to show: the list
     *  region shows skeletons. */
    readonly loading: boolean;
    /** A new search is on its way while the rows of the last one stay drawn. */
    readonly refreshing: boolean;
    /** An answer to the current question is still on its way, so an empty list
     *  is not yet "nothing found". */
    readonly pending: boolean;
    /** A page after the first is on its way. */
    readonly loadingMore: boolean;
    readonly hasMore: boolean;
    /** The last request failed; `retry` asks it again. */
    readonly failed: boolean;
    /** The search the rows answer, once the typing has settled. */
    readonly settledQuery: string;
    readonly loadMore: () => void;
    readonly retry: () => void;
}

/** How long a cached first page is drawn without being read again. */
export const ASYNC_OPTIONS_TTL_MS = 30_000;
/** How long typing has to pause before it is sent. */
export const ASYNC_OPTIONS_DEBOUNCE_MS = 250;
/** How long an empty list waits for its answer before it draws skeletons. */
export const SKELETON_DELAY_MS = 200;
/** First pages kept, across every picker on the screen. */
const CACHE_ENTRIES = 50;

interface CachedPage {
    readonly page: AsyncPage<unknown>;
    readonly at: number;
}

const cache = new Map<string, CachedPage>();

function remember(key: string, page: AsyncPage<unknown>): void {
    cache.delete(key);
    cache.set(key, { page, at: Date.now() });
    while (cache.size > CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

/** Forget every cached first page whose key starts with `prefix` - after a write
 *  that changes what a picker would list. Everything, without one. */
export function dropAsyncOptions(prefix = ""): void {
    for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

function samePage(a: AsyncPage<unknown>, b: AsyncPage<unknown>): boolean {
    return a.next === b.next && JSON.stringify(a.items) === JSON.stringify(b.items);
}

function aborted(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
}

export function useAsyncOptions<T>({
    load,
    cacheKey,
    open,
    query,
    debounceMs = ASYNC_OPTIONS_DEBOUNCE_MS,
    ttlMs = ASYNC_OPTIONS_TTL_MS
}: {
    load: AsyncLoad<T>;
    /** Names the list - and every filter it is read under - in the cache. Two
     *  pickers over the same list under the same filters share their pages. */
    cacheKey: string;
    open: boolean;
    query: string;
    debounceMs?: number;
    ttlMs?: number;
}): AsyncOptionsState<T> {
    const loadRef = useRef(load);
    loadRef.current = load;

    const typed = query.trim();
    const [settledQuery, setSettledQuery] = useState(typed);
    const [items, setItems] = useState<readonly T[]>([]);
    const [next, setNext] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [pending, setPending] = useState(false);
    // Read by the effect that asks, which must not re-run when rows change.
    const shown = useRef(0);
    shown.current = items.length;
    const [loadingMore, setLoadingMore] = useState(false);
    const [failed, setFailed] = useState<"first" | "more" | null>(null);
    const [attempt, setAttempt] = useState(0);

    // Every question asked bumps this; an answer carrying an older one is
    // somebody else's and is dropped.
    const question = useRef(0);
    const controller = useRef<AbortController | null>(null);

    // The search goes out once typing pauses; opening goes out at once.
    useEffect(() => {
        if (!open) return;
        if (typed === settledQuery) return;
        const timer = setTimeout(() => setSettledQuery(typed), debounceMs);
        return () => clearTimeout(timer);
    }, [open, typed, settledQuery, debounceMs]);

    useEffect(() => {
        if (open) setSettledQuery(typed);
        // Only on the way open: typing is the effect above's.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open) {
            controller.current?.abort();
            controller.current = null;
            question.current += 1;
            setRefreshing(false);
            setPending(false);
            // Every picker opens on an empty search.
            setSettledQuery("");
            return;
        }
        const key = `${cacheKey}\u0000${settledQuery}`;
        const asked = ++question.current;
        controller.current?.abort();
        const own = new AbortController();
        controller.current = own;
        setFailed(null);
        setLoadingMore(false);

        const cached = cache.get(key);
        let skeletons: ReturnType<typeof setTimeout> | null = null;
        if (cached) {
            setItems(cached.page.items as readonly T[]);
            setNext(cached.page.next);
            setLoading(false);
            setRefreshing(false);
            setPending(false);
            if (Date.now() - cached.at < ttlMs && attempt === 0) return;
        } else if (shown.current > 0) {
            // The last answer stays until this one replaces it.
            setLoading(false);
            setRefreshing(true);
        } else {
            setNext(null);
            setRefreshing(false);
            skeletons = setTimeout(() => {
                if (asked === question.current) setLoading(true);
            }, SKELETON_DELAY_MS);
        }
        if (!cached) setPending(true);
        const settle = () => {
            if (skeletons) clearTimeout(skeletons);
            setLoading(false);
            setRefreshing(false);
            setPending(false);
        };

        loadRef
            .current({ query: settledQuery, cursor: null, signal: own.signal })
            .then((page) => {
                if (asked !== question.current || own.signal.aborted) return;
                const kept = cache.get(key);
                remember(key, page);
                if (!kept || !samePage(kept.page, page)) {
                    setItems(page.items);
                    setNext(page.next);
                }
                settle();
            })
            .catch((error: unknown) => {
                if (asked !== question.current || aborted(error)) return;
                settle();
                // A cached page already drawn stays; only a list with no
                // answer to this question says it failed.
                if (!cached) {
                    setItems([]);
                    setNext(null);
                    setFailed("first");
                }
            });
        return () => {
            if (skeletons) clearTimeout(skeletons);
            own.abort();
        };
    }, [open, cacheKey, settledQuery, ttlMs, attempt]);

    const loadMore = useCallback(() => {
        if (!open || loading || loadingMore || next === null || failed !== null) return;
        const asked = question.current;
        const own = new AbortController();
        controller.current = own;
        setLoadingMore(true);
        loadRef
            .current({ query: settledQuery, cursor: next, signal: own.signal })
            .then((page) => {
                if (asked !== question.current || own.signal.aborted) return;
                setItems((before) => [...before, ...page.items]);
                setNext(page.next);
                setLoadingMore(false);
            })
            .catch((error: unknown) => {
                if (asked !== question.current || aborted(error)) return;
                setLoadingMore(false);
                setFailed("more");
            });
    }, [open, loading, loadingMore, next, failed, settledQuery]);

    const retry = useCallback(() => {
        // A failed next page is asked again by clearing the failure: the list is
        // still scrolled to its end, so it asks for the page again by itself.
        if (failed === "more") {
            setFailed(null);
            return;
        }
        setAttempt((count) => count + 1);
    }, [failed]);

    return {
        items,
        loading,
        refreshing,
        pending,
        loadingMore,
        hasMore: next !== null,
        failed: failed !== null,
        settledQuery,
        loadMore,
        retry
    };
}
