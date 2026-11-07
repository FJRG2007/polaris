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
        loader
            .current()
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
                console.error(`polaris: the VPN's ${key} read failed:`, error);
                if (live) setError(failure);
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
