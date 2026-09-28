/**
 * What the live notification stream reads on each tick.
 *
 * The stream polls every few seconds per open tab, and reading the whole feed
 * each time - fifty rows with their text and metadata, plus the names they are
 * about - was the cost of a tab being open rather than of anything happening.
 * So each tick asks a one-row aggregate whether the feed could have changed
 * (see `notificationFeedVersion`) and only re-reads the list when it did.
 *
 * The list is still re-read on a slower clock regardless, because one thing the
 * fingerprint cannot see is the name of the person an alert is about changing.
 */

import {
    listNotifications,
    NOTIFICATION_FEED_LIMIT,
    notificationFeedVersion,
    type NotificationView
} from "@/lib/notification-service";

/** The longest a feed is served from the last read without reading it again. */
export const FEED_FULL_READ_MS = 60_000;

export interface FeedReader {
    /** The feed as it stands. Throws what the database throws. */
    read(): Promise<NotificationView[]>;
}

export function createFeedReader(userId: string, shelf: string, now: () => number = Date.now): FeedReader {
    let version: string | null = null;
    let items: NotificationView[] = [];
    let readAt = 0;
    return {
        async read() {
            const current = await notificationFeedVersion(userId, shelf);
            if (current === version && now() - readAt < FEED_FULL_READ_MS) return items;
            const fresh = await listNotifications(userId, shelf, NOTIFICATION_FEED_LIMIT);
            // Only remembered once the list itself came back, so a failed read
            // is retried on the next tick rather than skipped as unchanged.
            items = fresh;
            version = current;
            readAt = now();
            return items;
        }
    };
}
