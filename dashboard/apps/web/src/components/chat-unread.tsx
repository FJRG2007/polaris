"use client";

/**
 * How much of Chat is waiting, everywhere in Polaris.
 *
 * Chat knew this all along and nobody else did, which meant somebody who spends
 * the day in Deploy or Drive was never told a message had arrived: the count
 * lived inside the one app that already had their attention. So it is held here,
 * above every screen, and read by the tab icon and by the Chat entry in the rail.
 *
 * It rides the live channel Chat already opens rather than polling. That channel
 * is shared per device - one tab holds the wire for all of them - so a browser
 * with six Polaris tabs open still costs one connection, and this adds none.
 * What it costs is one small query per burst of messages, which is the same
 * thing the rail pays for the same reason.
 *
 * Seeded from the server on first paint, so the badge is right before the first
 * frame arrives instead of appearing a second into the page.
 */

import { z } from "zod";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore,
    type ReactNode
} from "react";
import * as readMarks from "@/lib/chat/read-marks";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";
import { announceCallSeats, announcePresence } from "@/components/presence-store";
import { announceAppearance } from "@/components/profile-style-store";
import { useShelfSeed } from "@/components/shelf-scope";

export interface ChatUnread {
    readonly messages: number;
    readonly conversations: number;
    /** The conversations behind the totals, when the server names them - what
     *  lets this tab take the one being read off at once. Never read by a
     *  badge; `useChatUnread` hands out the totals already settled. */
    readonly waiting?: readonly readMarks.WaitingConversation[];
}

const NOTHING: ChatUnread = { messages: 0, conversations: 0 };

const UnreadContext = createContext<ChatUnread>(NOTHING);

/** What is waiting in Chat. Zero outside the provider, which is the honest
 *  answer for a screen mounted without one rather than a reason to throw. */
export function useChatUnread(): ChatUnread {
    return useContext(UnreadContext);
}

const STREAM_PATH = "/api/chat/stream";
const UNREAD_PATH = "/api/chat/unread";
const DELIVERED_PATH = "/api/chat/delivered";

/** The most conversations one acknowledgement names - `MAX_CHAT_DELIVERED`,
 *  which is not imported to keep the core schemas out of every page's bundle. */
const MOST_DELIVERED = 100;

/**
 * The conversations a `posted` frame says a message landed in, as against only
 * changing in place. Absent `arrived` is a server from before it, where every
 * conversation named is read as an arrival. Pure.
 */
export function arrivedIn(frame: unknown): string[] {
    if (!frame || typeof frame !== "object") return [];
    const { kind, arrived, channels } = frame as {
        kind?: unknown;
        arrived?: unknown;
        channels?: unknown;
    };
    if (kind !== "posted") return [];
    const named = Array.isArray(arrived) ? arrived : Array.isArray(channels) ? channels : [];
    return named.filter((id): id is string => typeof id === "string");
}

const unreadSchema = z.object({
    messages: z.number(),
    conversations: z.number(),
    // Absent from a server before it, which leaves the totals as they come.
    waiting: z
        .array(z.object({ id: z.string(), unread: z.number(), at: z.number().nullable() }))
        .max(1000)
        .optional()
});

/** The frames worth re-counting for. A message arriving moves it up, somebody
 *  catching up moves it down, and a conversation appearing or going changes what
 *  there is to count - as does the badge being cleared from the app list on
 *  another screen. Typing and calls do not. */
const COUNTED = new Set(["posted", "read", "channels", "badge"]);

/** How long a burst is gathered before asking again. The stream already
 *  coalesces, and this covers the case it cannot: a frame per conversation when
 *  several move at once. */
const SETTLE_MS = 400;

export function ChatUnreadProvider({
    initial,
    enabled,
    children
}: {
    initial: ChatUnread;
    /** Whether this account may be in Chat at all. False means no stream is
     *  opened and no request is made: an account with no chat has no badge, and
     *  finding that out should not cost a connection. */
    enabled: boolean;
    children: ReactNode;
}) {
    const scope = useSessionScope();
    // The open shelf's count, taken again from the server's seed on a switch.
    const [unread, setUnread] = useShelfSeed(initial);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Conversations a message landed in since the last acknowledgement, said
    // with the recount below: one request a burst, not one a message.
    const landed = useRef(new Set<string>());

    const acknowledge = useCallback(() => {
        const channelIds = [...landed.current].slice(0, MOST_DELIVERED);
        landed.current.clear();
        if (channelIds.length === 0) return;
        void fetch(DELIVERED_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ channelIds }),
            keepalive: true
        }).catch(() => {
            // Nothing to do: the next page load says it for every conversation
            // at once (`deliverEverywhere`), and opening this one says it too.
        });
    }, []);

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
        const stop = subscribeSharedStream(STREAM_PATH, scope, ({ data, owner }) => {
            let kind: unknown;
            let frame: { kind?: unknown; actorId?: unknown };
            try {
                frame = JSON.parse(data) as { kind?: unknown; actorId?: unknown };
                kind = frame.kind;
            } catch {
                return;
            }
            // Carried on this connection rather than on one of its own. It is
            // the only stream open above every screen, the frame is an id and a
            // word, and opening a second connection for something that happens
            // a handful of times in an account's life would cost more than it
            // could ever save. Handed straight on: what a face looks like is
            // none of this provider's business.
            if (kind === "appearance") {
                if (typeof frame.actorId === "string") announceAppearance([frame.actorId]);
                return;
            }
            // What somebody is playing or listening to, handed on the same way:
            // the presence store asks again for that face if it is drawn.
            if (kind === "activity") {
                if (typeof frame.actorId === "string") announcePresence([frame.actorId]);
                return;
            }
            // Somebody joined, hung up, or a call ended: the speaker beside
            // their face is redrawn now, not at the next refresh. A mute or a
            // moderator's mark (`voice`) moves nobody's seat.
            if (kind === "call") {
                if ((frame as { voice?: unknown }).voice !== true) announceCallSeats();
                return;
            }
            if (typeof kind !== "string" || !COUNTED.has(kind)) return;
            // The message is on this device now, which is the second tick under
            // it. Said by the tab holding the wire alone - the device's, not each
            // tab's - and only for conversations where it landed; the server
            // ignores the sender's own messages and anything already marked.
            if (owner) for (const id of arrivedIn(frame)) landed.current.add(id);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
                recount();
                acknowledge();
            }, SETTLE_MS);
        });
        return () => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            acknowledge();
            stop();
        };
    }, [enabled, scope, recount, acknowledge]);

    // A conversation this tab is reading, or has just read, comes off the totals
    // now rather than once the read has gone round and the count been asked
    // again - and stays off when an answer that set off before it lands.
    const readVersion = useSyncExternalStore(
        readMarks.subscribeReadMarks,
        readMarks.readMarksVersion,
        readMarks.readMarksVersion
    );
    const shown = useMemo(() => {
        void readVersion;
        return readMarks.settledTotals(unread);
    }, [unread, readVersion]);

    return <UnreadContext.Provider value={shown}>{children}</UnreadContext.Provider>;
}
