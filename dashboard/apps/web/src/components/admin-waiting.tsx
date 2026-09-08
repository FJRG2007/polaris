"use client";

/**
 * What is waiting for an administrator, everywhere in Polaris.
 *
 * The same shape as the chat and mail counts beside it, and for the same reason:
 * the number has to be right on a screen that is not the one it belongs to.
 * Somebody reports a message, and the administrator who will answer it is in
 * Deploy - so the count lives above every screen and the Management entry wears
 * it, exactly as Chat and Mail do.
 *
 * It follows the notification stream rather than a timer of its own. Every one
 * of these things already raises a notification for the people who can act on
 * it - a report, a locked-down account, a published build - so a frame arriving
 * on that stream is the signal that something changed, and the count is asked
 * for again. The stream is shared per device, so this adds no connection.
 *
 * The slow timer underneath is not for arrivals. It is for departures: another
 * administrator settling a report is work leaving the queue, and nothing tells
 * this browser about somebody else's decision. Five minutes is far too slow for
 * an arrival and exactly right for a number that should not stay wrong all
 * afternoon.
 */

import { z } from "zod";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode
} from "react";

export interface AdminWaiting {
    readonly reports: number;
    readonly cases: number;
    readonly update: boolean;
    readonly total: number;
}

export const NO_ADMIN_WAITING: AdminWaiting = { reports: 0, cases: 0, update: false, total: 0 };

const WaitingContext = createContext<AdminWaiting>(NO_ADMIN_WAITING);

/** What is waiting in Management. Nothing outside the provider, which is the
 *  honest answer for anybody who is not an administrator. */
export function useAdminWaiting(): AdminWaiting {
    return useContext(WaitingContext);
}

const STREAM_PATH = "/api/notifications/stream";
const WAITING_PATH = "/api/admin/waiting";

const waitingSchema = z.object({
    reports: z.number(),
    cases: z.number(),
    update: z.boolean(),
    total: z.number()
});

/** How long a burst is gathered before asking again. A person reporting four
 *  messages in a row is one recount, not four. */
const SETTLE_MS = 800;

/** The floor. Long, because it exists only so a queue somebody else emptied does
 *  not sit on this screen as a number until the page is reloaded. */
const SWEEP_MS = 5 * 60 * 1000;

export function AdminWaitingProvider({
    initial,
    enabled,
    children
}: {
    initial: AdminWaiting;
    /** Whether this account can act on any of it. False opens no stream
     *  subscription of its own and makes no request: somebody who is not an
     *  administrator has no badge, and finding that out should cost nothing. */
    enabled: boolean;
    children: ReactNode;
}) {
    const scope = useSessionScope();
    const [waiting, setWaiting] = useState(initial);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const recount = useCallback(() => {
        void fetch(WAITING_PATH, { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
                const parsed = waitingSchema.safeParse(body);
                if (parsed.success) setWaiting(parsed.data);
            })
            .catch(() => {
                // Left as it was. A count that could not be fetched is not a
                // count of zero, and clearing the badge over one failed request
                // is how somebody misses the report it was there for.
            });
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const stop = subscribeSharedStream(STREAM_PATH, scope, () => {
            // Every frame, without reading it. What arrives on this stream is a
            // notification for this account, and the cheap recount below is a
            // better answer than teaching this component the vocabulary of every
            // event that could ever change the queue - which is the list that
            // would silently fall behind.
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(recount, SETTLE_MS);
        });
        const sweep = setInterval(recount, SWEEP_MS);
        return () => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            clearInterval(sweep);
            stop();
        };
    }, [enabled, scope, recount]);

    return <WaitingContext.Provider value={waiting}>{children}</WaitingContext.Provider>;
}
