/**
 * The Time area as the browser holds it: one snapshot per tab, read from the
 * server and kept for a short while, and the word that it changed.
 *
 * The Time screen, the indicator beside the bell and the search all change the
 * same rows. Whichever of them changes something says so - in this tab with a
 * window event, in this browser's other tabs over a broadcast channel - and the
 * rest read again. Another device's change is picked up when this one is looked
 * at again (focus), and on a slow poll while something is counting.
 *
 * Each module that imports this may be its own copy in the app's bundle (one
 * browser entry per client component), so nothing here is shared through
 * module state: the snapshot lives in the host's per-tab snapshot cache and the
 * signal on the window.
 */

import { hostUi } from "@polaris/app-host/client";
import { CLOCK_CHANNEL, CLOCK_CHANGED_EVENT, CLOCK_SNAPSHOT_KEY } from "@polaris/core";
import type { ClockSnapshot } from "../../lib/clock/model";
import { useCallback, useEffect, useRef, useState } from "react";

/** Raised on the window when this tab changed something, or heard another did. */
export const CLOCK_CHANGED = CLOCK_CHANGED_EVENT;

const CHANNEL = CLOCK_CHANNEL;
const KEY = CLOCK_SNAPSHOT_KEY;
/** A kept snapshot younger than this is shown and not asked for again. */
const FRESH_MS = 30_000;

let channel: BroadcastChannel | null | undefined;

function broadcast(): BroadcastChannel | null {
    if (channel !== undefined) return channel;
    channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
    return channel;
}

interface Kept {
    readonly at: number;
    readonly snapshot: ClockSnapshot;
}

/** Old enough that painting it would mislead more than help. */
const KEEP_MS = 15 * 60_000;

/** Kept in the host's snapshot cache, which a sign-out empties and a new build
 *  ignores. */
function readKept(): Kept | null {
    const kept = hostUi.snapshotCache.readSnapshot<ClockSnapshot>(KEY, KEEP_MS);
    return kept ? { at: kept.at, snapshot: kept.value } : null;
}

function keep(snapshot: ClockSnapshot): void {
    hostUi.snapshotCache.writeSnapshot(KEY, snapshot);
}

/** Put a snapshot an action answered with on every screen of this browser. */
export function publishSnapshot(snapshot: ClockSnapshot): void {
    keep(snapshot);
    window.dispatchEvent(new CustomEvent(CLOCK_CHANGED, { detail: snapshot }));
    broadcast()?.postMessage("changed");
}

/** Say something changed without having the new snapshot (the search did it). */
export function announceChange(): void {
    hostUi.snapshotCache.dropSnapshots(KEY);
    window.dispatchEvent(new CustomEvent(CLOCK_CHANGED));
    broadcast()?.postMessage("changed");
}

export interface ClockRead {
    readonly snapshot: ClockSnapshot | null;
    /** Server time minus this device's, in milliseconds. */
    readonly skew: number;
    readonly error: boolean;
    /** False while the person may not use Calendar (the read was refused). */
    readonly allowed: boolean;
    readonly refresh: () => void;
    /** Show a value now: an optimistic change, or the rollback of one. */
    readonly replace: (snapshot: ClockSnapshot) => void;
}

function skewOf(snapshot: ClockSnapshot | null, readAt: number): number {
    return snapshot ? new Date(snapshot.serverNow).getTime() - readAt : 0;
}

/**
 * The person's alarms, timers and stopwatch, painted from what this tab kept
 * and read again when stale, when another screen changed them, and when the
 * window comes back into view.
 */
