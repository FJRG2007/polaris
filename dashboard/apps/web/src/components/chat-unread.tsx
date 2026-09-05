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
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";
import { announceAppearance } from "@/components/profile-style-store";

export interface ChatUnread {
    readonly messages: number;
    readonly conversations: number;
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

const unreadSchema = z.object({ messages: z.number(), conversations: z.number() });

/** The frames worth re-counting for. A message arriving moves it up, somebody
 *  catching up moves it down, and a conversation appearing or going changes what
 *  there is to count. Typing and calls do not. */
const COUNTED = new Set(["posted", "read", "channels"]);

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
            if (typeof kind !== "string" || !COUNTED.has(kind)) return;
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
