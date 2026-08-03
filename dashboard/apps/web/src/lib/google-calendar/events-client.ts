"use client";

/**
 * Google Calendar events for the window a calendar screen is drawing.
 *
 * Fetched from the browser rather than rendered on the server, so the tasks are
 * on screen immediately and the outside service is never in the way of the first
 * paint. A window already fetched is answered from sessionStorage for half a
 * minute: paging back and forth through the same three weeks is the normal way
 * to use a calendar, and each step should not cost a round trip to Google.
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
const CACHE_TTL = 30_000;

function readCache(key: string): CachedWindow | null {
    try {
        const raw = window.sessionStorage.getItem(CACHE_PREFIX + key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CachedWindow;
        return Date.now() - parsed.at < CACHE_TTL ? parsed : null;
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

export function useGoogleCalendarEvents(from: Date, to: Date): GoogleCalendarState {
    const key = `${from.toISOString()}|${to.toISOString()}`;
    const [state, setState] = useState<GoogleCalendarState>({ status: "loading", events: [], error: null });

    useEffect(() => {
        let current = true;
        const cached = readCache(key);
        if (cached) {
            setState({ status: cached.status, events: cached.events, error: null });
            return;
        }

        setState((previous) => ({ ...previous, status: "loading" }));
        const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
        fetch(`/api/integrations/google/events?${query.toString()}`, { cache: "no-store" })
            .then((response) => response.json())
            .then((body: { status?: GoogleCalendarStatus; events?: GoogleEvent[]; error?: string }) => {
                if (!current) return;
                const status = body.status ?? "error";
                const events = Array.isArray(body.events) ? body.events : [];
                setState({ status, events, error: body.error ?? null });
                // Only a settled answer is worth keeping: caching a failure would
                // hold the calendar in it for the next half minute.
                if (status === "ready" || status === "unlinked" || status === "unavailable") {
                    writeCache(key, { at: Date.now(), status, events });
                }
            })
            .catch(() => {
                if (current) {
                    setState({ status: "error", events: [], error: "Google Calendar could not be reached." });
                }
            });

        return () => {
            current = false;
        };
        // The window is what decides the request, and `key` is exactly that.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    return state;
}
