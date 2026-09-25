"use client";

/**
 * Keeps the session's cookie alive for as long as Polaris is being used.
 *
 * The session is renewed by better-auth's own endpoint, because its response is
 * the only one that can hand the browser a new cookie: a renewal done while
 * rendering a page moved the expiry in the database and dropped the cookie, which
 * then ran out a week after signing in whatever was happening on screen.
 *
 * Asked when a screen opens, when the tab comes back, when the network does, and
 * every hour while a tab stays open - a call left running all afternoon is the
 * case that has to hold. The endpoint only writes once a day at most, so asking
 * more often than that costs a read and nothing else.
 */

import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";

/** How often an open tab asks, however little is happening in it. */
export const RENEW_EVERY_MS = 60 * 60 * 1000;

/** The least time between two asks, so focus flapping is not a request each. */
export const RENEW_GAP_MS = 5 * 60 * 1000;

/** Whether enough time has passed since the last ask to ask again. */
export function dueForRenewal(lastAt: number | null, now: number): boolean {
    return lastAt === null || now - lastAt >= RENEW_GAP_MS;
}

export function SessionKeeper() {
    useEffect(() => {
        let lastAt: number | null = null;
        const renew = (): void => {
            const now = Date.now();
            if (!dueForRenewal(lastAt, now)) return;
            lastAt = now;
            // A failed ask is retried by the next one; it is not worth a word on
            // screen while the session itself is still good.
            void authClient.getSession().catch(() => undefined);
        };
        const onVisible = (): void => {
            if (document.visibilityState === "visible") renew();
        };

        renew();
        const timer = window.setInterval(renew, RENEW_EVERY_MS);
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("online", renew);
        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
            window.removeEventListener("online", renew);
        };
    }, []);
    return null;
}
