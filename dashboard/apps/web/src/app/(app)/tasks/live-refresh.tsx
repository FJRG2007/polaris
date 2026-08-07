"use client";

/**
 * Keeps whichever Tasks screen is open in step with the rest of the team.
 *
 * The server tells this that work the reader can see moved; the answer is to
 * re-render the route, which re-runs the same server components the screen was
 * drawn from. That is why every view follows along - list, board, calendar, the
 * sidebar, My work, a task panel - without any of them subscribing to anything.
 * Local state survives a refresh, so a half-typed comment, an open dialog and a
 * scroll position are all still there afterwards.
 *
 * Two things it deliberately does not do. It never re-renders for the reader's
 * own writes - the action they called already revalidated, and doing it twice is
 * what makes an optimistic row flicker. And it never re-renders a tab nobody is
 * looking at: a background tab banks the signal and spends it when it comes back,
 * so ten open tabs are not ten re-renders per change.
 *
 * Nor are they ten connections: one tab holds the stream for the whole device and
 * passes each signal to the rest (see `shared-stream`). What a tab does with a
 * signal is still its own decision - every screen has to re-render itself.
 */

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";

/** The channel. Scoped server-side to the spaces the session can reach. */
const STREAM_PATH = "/api/tasks/stream";

/** A floor between re-renders. The server already gathers a burst into one
 *  frame; this covers the case of bursts arriving back to back. */
const MIN_INTERVAL_MS = 750;

export function TasksLiveRefresh() {
    const router = useRouter();
    const scope = useSessionScope();
    // Held in refs so the effect runs once. Re-subscribing on every render would
    // drop and reopen the stream continuously.
    const lastRefresh = useRef(0);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const owed = useRef(false);

    useEffect(() => {
        let stopped = false;

        function refreshNow(): void {
            owed.current = false;
            lastRefresh.current = Date.now();
            router.refresh();
        }

        /** Re-render, unless it is too soon or nobody is watching. */
        function schedule(): void {
            if (stopped || timer.current) return;
            if (document.visibilityState === "hidden") {
                owed.current = true;
                return;
            }
            const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRefresh.current));
            timer.current = setTimeout(() => {
                timer.current = null;
                if (!stopped) refreshNow();
            }, wait);
        }

        const unsubscribe = subscribeSharedStream(STREAM_PATH, scope, () => schedule());

        function onVisible(): void {
            // Coming back to a tab is also the moment to spend anything that
            // arrived while it was hidden, and to catch up if the browser froze
            // the connection outright.
            if (document.visibilityState === "visible" && owed.current) schedule();
        }

        document.addEventListener("visibilitychange", onVisible);
        return () => {
            stopped = true;
            document.removeEventListener("visibilitychange", onVisible);
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            unsubscribe();
        };
    }, [router, scope]);

    return null;
}
