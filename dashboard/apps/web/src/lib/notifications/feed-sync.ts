/**
 * What one tab tells the other tabs of the same device about the feed.
 *
 * Reading an alert is applied locally first and confirmed by the server after,
 * which is what makes the bell answer instantly. The other tabs used to learn
 * about it only from the next snapshot the stream sent, so for a few seconds the
 * same account showed the same alert as read in one window and unread in the
 * next. They are told directly instead: the change travels as what was done -
 * read this one, clear them all - and every tab runs the same projection over
 * the rows it already holds, so no tab has to be sent the feed and none of them
 * has to wait for the server to agree.
 *
 * A write that the server then refuses is rolled back only where it was made.
 * The tab that made it holds the snapshot to restore; the others are corrected
 * by the next frame, which is a second or two later and is the same delay as
 * being told by another device. Carrying enough state to undo somebody else's
 * write in every tab would cost more than the flicker it saves.
 */

import { z } from "zod";
import type { NotificationView } from "@/lib/notification-service";

/** The channel name. Scoped per account by the peer channel itself. */
export const FEED_CHANNEL = "notifications.feed";

/**
 * How long a tab holds stream frames off after a peer said it is mid-write. The
 * snapshot in flight when the write started still describes the feed as it was,
 * and applying it would undo what the peer just showed. It is a deadline rather
 * than a count of writes in progress, so a tab closed mid-write cannot leave the
 * others ignoring the stream for good.
 */
export const PEER_WRITE_MS = 5000;

const mutationSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("read"), id: z.string().min(1) }),
    z.object({ kind: z.literal("readAll") }),
    z.object({ kind: z.literal("remove"), id: z.string().min(1) }),
    z.object({ kind: z.literal("clear") })
]);

/** One change to the feed, as any tab can replay it. */
export type FeedMutation = z.infer<typeof mutationSchema>;

export const feedMessageSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("begin"), mutation: mutationSchema }),
    z.object({ kind: z.literal("end") })
]);

export type FeedMessage = z.infer<typeof feedMessageSchema>;

/** Apply a change to a feed snapshot. The tab that made it and every tab told
 *  about it run this same projection, which is what makes them agree. */
export function applyFeedMutation(rows: NotificationView[], mutation: FeedMutation): NotificationView[] {
    switch (mutation.kind) {
        case "read":
            return rows.map((row) => (row.id === mutation.id ? { ...row, read: true } : row));
        case "readAll":
            return rows.map((row) => (row.read ? row : { ...row, read: true }));
        case "remove":
            return rows.filter((row) => row.id !== mutation.id);
        case "clear":
            return [];
    }
}
