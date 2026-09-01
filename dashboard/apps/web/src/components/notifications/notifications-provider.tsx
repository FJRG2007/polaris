"use client";

/**
 * Shared notification state. The bell and the notifications page read from this
 * one store instead of each holding a copy, which is what makes reading an item
 * on the page clear the bell badge immediately. The store is seeded server-side
 * for a correct first paint and then follows a server-sent event stream, so new
 * alerts arrive without a reload. Mutations apply locally first and roll back if
 * the server refuses them.
 *
 * The stream is shared with the other tabs of this device rather than opened
 * again in each of them, and so is every write made here. Two windows on the
 * same account therefore cost one connection, chime once between them, and show
 * an alert read in one as read in the other straight away.
 */

import { useSessionScope } from "@/components/session-scope";
import type { NotificationView } from "@/lib/notification-service";
import { claimForDevice } from "@/lib/device-once";
import { openPeerChannel, subscribeSharedStream, type PeerChannel } from "@/lib/shared-stream";
import { hasNewArrival, notificationSoundEnabled, playNotificationSound } from "@/lib/notification-sound";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    applyFeedMutation,
    FEED_CHANNEL,
    feedMessageSchema,
    PEER_WRITE_MS,
    type FeedMessage,
    type FeedMutation
} from "@/lib/notifications/feed-sync";
import {
    clearNotificationsAction,
    deleteNotificationAction,
    deleteNotificationsAction,
    markAllNotificationsReadAction,
    markNotificationReadAction,
    markNotificationsReadAction
} from "@/app/(app)/account/notifications/actions";

export interface NotificationFeed {
    items: NotificationView[];
    unread: number;
    markRead: (id: string) => void;
    markAllRead: () => void;
    remove: (id: string) => void;
    clearAll: () => void;
    /** A selection, in one write rather than one per row. */
    markManyRead: (ids: readonly string[]) => void;
    removeMany: (ids: readonly string[]) => void;
}

const STREAM_PATH = "/api/notifications/stream";

const FeedContext = createContext<NotificationFeed | null>(null);

/** The shared feed. Only valid under NotificationsProvider. */
export function useNotificationFeed(): NotificationFeed {
    const feed = useContext(FeedContext);
    if (!feed) throw new Error("useNotificationFeed requires NotificationsProvider");
    return feed;
}

export function NotificationsProvider({ initial, children }: { initial: NotificationView[]; children: ReactNode }) {
    const scope = useSessionScope();
    const [items, setItems] = useState(initial);
    // A snapshot the server took before an in-flight mutation landed would undo
    // the optimistic update, so stream frames are ignored while one is running -
    // whether it is running here or in another tab of this device.
    const inFlight = useRef(0);
    const peerWriteUntil = useRef(0);
    const peers = useRef<PeerChannel<FeedMessage> | null>(null);
    // What this tab has already shown. Seeded from the first paint so the alerts
    // that were waiting when the page opened do not all chime at once.
    const seen = useRef(new Set(initial.map((row) => row.id)));

    useEffect(() => {
        const channel = openPeerChannel<FeedMessage>(FEED_CHANNEL, scope, (message) => {
            const parsed = feedMessageSchema.safeParse(message);
            if (!parsed.success) return;
            if (parsed.data.kind === "end") {
                peerWriteUntil.current = 0;
                return;
            }
            const { mutation } = parsed.data;
            peerWriteUntil.current = Date.now() + PEER_WRITE_MS;
            setItems((rows) => applyFeedMutation(rows, mutation));
        });
        peers.current = channel;
        return () => {
            peers.current = null;
            channel.close();
        };
    }, [scope]);

    useEffect(
        () =>
            subscribeSharedStream(STREAM_PATH, scope, ({ data }) => {
                if (inFlight.current > 0 || Date.now() < peerWriteUntil.current) return;
                try {
                    const payload = JSON.parse(data) as { items?: NotificationView[] };
                    if (!Array.isArray(payload.items)) return;
                    // Every tab records what it has seen, so the one that ends up
                    // holding the connection later does not chime for a backlog it
                    // was already showing.
                    const arrived = hasNewArrival(seen.current, payload.items);
                    // The chime belongs to the machine, not to the tab, so the
                    // tabs settle between themselves which of them makes it -
                    // four windows are one sound. It is claimed rather than left
                    // to whichever tab holds the connection, because on an
                    // install served over plain http every tab holds one of its
                    // own; see `device-once`.
                    if (arrived && notificationSoundEnabled()) {
                        void claimForDevice(`${scope}:notification-chime`).then((mine) => {
                            if (mine) playNotificationSound();
                        });
                    }
                    setItems(payload.items);
                } catch {
                    // A malformed frame is not worth recovering from; the next tick resends the state.
                }
            }),
        [scope]
    );

    /** Apply a change here and in the other tabs, run it on the server, and
     *  restore this tab on failure. */
    const apply = useCallback((mutation: FeedMutation, run: () => Promise<void>) => {
        let snapshot: NotificationView[] = [];
        setItems((rows) => {
            snapshot = rows;
            return applyFeedMutation(rows, mutation);
        });
        inFlight.current += 1;
        peers.current?.post({ kind: "begin", mutation });
        void run()
            .catch(() => setItems(snapshot))
            .finally(() => {
                inFlight.current -= 1;
                peers.current?.post({ kind: "end" });
            });
    }, []);

    const value = useMemo<NotificationFeed>(() => {
        const unread = items.reduce((total, row) => (row.read ? total : total + 1), 0);
        return {
            items,
            unread,
            markRead: (id) => {
                if (!items.some((row) => row.id === id && !row.read)) return;
                apply({ kind: "read", id }, () => markNotificationReadAction(id));
            },
            markAllRead: () => {
                if (unread === 0) return;
                apply({ kind: "readAll" }, () => markAllNotificationsReadAction());
            },
            remove: (id) => {
                apply({ kind: "remove", id }, () => deleteNotificationAction(id));
            },
            clearAll: () => {
                if (items.length === 0) return;
                apply({ kind: "clear" }, () => clearNotificationsAction());
            },
            markManyRead: (ids) => {
                // Only the ones that would actually change: marking twenty rows
                // of which two are unread is two rows of work, and a write that
                // changes nothing still costs a round trip and a rollback path.
                const unreadIds = items.filter((row) => !row.read && ids.includes(row.id)).map((row) => row.id);
                if (unreadIds.length === 0) return;
                apply({ kind: "readMany", ids: unreadIds }, () =>
                    markNotificationsReadAction({ ids: unreadIds })
                );
            },
            removeMany: (ids) => {
                const present = items.filter((row) => ids.includes(row.id)).map((row) => row.id);
                if (present.length === 0) return;
                apply({ kind: "removeMany", ids: present }, () =>
                    deleteNotificationsAction({ ids: present })
                );
            }
        };
    }, [items, apply]);

    return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}
