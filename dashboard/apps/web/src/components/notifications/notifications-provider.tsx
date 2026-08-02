"use client";

/**
 * Shared notification state. The bell and the notifications page read from this
 * one store instead of each holding a copy, which is what makes reading an item
 * on the page clear the bell badge immediately. The store is seeded server-side
 * for a correct first paint and then follows a server-sent event stream, so new
 * alerts arrive without a reload. Mutations apply locally first and roll back if
 * the server refuses them.
 */

import type { NotificationView } from "@/lib/notification-service";
import { hasNewArrival, notificationSoundEnabled, playNotificationSound } from "@/lib/notification-sound";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    clearNotificationsAction,
    deleteNotificationAction,
    markAllNotificationsReadAction,
    markNotificationReadAction
} from "@/app/(app)/account/notifications/actions";

export interface NotificationFeed {
    items: NotificationView[];
    unread: number;
    markRead: (id: string) => void;
    markAllRead: () => void;
    remove: (id: string) => void;
    clearAll: () => void;
}

const FeedContext = createContext<NotificationFeed | null>(null);

/** The shared feed. Only valid under NotificationsProvider. */
export function useNotificationFeed(): NotificationFeed {
    const feed = useContext(FeedContext);
    if (!feed) throw new Error("useNotificationFeed requires NotificationsProvider");
    return feed;
}

export function NotificationsProvider({ initial, children }: { initial: NotificationView[]; children: ReactNode }) {
    const [items, setItems] = useState(initial);
    // A snapshot the server took before an in-flight mutation landed would undo
    // the optimistic update, so stream frames are ignored while one is running.
    const inFlight = useRef(0);
    // What this tab has already shown. Seeded from the first paint so the alerts
    // that were waiting when the page opened do not all chime at once.
    const seen = useRef(new Set(initial.map((row) => row.id)));

    useEffect(() => {
        const source = new EventSource("/api/notifications/stream");
        source.onmessage = (event) => {
            if (inFlight.current > 0) return;
            try {
                const payload = JSON.parse(event.data) as { items?: NotificationView[] };
                if (Array.isArray(payload.items)) {
                    if (hasNewArrival(seen.current, payload.items) && notificationSoundEnabled()) {
                        playNotificationSound();
                    }
                    setItems(payload.items);
                }
            } catch {
                // A malformed frame is not worth recovering from; the next tick resends the state.
            }
        };
        return () => source.close();
    }, []);

    /** Apply a change locally, run it on the server, and restore on failure. */
    const apply = useCallback((project: (rows: NotificationView[]) => NotificationView[], run: () => Promise<void>) => {
        let snapshot: NotificationView[] = [];
        setItems((rows) => {
            snapshot = rows;
            return project(rows);
        });
        inFlight.current += 1;
        void run()
            .catch(() => setItems(snapshot))
            .finally(() => {
                inFlight.current -= 1;
            });
    }, []);

    const value = useMemo<NotificationFeed>(() => {
        const unread = items.reduce((total, row) => (row.read ? total : total + 1), 0);
        return {
            items,
            unread,
            markRead: (id) => {
                if (!items.some((row) => row.id === id && !row.read)) return;
                apply(
                    (rows) => rows.map((row) => (row.id === id ? { ...row, read: true } : row)),
                    () => markNotificationReadAction(id)
                );
            },
            markAllRead: () => {
                if (unread === 0) return;
                apply(
                    (rows) => rows.map((row) => ({ ...row, read: true })),
                    () => markAllNotificationsReadAction()
                );
            },
            remove: (id) => {
                apply(
                    (rows) => rows.filter((row) => row.id !== id),
                    () => deleteNotificationAction(id)
                );
            },
            clearAll: () => {
                if (items.length === 0) return;
                apply(() => [], () => clearNotificationsAction());
            }
        };
    }, [items, apply]);

    return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}
