"use client";

/**
 * Whether something pressed is still waiting on the server - without a
 * transition.
 *
 * Mail used `useTransition` for this, and an async transition is not a spinner:
 * while one is pending, every other transition started anywhere joins it and is
 * held until it ends. Every navigation in Polaris is a transition - a link, a
 * `router.push` - so a folder synced, a message moved or a message sent over a
 * slow mail server was a window in which no link worked. And a server action the
 * router dropped (it runs them one at a time and can lose one dispatched while a
 * navigation loads) left that transition pending for good: nothing navigated
 * again until a reload, which is how "after sending, Inbox does nothing" was
 * reported.
 *
 * Same shape as the pair `useTransition` returns, so a screen swaps one for the
 * other and nothing else changes. What it does not do is hold anybody else's
 * update: the press is counted, the task runs, and the count comes down when it
 * settles, whichever way.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** Something pressed: may be async, and anything it answers is ignored. */
type Task = () => unknown;

export function useBusy(): [boolean, (task: Task) => void] {
    const [running, setRunning] = useState(0);
    // A screen closed mid-request is not told the request ended.
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const run = useCallback((task: Task) => {
        setRunning((count) => count + 1);
        const settle = () => {
            if (mounted.current) setRunning((count) => Math.max(0, count - 1));
        };
        let result: unknown;
        try {
            // Called now, not on a later tick: what it does before its first
            // await happens in the press, as it did inside a transition.
            result = task();
        } catch (caught) {
            settle();
            throw caught;
        }
        void Promise.resolve(result)
            .catch((caught: unknown) => {
                console.error("polaris: a mail request failed:", caught);
            })
            .finally(settle);
    }, []);

    return [running > 0, run];
}
