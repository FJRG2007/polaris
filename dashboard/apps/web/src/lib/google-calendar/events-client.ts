"use client";

/**
 * Google Calendar events for the window a calendar screen is drawing.
 *
 * Fetched from the browser rather than rendered on the server, so the tasks are
 * on screen immediately and the outside service is never in the way of the first
 * paint. A window already fetched is drawn from sessionStorage straight away and
 * asked for again behind it once that copy is half a minute old: paging back and
 * forth through the same three weeks should not cost a round trip each step, and
 * a change made in Google should not wait for somebody to page away and back.
 *
 * For the same reason an open calendar asks again every minute while the tab is
 * visible, and as soon as the tab comes back into view - which is when somebody
 * who just moved a meeting in Google returns to look at it here. An answer that
 * matches what is drawn changes nothing on screen.
 *
 * A request whose window changed mid-flight is dropped rather than applied - the
 * calendar has already moved on, and the older answer would repaint it with the
 * wrong days.
 */

import { useEffect, useState } from "react";

/** The wire shape, kept in step with `listGoogleEvents`. All-day events carry
 *  Google's plain `YYYY-MM-DD`, which the caller reads in the reader's own
 *  timezone rather than in the server's. */
export interface GoogleEvent {
    readonly id: string;
    readonly title: string;
    readonly start: string;
    readonly end: string | null;
    readonly allDay: boolean;
    readonly location: string | null;
    readonly url: string | null;
    /** Missing from a window cached before it was sent, which reads as no. */
    readonly declined?: boolean;
}

export type GoogleCalendarStatus =
    /** No OAuth client is connected on this deployment: the feature is invisible. */
    | "unavailable"
    /** Available, but this account has not linked one. */
    | "unlinked"
    | "loading"
    | "ready"
    /** Linked, but Google no longer accepts the authorization. */
    | "expired"
    | "error";

export interface GoogleCalendarState {
    readonly status: GoogleCalendarStatus;
    readonly events: GoogleEvent[];
    readonly error: string | null;
}

interface CachedWindow {
    at: number;
    status: GoogleCalendarStatus;
    events: GoogleEvent[];
}

const CACHE_PREFIX = "polaris.google.events:";
/** How old a cached window may be before it is asked for again. */
const CACHE_TTL = 30_000;
/** How often an open calendar asks again on its own. */
const REFRESH_EVERY = 60_000;

function readCache(key: string): CachedWindow | null {
    try {
        const raw = window.sessionStorage.getItem(CACHE_PREFIX + key);
        return raw ? (JSON.parse(raw) as CachedWindow) : null;
    } catch {
        return null;
    }
}

function writeCache(key: string, value: CachedWindow): void {
    try {
        window.sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
    } catch {
        // A full or blocked store is not a reason to lose the events; the next
        // window simply pays for its own request.
    }
}

function isFresh(cached: CachedWindow | null): boolean {
    return cached !== null && Date.now() - cached.at < CACHE_TTL;
}

export function useGoogleCalendarEvents(from: Date, to: Date): GoogleCalendarState {
    const key = `${from.toISOString()}|${to.toISOString()}`;
    const [state, setState] = useState<GoogleCalendarState>({ status: "loading", events: [], error: null });

    useEffect(() => {
        let current = true;
        let inFlight: AbortController | null = null;
        const cached = readCache(key);
        if (cached) setState({ status: cached.status, events: cached.events, error: null });
        else setState((previous) => ({ ...previous, status: "loading" }));
        // Whether this window has an answer on screen, so a background refresh
        // that fails keeps it instead of blanking the calendar.
        let settled = cached !== null;

        const load = () => {
            inFlight?.abort();
            const controller = new AbortController();
            inFlight = controller;
            const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
            fetch(`/api/integrations/google/events?${query.toString()}`, {
                cache: "no-store",
                signal: controller.signal
            })
                .then((response) => response.json())
                .then((body: { status?: GoogleCalendarStatus; events?: GoogleEvent[]; error?: string }) => {
                    if (!current) return;
                    const status = body.status ?? "error";
                    const events = Array.isArray(body.events) ? body.events : [];
                    if (status === "error" && settled) return;
                    setState((previous) =>
                        previous.status === status &&
                        previous.error === (body.error ?? null) &&
                        JSON.stringify(previous.events) === JSON.stringify(events)
                            ? previous
                            : { status, events, error: body.error ?? null }
                    );
                    // Only a settled answer is worth keeping: caching a failure would
                    // hold the calendar in it.
                    if (status === "ready" || status === "unlinked" || status === "unavailable") {
                        settled = true;
                        writeCache(key, { at: Date.now(), status, events });
                    }
                })
                .catch(() => {
                    if (!current || controller.signal.aborted || settled) return;
                    // No sentence of its own: the calendar says it could not be
                    // reached, in the reader's language.
                    setState({ status: "error", events: [], error: null });
                });
        };

        if (!isFresh(cached)) load();
        const refresh = () => {
            if (document.visibilityState === "visible") load();
        };
        const timer = window.setInterval(refresh, REFRESH_EVERY);
        // Coming back to the tab asks only when what is drawn has gone stale, so
        // flicking between two tabs does not cost a request each time.
        const onReturn = () => {
            if (document.visibilityState === "visible" && !isFresh(readCache(key))) load();
        };
        document.addEventListener("visibilitychange", onReturn);
        window.addEventListener("focus", onReturn);

        return () => {
            current = false;
            inFlight?.abort();
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onReturn);
            window.removeEventListener("focus", onReturn);
        };
        // The window is what decides the request, and `key` is exactly that.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    return state;
}
