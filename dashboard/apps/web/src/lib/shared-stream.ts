/**
 * One live connection per device instead of one per tab.
 *
 * Every tab that opened a server-sent stream held its own: five tabs on the same
 * account meant five connections the server had to keep polling for, and every
 * side effect that belongs to the device rather than to a tab - the notification
 * chime above all - happened five times at once. Browsers also cap concurrent
 * connections per origin, so enough tabs and one of them simply never connects.
 *
 * So the tabs elect one of themselves. The election is a Web Lock: whoever is
 * granted it holds the connection for as long as it lives, and the browser
 * releases the lock by itself when that tab is closed or crashes, which hands it
 * to whichever tab was waiting. The holder relays every frame over a
 * BroadcastChannel, so the others stay live without a connection of their own,
 * and each frame says whether the tab reading it is the one that took it off the
 * wire - that is what makes a per-device effect happen once.
 *
 * Two ways out, because a shared connection must never be worse than a private
 * one. A browser without Web Locks or BroadcastChannel (or serving this over
 * plain http, where locks are unavailable) gives every tab its own connection,
 * exactly as before. And a holder that goes quiet - which is what a browser
 * freezing a long-hidden background tab looks like from here - is abandoned:
 * after `SILENCE_MS` without a frame or a heartbeat, a waiting tab stops
 * trusting it and connects for itself.
 *
 * Tabs only ever share with tabs of the same `scope`. The connection is
 * authorized by the session cookie the moment it opens and keeps serving that
 * account for its whole life, so a tab left open on a previous account must not
 * be able to feed the tab of the current one.
 */

import { z } from "zod";

/** A frame as it reaches a subscriber. */
export interface SharedFrame {
    /** The `data` field of the server-sent event, still unparsed. */
    data: string;
    /**
     * Whether this tab took the frame off the wire itself rather than being
     * handed it by another tab. An effect that belongs to the device - a sound,
     * a desktop notification - is the owner's to run, so it happens once however
     * many tabs are open.
     */
    owner: boolean;
}

export interface PeerChannel<T> {
    post: (message: T) => void;
    close: () => void;
}

/** Namespaces the lock and the channel, which are per-origin and shared with
 *  anything else the app might name the same way. */
const PREFIX = "polaris.live:";

/** How often the holder says it is still there. Frames are too rare to prove it:
 *  a quiet feed is normal, a frozen tab is not. */
const BEAT_MS = 10000;

/** How long a waiting tab tolerates silence before it serves itself. Several
 *  heartbeats, so a slow tab is not mistaken for a dead one. */
const SILENCE_MS = 35000;

const relaySchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("frame"), data: z.string() }),
    z.object({ kind: z.literal("beat") })
]);

type Relay = z.infer<typeof relaySchema>;

/**
 * Follow a server-sent stream, sharing one connection with every other tab on
 * this device that asked for the same path and scope. Returns the unsubscribe.
 */
export function subscribeSharedStream(
    path: string,
    scope: string,
    onFrame: (frame: SharedFrame) => void
): () => void {
    const name = `${PREFIX}${scope}:${path}`;
    const channel = openChannel(name);
    const locks = lockManager();
    const abort = new AbortController();

    let stopped = false;
    let source: EventSource | null = null;
    let holder = false;
    let beat: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let release: (() => void) | null = null;

    /** Open a connection of this tab's own. Idempotent: the holder calls it on
     *  election and a tab that gave up waiting calls it on its own. */
    function connect(): void {
        if (stopped || source) return;
        clearWatchdog();
        const opened = new EventSource(path);
        opened.onmessage = (event) => {
            if (stopped) return;
            if (holder) channel?.postMessage({ kind: "frame", data: event.data } satisfies Relay);
            onFrame({ data: event.data, owner: true });
        };
        source = opened;
    }

    function clearWatchdog(): void {
        if (!watchdog) return;
        clearTimeout(watchdog);
        watchdog = null;
    }

    /** Restart the countdown on the tab holding the connection. */
    function armWatchdog(): void {
        if (stopped || holder || source) return;
        clearWatchdog();
        watchdog = setTimeout(() => {
            watchdog = null;
            connect();
        }, SILENCE_MS);
    }

    if (channel) {
        channel.onmessage = (event: MessageEvent<unknown>) => {
            // A tab that ended up serving itself has the frames first-hand and
            // would otherwise apply each of them twice.
            if (stopped || holder || source) return;
            const relay = relaySchema.safeParse(event.data);
            if (!relay.success) return;
            armWatchdog();
            if (relay.data.kind === "frame") onFrame({ data: relay.data.data, owner: false });
        };
    }

    if (!channel || !locks) {
        // Nothing to share through. Every tab keeps its own connection, which is
        // what this replaced and is still correct, only heavier.
        connect();
    } else {
        armWatchdog();
        void locks
            .request(name, { signal: abort.signal }, () =>
                new Promise<void>((resolve) => {
                    // The lock is held until this promise settles, so it is kept
                    // for the life of the subscription and released on teardown.
                    if (stopped) return resolve();
                    holder = true;
                    connect();
                    beat = setInterval(() => channel.postMessage({ kind: "beat" } satisfies Relay), BEAT_MS);
                    release = resolve;
                })
            )
            .catch(() => {
                // Aborted on teardown, or the browser refused the lock outright.
                // A tab with no connection and nobody to listen to is the one
                // state worth avoiding, so fall back to serving itself.
                if (!stopped && !holder) connect();
            });
    }

    return () => {
        stopped = true;
        clearWatchdog();
        if (beat) clearInterval(beat);
        beat = null;
        source?.close();
        source = null;
        channel?.close();
        // Aborting a granted lock does nothing; resolving what the holder is
        // waiting on is what releases it and elects the next tab.
        if (holder) release?.();
        else abort.abort();
    };
}

/**
 * A channel between the tabs of one device, for what a tab did rather than what
 * the server said. Messages arrive unvalidated - a tab still running a previous
 * build of the app is on it too - so the receiver is handed them as `unknown`.
 */
export function openPeerChannel<T>(name: string, scope: string, onMessage: (message: unknown) => void): PeerChannel<T> {
    const channel = openChannel(`${PREFIX}${scope}:${name}`);
    if (channel) channel.onmessage = (event: MessageEvent<unknown>) => onMessage(event.data);
    return {
        post: (message: T) => channel?.postMessage(message),
        close: () => channel?.close()
    };
}

function openChannel(name: string): BroadcastChannel | null {
    if (typeof BroadcastChannel === "undefined") return null;
    try {
        return new BroadcastChannel(name);
    } catch {
        return null;
    }
}

/** Absent on plain http and in a browser too old for the API. */
function lockManager(): LockManager | null {
    if (typeof navigator === "undefined") return null;
    return (navigator as Navigator & { locks?: LockManager }).locks ?? null;
}
