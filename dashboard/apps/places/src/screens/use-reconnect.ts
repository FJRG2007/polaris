"use client";

/**
 * Bringing back a live stream that played and then dropped.
 *
 * A stream that never started is replaced with the next format; one that
 * played and then stopped - a camera rebooting, the relay restarting, a moment
 * without network - is the same stream on the same format and is reconnected
 * after a short wait instead. Without the difference a single blip moved a
 * viewer onto the slow fallback formats for good.
 *
 * `round` is what the player is keyed on, so each reconnect is a fresh element
 * and a fresh request. While `waiting` the player stays down and the silence
 * clock is off: the wait is chosen, not a stream failing to answer.
 */

import { RECONNECT_TRIES, STEADY_MS, reconnectDelay } from "../lib/live-player";
import { useCallback, useEffect, useRef, useState } from "react";

export function useReconnect() {
    const [round, setRound] = useState(0);
    const [waiting, setWaiting] = useState(false);
    const drops = useRef(0);
    const since = useRef<number | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        []
    );

    /** The stream is on screen again. */
    const played = useCallback(() => {
        since.current = Date.now();
    }, []);

    /**
     * The stream stopped. Answers whether it will be reconnected: always when
     * it had played, and while a run of reconnects is still under way when it
     * had not - a camera that is rebooting refuses a few before it answers.
     * The wait grows with each try in a row, and starts over once the stream
     * has held for a while.
     */
    const dropped = useCallback((started: boolean) => {
        if (!started && (drops.current === 0 || drops.current >= RECONNECT_TRIES)) {
            drops.current = 0;
            return false;
        }
        if (since.current !== null && Date.now() - since.current >= STEADY_MS) drops.current = 0;
        since.current = null;
        const delay = reconnectDelay(drops.current);
        drops.current += 1;
        if (timer.current) clearTimeout(timer.current);
        setWaiting(true);
        timer.current = setTimeout(() => {
            setWaiting(false);
            setRound((value) => value + 1);
        }, delay);
        return true;
    }, []);

    return { round, waiting, played, dropped };
}
