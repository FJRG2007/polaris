"use client";

/**
 * A polled read that paints instantly on a revisit.
 *
 * The last answer is kept in sessionStorage, so coming back to a page renders
 * the device as it was before the request even leaves - which for a NAS, where
 * almost nothing changes between visits, is indistinguishable from it having
 * been loaded already. The live answer is then folded in with `mergeUnchanged`,
 * so only the values that actually moved produce a re-render.
 *
 * Polling pauses while the tab is hidden and catches up on return, so a
 * dashboard left open overnight is not still asking every few seconds.
 */

import { mergeUnchanged } from "@/lib/structural-merge";
import { useCallback, useEffect, useRef, useState } from "react";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";

/** How stale a cached snapshot may be and still be worth painting. Past this it
 *  is more likely to mislead than to help, so the skeleton is shown instead. */
const MAX_AGE_MS = 24 * 3_600_000;

function read<T>(key: string): { at: number; value: T } | null {
    return readSnapshot<T>(key, MAX_AGE_MS);
}

export interface LiveResource<T> {
    data: T | null;
    /** True only when there is nothing to show yet - never during a refresh. */
    loading: boolean;
    /** Why there is nothing to show. Null whenever data is on screen - see `stale`. */
    error: string | null;
    /**
     * Why the readings on screen stopped updating, when a refresh failed over
     * data that is still displayed. A monitoring panel that quietly keeps showing
     * a healthy device that has since gone unreachable is worse than one that
     * says so, so this is surfaced rather than swallowed.
     */
    stale: string | null;
    /** True while a request is in flight over data already on screen. */
    refreshing: boolean;
    /** When the shown data was fetched, or null when it came from the cache. */
    updatedAt: number | null;
    refresh: () => void;
}

/**
 * Fetch `url` now and every `intervalMs`, seeded from the cached snapshot.
 *
 * `cacheKey` identifies the snapshot; pass something stable per subject (the
 * connection id), not per render.
 */
export function useLiveResource<T>({
    url,
    cacheKey,
    intervalMs,
    enabled = true,
    paused = false,
    select
}: {
    url: string;
    cacheKey: string;
    intervalMs: number;
    /** False asks for nothing at all, for a subject nothing on screen is asking
     *  about. `data` stays as it was, so a caller that gates on it reads the
     *  answer as unknown rather than as a value. */
    enabled?: boolean;
    /** True stops the poll while leaving the resource loaded: a subject that is
     *  on screen is still read once, and read again when it changes, because a
     *  screen that has been told to stop refreshing still has to show what it is
     *  looking at. */
    paused?: boolean;
    /** Pull the payload out of the response body. */
    select: (body: unknown) => T;
}): LiveResource<T> {
    const [data, setData] = useState<T | null>(() => read<T>(cacheKey)?.value ?? null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [updatedAt, setUpdatedAt] = useState<number | null>(null);
    // Held in a ref so the fetch callback does not have to change identity every
    // time the data does, which would restart the interval on every tick.
    const latest = useRef<T | null>(data);
    const selectRef = useRef(select);
    selectRef.current = select;

    // A key change means a different subject entirely, so the previous device's
    // readings must not be folded into the new one's.
    useEffect(() => {
        const seed = read<T>(cacheKey)?.value ?? null;
        latest.current = seed;
        setData(seed);
        setUpdatedAt(null);
        setError(null);
    }, [cacheKey]);

    const refresh = useCallback(() => {
        const controller = new AbortController();
        setRefreshing(true);
        void fetch(url, { cache: "no-store", signal: controller.signal })
            .then(async (res) => {
                const body: unknown = await res.json();
                if (!res.ok) {
                    const message =
                        typeof body === "object" && body !== null && "error" in body
                            ? String((body as { error: unknown }).error)
                            : "Unable to reach the device";
                    throw new Error(message);
                }
                const value = selectRef.current(body);
                // Only what differs becomes a new reference, so an unchanged
                // panel does not re-render and nothing flickers.
                const merged = latest.current === null ? value : mergeUnchanged(latest.current, value);
                latest.current = merged;
                setData(merged);
                setUpdatedAt(Date.now());
                setError(null);
                writeSnapshot(cacheKey, merged);
            })
            .catch((caught: unknown) => {
                if (controller.signal.aborted) return;
                // A failed refresh leaves the last good reading on screen rather
                // than blanking a panel that was fine a moment ago.
                setError(caught instanceof Error ? caught.message : "Unable to reach the device");
            })
            .finally(() => {
                if (!controller.signal.aborted) setRefreshing(false);
            });
        return () => controller.abort();
    }, [url, cacheKey]);

    // The read a subject needs to be on screen at all: once, and again whenever
    // the subject changes. Kept apart from the poll so pausing stops the refresh
    // without leaving a newly selected subject with nothing to show.
    useEffect(() => {
        if (!enabled) return;
        return refresh();
    }, [refresh, enabled]);

    useEffect(() => {
        if (!enabled || paused) return;
        let timer: ReturnType<typeof setInterval> | null = null;
        const start = (): void => {
            if (timer === null) timer = setInterval(refresh, intervalMs);
        };
        const stop = (): void => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };
        const onVisibility = (): void => {
            if (document.visibilityState === "visible") {
                refresh();
                start();
            } else {
                stop();
            }
        };

        if (document.visibilityState === "visible") start();
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            stop();
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [refresh, intervalMs, enabled, paused]);

    return {
        data,
        loading: data === null && error === null,
        error: data === null ? error : null,
        stale: data === null ? null : error,
        refreshing,
        updatedAt,
        refresh
    };
}