export function useClock(): ClockRead {
    const kept = useRef<Kept | null>(typeof window === "undefined" ? null : readKept());
    const [state, setState] = useState<{
        snapshot: ClockSnapshot | null;
        skew: number;
        error: boolean;
        allowed: boolean;
    }>(() => ({
        snapshot: kept.current?.snapshot ?? null,
        skew: kept.current ? skewOf(kept.current.snapshot, kept.current.at) : 0,
        error: false,
        allowed: true
    }));
    const inFlight = useRef<AbortController | null>(null);

    const load = useCallback(() => {
        inFlight.current?.abort();
        const controller = new AbortController();
        inFlight.current = controller;
        const sent = Date.now();
        fetch("/api/calendar/time", { cache: "no-store", signal: controller.signal })
            .then(async (response) => {
                if (response.status === 401 || response.status === 403) {
                    setState((previous) => ({ ...previous, allowed: false }));
                    return;
                }
                if (!response.ok) throw new Error(String(response.status));
                const snapshot = (await response.json()) as ClockSnapshot;
                // Half the round trip is the best guess of when the server read
                // its clock.
                const readAt = (sent + Date.now()) / 2;
                keep(snapshot);
                setState({ snapshot, skew: skewOf(snapshot, readAt), error: false, allowed: true });
            })
            .catch((caught: unknown) => {
                if (caught instanceof DOMException && caught.name === "AbortError") return;
                setState((previous) => ({ ...previous, error: true }));
            });
    }, []);

    useEffect(() => {
        const fresh = kept.current && Date.now() - kept.current.at < FRESH_MS;
        if (!fresh) load();
        const onChange = (event: Event) => {
            const snapshot = (event as CustomEvent<ClockSnapshot | undefined>).detail;
            if (snapshot) {
                setState((previous) => ({
                    ...previous,
                    snapshot,
                    skew: skewOf(snapshot, Date.now()),
                    error: false
                }));
            } else load();
        };
        const onMessage = () => load();
        // Coming back to the window reads again - another device may have
        // changed something - but not more than once every ten seconds, so
        // switching windows back and forth costs nothing.
        let lastSeen = Date.now();
        const onVisible = () => {
            if (document.visibilityState !== "visible" || Date.now() - lastSeen < 10_000) return;
            lastSeen = Date.now();
            load();
        };
        window.addEventListener(CLOCK_CHANGED, onChange);
        broadcast()?.addEventListener("message", onMessage);
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", onVisible);
        return () => {
            window.removeEventListener(CLOCK_CHANGED, onChange);
            broadcast()?.removeEventListener("message", onMessage);
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("focus", onVisible);
            inFlight.current?.abort();
        };
    }, [load]);

    const replace = useCallback((snapshot: ClockSnapshot) => {
        setState((previous) => ({ ...previous, snapshot }));
    }, []);

    return { ...state, refresh: load, replace };
}

/**
 * Run an action that answers a fresh snapshot: show `optimistic` first, then
 * the server's answer on every screen - or put back what was there and say why.
 */
export async function mutate(
    read: ClockRead,
    call: () => Promise<{ ok: true; snapshot: ClockSnapshot } | { ok: false; error: string }>,
    optimistic: ((snapshot: ClockSnapshot) => ClockSnapshot) | null,
    onError: (message: string) => void
): Promise<boolean> {
    const before = read.snapshot;
    if (before && optimistic) read.replace(optimistic(before));
    let failure: string | null = null;
    const answer = await hostUi.runAction.runAction(call, (message) => {
        failure = message;
    });
    if (answer && answer.ok) {
        publishSnapshot(answer.snapshot);
        return true;
    }
    if (before) read.replace(before);
    // What the refusal says ("read again") is true: the server's reading
    // replaces what was rolled back, in case another device moved it on.
    read.refresh();
    onError(answer && !answer.ok ? answer.error : (failure ?? ""));
    return false;
}

/** A clock that ticks every `everyMs`, on the server's time. */
export function useServerNow(skew: number, everyMs: number, active = true): number {
    const [now, setNow] = useState(() => Date.now() + skew);
    useEffect(() => {
        setNow(Date.now() + skew);
        if (!active) return;
        const timer = window.setInterval(() => setNow(Date.now() + skew), everyMs);
        return () => window.clearInterval(timer);
    }, [skew, everyMs, active]);
    return now;
}
