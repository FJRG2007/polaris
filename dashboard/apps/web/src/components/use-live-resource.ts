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
 *
 * `useLiveRead` is the same behaviour over any promise - a server action, a
 * measurement, anything that is not a GET - so a panel of tracked figures gets
 * the instant paint whether the numbers arrive over an endpoint or an action.
 */

import { mergeUnchanged } from "@/lib/structural-merge";
import { useCallback, useEffect, useRef, useState } from "react";
import { readSnapshot, writeSnapshot, type Snapshot } from "@/lib/snapshot-cache";

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
    /**
     * When the shown reading was taken: the moment it arrived, or the moment the
     * kept one was written when it is still the cached one. Never null while data
     * is on screen, so a panel can always say how old what it shows is - a figure
     * from ten minutes ago passing for this instant's is the failure mode the
     * cache would otherwise introduce.
     */
    updatedAt: number | null;
    refresh: () => void;
}

/**
 * The cached, polled read itself, over any promise.
 *
 * `load` is called with an abort signal and must resolve the value or throw; pass
 * it through `useCallback`, because a new identity is what tells this a different
 * subject is being read and re-runs the fetch.
 */
export function useLiveRead<T>({
    load,
    cacheKey,
    intervalMs,
    initial,
    enabled = true,
    paused = false
}: {
    load: (signal: AbortSignal) => Promise<T>;
    cacheKey: string;
    /** Omit for a read that is taken once per subject rather than polled. */
    intervalMs?: number;
    /**
     * A reading the server already had, for the first paint of a browser that is
     * holding nothing - a first visit, a new tab, a hard reload. The kept snapshot
     * wins when there is one, being the newer of the two.
     */
    initial?: Snapshot<T>;
    enabled?: boolean;
    paused?: boolean;
}): LiveResource<T> {
    // One read of the kept snapshot, seeding both the reading and its age.
    const [seeded] = useState(() => read<T>(cacheKey) ?? initial ?? null);
    const [data, setData] = useState<T | null>(seeded?.value ?? null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [updatedAt, setUpdatedAt] = useState<number | null>(seeded?.at ?? null);
    // Held in a ref so the fetch callback does not have to change identity every
    // time the data does, which would restart the interval on every tick.
    const latest = useRef<T | null>(data);

    // Which subject the seed above belongs to. A key change means a different
    // subject entirely, so the previous device's readings must not be folded into
    // the new one's - but the mount's own key is already seeded, and re-reading it
    // here would wipe a server-supplied `initial` that no snapshot backs.
    const seededFor = useRef(cacheKey);

    useEffect(() => {
        if (seededFor.current === cacheKey) return;
        seededFor.current = cacheKey;
        const kept = read<T>(cacheKey);
        latest.current = kept?.value ?? null;
        setData(kept?.value ?? null);
        setUpdatedAt(kept?.at ?? null);
        setError(null);
    }, [cacheKey]);

    const refresh = useCallback(() => {
        const controller = new AbortController();
        setRefreshing(true);
        void load(controller.signal)
            .then((value) => {
                if (controller.signal.aborted) return;
                // Only what differs becomes a new reference, so an unchanged
                // panel does not re-render and nothing flickers.
                const merged =
                    latest.current === null ? value : mergeUnchanged(latest.current, value);
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
    }, [load, cacheKey]);

    // The read a subject needs to be on screen at all: once, and again whenever
    // the subject changes. Kept apart from the poll so pausing stops the refresh
    // without leaving a newly selected subject with nothing to show.
    useEffect(() => {
        if (!enabled) return;
        return refresh();
    }, [refresh, enabled]);

    useEffect(() => {
        if (!enabled || paused || !intervalMs) return;
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
    const selectRef = useRef(select);
    selectRef.current = select;

    const load = useCallback(
        async (signal: AbortSignal): Promise<T> => {
            const res = await fetch(url, { cache: "no-store", signal });
            const body: unknown = await res.json();
            if (!res.ok) {
                const message =
                    typeof body === "object" && body !== null && "error" in body
                        ? String((body as { error: unknown }).error)
                        : "Unable to reach the device";
                throw new Error(message);
            }
            return selectRef.current(body);
        },
        [url]
    );

    return useLiveRead<T>({ load, cacheKey, intervalMs, enabled, paused });
}
