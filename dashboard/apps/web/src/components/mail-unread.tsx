"use client";

/**
 * How much mail is waiting, everywhere in Polaris.
 *
 * The same reasoning as the chat count beside it: Mail knew this and nobody else
 * did, so somebody working in Deploy or Drive was never told anything had
 * arrived - the number lived inside the one app that already had their
 * attention. It is held here instead, above every screen, and read by the tab
 * icon and by the Mail entry in the rail.
 *
 * It rides the live channel Mail already opens rather than polling. That channel
 * is shared per device - one tab holds the wire for all of them - so a browser
 * with six Polaris tabs open still costs one connection and this adds none.
 *
 * Seeded from the server on first paint, so the badge is right before the first
 * frame arrives rather than appearing a second into the page.
 */

import { z } from "zod";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export interface MailUnread {
    /** Unread messages across every mailbox in the merged views. */
    readonly messages: number;
    /** How many mailboxes have any, for a screen that wants to say "in two of
     *  your mailboxes" rather than a bare number. */
    readonly mailboxes: number;
}

const NOTHING: MailUnread = { messages: 0, mailboxes: 0 };

const UnreadContext = createContext<MailUnread>(NOTHING);

/** What is waiting in Mail. Zero outside the provider, which is the honest
 *  answer for a screen mounted without one rather than a reason to throw. */
export function useMailUnread(): MailUnread {
    return useContext(UnreadContext);
}

const STREAM_PATH = "/api/mail/stream";
const UNREAD_PATH = "/api/mail/unread";

const unreadSchema = z.object({ messages: z.number(), mailboxes: z.number() });

/**
 * How long a burst is gathered before asking again.
 *
 * Longer than the chat's, for the same reason the mail stream's own coalescing
 * is: a sync that files a page of arriving messages is one redraw, and nobody
 * watches their unread count go up one at a time.
 */
const SETTLE_MS = 600;

export function MailUnreadProvider({
    initial,
    enabled,
    children
}: {
    initial: MailUnread;
    /** Whether this account has any mail at all. False opens no stream and makes
     *  no request: a person with no mailbox has no badge, and finding that out
     *  should not cost a connection. */
    enabled: boolean;
    children: ReactNode;
}) {
    const scope = useSessionScope();
    const [unread, setUnread] = useState(initial);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const recount = useCallback(() => {
        void fetch(UNREAD_PATH, { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : null))
            .then((body) => {
                const parsed = unreadSchema.safeParse(body);
                if (parsed.success) setUnread(parsed.data);
            })
            .catch(() => {
                // Left as it was. A count that could not be fetched is not a
                // count of zero, and clearing the badge over one failed request
                // is how somebody misses the message it was there for.
            });
    }, []);

    useEffect(() => {
        if (!enabled) return;
        const stop = subscribeSharedStream(STREAM_PATH, scope, ({ data }) => {
            let kind: unknown;
            try {
                kind = (JSON.parse(data) as { kind?: unknown }).kind;
            } catch {
                return;
            }
            // A queued message changing state does not change what is unread.
            if (kind !== "mail") return;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(recount, SETTLE_MS);
        });
        return () => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            stop();
        };
    }, [enabled, scope, recount]);

    return <UnreadContext.Provider value={unread}>{children}</UnreadContext.Provider>;
}
