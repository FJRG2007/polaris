"use client";

/**
 * A VPN read, stale-while-revalidate: the last answer this tab saw is shown at
 * once while the action is asked again, and replaced only when it changed. Kept
 * in memory for the tab rather than in storage, since a device list names
 * people's machines and addresses.
 */

import { useCallback, useEffect, useRef, useState } from "react";

type Answer<T> = { error: string } | ({ error?: undefined } & T);

const last = new Map<string, unknown>();

/** How long to wait before asking again after a request got no answer at all. */
const RETRY_MS = [1_000, 2_000, 4_000];

export interface VpnRead<T> {
    /** The newest answer, or null before the first one arrives. */
    readonly data: T | null;
    readonly error: string | null;
    readonly reload: () => void;
    /** `reload`, skipped while an answer is still on its way, for timers. */
    readonly poll: () => void;
    /** Replace the shown answer, for an optimistic change or its rollback. */
    readonly set: (next: T) => void;
}

/** `failure` is what to show when the action itself could not be reached. */
export function useVpnRead<T>(
    key: string,
    load: () => Promise<Answer<T>>,
    failure: string
): VpnRead<T> {
    const [data, setData] = useState<T | null>(() => (last.get(key) as T | undefined) ?? null);
    const [error, setError] = useState<string | null>(null);
    const loader = useRef(load);
    loader.current = load;
    const asking = useRef(0);

    const set = useCallback(
        (next: T) => {
            last.set(key, next);
            setData(next);
        },
        [key]
    );

    const reload = useCallback(() => {
        let live = true;
        asking.current += 1;
        // A request cut on its way (a tunnel this page just brought up moves
        // every route) is asked again before it is called a failure.
        const attempt = (round: number): Promise<Answer<T>> =>
            loader.current().catch((error: unknown) => {
                if (!live || round >= RETRY_MS.length) throw error;
                return new Promise<Answer<T>>((resolve, reject) => {
                    setTimeout(
                        () => (live ? resolve(attempt(round + 1)) : reject(error)),
                        RETRY_MS[round]
                    );
                });
            });
        attempt(0)
            .then((answer) => {
                if (!live) return;
                if (answer.error !== undefined) {
                    setError(answer.error);
                    return;
                }
                setError(null);
                const before = JSON.stringify(last.get(key) ?? null);
                if (JSON.stringify(answer) !== before) set(answer as T);
            })
            .catch((error: unknown) => {
                // The action never answered (the page outlived an update, or the
                // connection dropped): the cause is only ever seen here.
                if (!live) return;
                console.error(`polaris: the VPN's ${key} read failed:`, error);
                setError(failure);
            })
            .finally(() => {
                asking.current -= 1;
            });
        return () => {
            live = false;
        };
    }, [key, set, failure]);

    const poll = useCallback(() => {
        if (asking.current === 0) reload();
    }, [reload]);

    useEffect(() => reload(), [reload]);

    return { data, error, reload, poll, set };
}
