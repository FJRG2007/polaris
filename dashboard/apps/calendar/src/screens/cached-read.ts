/**
 * A read that paints from the last answer first.
 *
 * The last answer for each key is kept in the host's snapshot cache. Coming back
 * to a window paints what it showed before the request leaves; an answer younger
 * than `freshMs` is not asked again at all, so paging back and forth through
 * the same weeks costs nothing. A newer request for the same hook aborts the
 * one before it, so a quick run of "next, next, next" never lands an old window
 * over the current one.
 *
 * App client components are never drawn on the server (they arrive as browser
 * modules), so the kept answer can be read while rendering without a hydration
 * mismatch to worry about.
 */

import { hostUi } from "@polaris/app-host/client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Bumped when a kept shape changes, so an old tab's snapshot is never read as a
 *  new one. */
export const CACHE_VERSION = "calendar.v1";

/** Fresh enough not to ask again. */
export const FRESH_MS = 30_000;

/** Old enough that painting it would mislead more than help. */
const KEEP_MS = 15 * 60_000;

export interface CachedRead<T> {
    readonly data: T | null;
    /** Why there is nothing to show; null while something is on screen. */
    readonly error: string | null;
    /** A refresh failed over data still on screen. */
    readonly stale: boolean;
    readonly loading: boolean;
    /** Ask again now, whatever the age. */
    readonly refresh: () => void;
    /** Put a value on screen and in the cache: an optimistic change or its
     *  rollback. */
    readonly replace: (value: T) => void;
}

export function cacheKey(...parts: readonly string[]): string {
    return [CACHE_VERSION, ...parts].join(":");
}

/** Forget kept answers under a prefix, after a write that changes them. */
export function dropCached(...parts: readonly string[]): void {
    hostUi.snapshotCache.dropSnapshots(cacheKey(...parts));
}

export function useCachedRead<T>(
    key: string | null,
    load: (signal: AbortSignal) => Promise<T>,
    options: { freshMs?: number } = {}
): CachedRead<T> {
    const freshMs = options.freshMs ?? FRESH_MS;
    const kept = (target: string | null) =>
        target ? hostUi.snapshotCache.readSnapshot<T>(target, KEEP_MS) : null;
    const [state, setState] = useState<{
        key: string | null;
        data: T | null;
        error: string | null;
        stale: boolean;
    }>(() => ({
        key,
        data: kept(key)?.value ?? null,
        error: null,
        stale: false
    }));
    const loadRef = useRef(load);
    loadRef.current = load;
    const controller = useRef<AbortController | null>(null);
    const forced = useRef(false);
    const [turn, setTurn] = useState(0);

    // A new key: whatever was kept for it, or nothing, straight away.
    if (state.key !== key) {
        const snapshot = kept(key);
        setState({ key, data: snapshot?.value ?? null, error: null, stale: false });
    }

    useEffect(() => {
        if (!key) return;
        const snapshot = kept(key);
        if (!forced.current && snapshot && Date.now() - snapshot.at < freshMs) return;
        forced.current = false;
        controller.current?.abort();
        const current = new AbortController();
        controller.current = current;
        loadRef
            .current(current.signal)
            .then((value) => {
                if (current.signal.aborted) return;
                hostUi.snapshotCache.writeSnapshot(key, value);
                setState({ key, data: value, error: null, stale: false });
            })
            .catch((caught: unknown) => {
                if (current.signal.aborted) return;
                const message = caught instanceof Error ? caught.message : String(caught);
                setState((previous) =>
                    previous.key !== key
                        ? previous
                        : previous.data === null
                          ? { ...previous, error: message }
                          : { ...previous, stale: true }
                );
            });
        return () => current.abort();
        // `kept` reads storage; the key and the turn are what decide a read.
    }, [key, turn, freshMs]);

    const refresh = useCallback(() => {
        forced.current = true;
        setTurn((value) => value + 1);
    }, []);
    const replace = useCallback(
        (value: T) => {
            if (key) hostUi.snapshotCache.writeSnapshot(key, value);
            setState({ key, data: value, error: null, stale: false });
        },
        [key]
    );

    const current = state.key === key ? state : { data: null, error: null, stale: false };
    return {
        data: current.data,
        error: current.error,
        stale: current.stale,
        loading: current.data === null && current.error === null,
        refresh,
        replace
    };
}

/** An action's `{ ok, error }` answer as a value or a thrown sentence. */
export async function unwrap<T extends { ok: boolean }>(
    call: () => Promise<T>,
    fallback: string
): Promise<Extract<T, { ok: true }>> {
    let failure = fallback;
    const answer = await hostUi.runAction.runAction(call, (message) => {
        failure = message;
    });
    if (!answer) throw new Error(failure);
    if (!answer.ok) throw new Error((answer as unknown as { error: string }).error);
    return answer as Extract<T, { ok: true }>;
}
