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
import { canNotify, notifyDesktop, tabIsWatched } from "@/lib/desktop-notify";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode
} from "react";

export interface MailUnread {
    /** Unread messages across every mailbox in the merged views. */
    readonly messages: number;
    /** How many mailboxes have any, for a screen that wants to say "in two of
     *  your mailboxes" rather than a bare number. */
    readonly mailboxes: number;
}

const NOTHING: MailUnread = { messages: 0, mailboxes: 0 };

const UnreadContext = createContext<MailUnread>(NOTHING);

/**
 * Tell the badge about mail somebody has just read, before the server says so.
 *
 * This count is the server's, asked for when the live channel says a mailbox
 * moved - so reading a message moved the numbers inside Mail at once and left
 * the badge on the app switcher standing at its old figure until the mail
 * server had been told, had answered, and had announced it. Seconds, over
 * somebody else's IMAP server, with the message plainly read on the screen
 * beside it.
 *
 * Negative for mail that stopped being unread. Laid over the server's figure
 * and dropped the moment that figure moves - the same overlay the rail inside
 * Mail keeps, for the same reason and exactly as long.
 */
const NudgeContext = createContext<(by: number) => void>(() => {});

/** What is waiting in Mail. Zero outside the provider, which is the honest
 *  answer for a screen mounted without one rather than a reason to throw. */
export function useMailUnread(): MailUnread {
    return useContext(UnreadContext);
}

/** Move the badge by what this screen has just done - see `NudgeContext`. Does
 *  nothing outside the provider. */
export function useNudgeMailUnread(): (by: number) => void {
    return useContext(NudgeContext);
}

const STREAM_PATH = "/api/mail/stream";
const UNREAD_PATH = "/api/mail/unread";

const unreadSchema = z.object({ messages: z.number(), mailboxes: z.number() });

const ARRIVALS_PATH = "/api/mail/arrivals";

const arrivalsSchema = z.object({
    cursor: z.string(),
    named: z.array(z.object({ threadId: z.string(), from: z.string(), subject: z.string() })),
    more: z.number()
});

type Arrivals = z.infer<typeof arrivalsSchema>;

/** New mail since a cursor, or null when it could not be asked. A failed ask
 *  is not "nothing arrived": the cursor stays where it was and the next frame
 *  asks again, so the mail is announced late rather than never. */
async function fetchArrivals(since: string | null): Promise<Arrivals | null> {
    try {
        const response = await fetch(
            since ? `${ARRIVALS_PATH}?since=${encodeURIComponent(since)}` : ARRIVALS_PATH,
            { cache: "no-store" }
        );
        if (!response.ok) return null;
        const parsed = arrivalsSchema.safeParse(await response.json());
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Where the device's tabs keep the last moment they announced up to. */
const SHARED_CURSOR_KEY = "polaris.mail.announced";

/** The device's cursor, or null where storage is missing or refused - a
 *  private window, a browser blocking site data - which only means this tab
 *  works from its own. */
function sharedCursor(): string | null {
    try {
        return window.localStorage.getItem(SHARED_CURSOR_KEY);
    } catch {
        return null;
    }
}

function keepSharedCursor(value: string): void {
    try {
        window.localStorage.setItem(SHARED_CURSOR_KEY, value);
    } catch {
        // Nothing to do: the tab's own cursor still moves.
    }
}

/** The later of two cursors, either of which may be missing or unreadable. */
function laterOf(left: string | null, right: string | null): string | null {
    const a = left ? Date.parse(left) : Number.NaN;
    const b = right ? Date.parse(right) : Number.NaN;
    if (Number.isNaN(a)) return Number.isNaN(b) ? null : right;
    if (Number.isNaN(b)) return left;
    return a >= b ? left : right;
}

/**
 * Tell the system about mail that arrived while Polaris was out of sight.
 *
 * One notice per conversation, tagged by it so a second message in the same one
 * replaces the first rather than stacking, and pressing it opens that
 * conversation. Past a few, one notice says how many - ten at once is a notice
 * nobody reads. Nothing is stored and nothing reaches the bell: a message is
 * somebody waiting, not a record to clear.
 */
async function announceArrivals(cursor: { current: string | null }): Promise<void> {
    // The later of this tab's cursor and the one the device last announced up
    // to. The tab holding the live connection changes when that tab closes, and
    // the one taking over would otherwise announce again everything since it
    // was opened.
    const since = laterOf(cursor.current, sharedCursor());
    if (!since || !canNotify()) return;
    const answer = await fetchArrivals(since);
    if (!answer) return;
    cursor.current = answer.cursor;
    keepSharedCursor(answer.cursor);
    for (const arrival of answer.named) {
        await notifyDesktop({
            title: arrival.from,
            body: arrival.subject,
            tag: `mail:${arrival.threadId}`,
            href: `/mail/t/${arrival.threadId}`
        });
    }
    if (answer.more > 0) {
        await notifyDesktop({
            title: "New mail",
            body: `${answer.more} more ${answer.more === 1 ? "message" : "messages"} in your inbox`,
            tag: "mail:more",
            href: "/mail"
        });
    }
}

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
    /** What this browser has already done that the server's count predates. */
    const [drift, setDrift] = useState(0);
    const nudge = useCallback((by: number) => {
        if (by !== 0) setDrift((held) => held + by);
    }, []);
    // The server has spoken since. Whatever was laid over its count was either
    // this, and is now counted twice, or was never true.
    useEffect(() => {
        setDrift((held) => (held === 0 ? held : 0));
    }, [unread]);
    const shown = useMemo<MailUnread>(() => {
        if (drift === 0) return unread;
        const messages = Math.max(0, unread.messages + drift);
        // Never a mailbox with nothing waiting in it: the second number only
        // exists to say "in two of your mailboxes", and saying that over a
        // badge that has gone is the screen arguing with itself.
        return { messages, mailboxes: messages === 0 ? 0 : unread.mailboxes };
    }, [unread, drift]);

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

    /**
     * Where the last ask for new mail left off, in the server's own clock.
     *
     * Held by every tab, asked for by the one holding the live connection when a
     * frame arrives and nobody is looking at the tab - see `announceArrivals`.
     * Seeded with a first ask that announces nothing, so opening Polaris never
     * raises a notice about mail that was already there.
     */
    const cursor = useRef<string | null>(null);

    useEffect(() => {
        if (!enabled) return;
        void fetchArrivals(null).then((answer) => {
            if (answer) cursor.current = answer.cursor;
        });
        const stop = subscribeSharedStream(STREAM_PATH, scope, ({ data, owner }) => {
            let kind: unknown;
            try {
                kind = (JSON.parse(data) as { kind?: unknown }).kind;
            } catch {
                return;
            }
            // A queued message changing state does not change what is unread.
            if (kind !== "mail") return;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
                recount();
                // A notice belongs to the device, not the tab, so only the tab
                // that took the frame off the wire raises one - five open tabs
                // are one notice. And only when nobody is looking at Polaris:
                // the list is already on screen for somebody who is.
                if (owner && !tabIsWatched()) void announceArrivals(cursor);
            }, SETTLE_MS);
        });
        return () => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            stop();
        };
    }, [enabled, scope, recount]);

    return (
        <NudgeContext.Provider value={nudge}>
            <UnreadContext.Provider value={shown}>{children}</UnreadContext.Provider>
        </NudgeContext.Provider>
    );
}
