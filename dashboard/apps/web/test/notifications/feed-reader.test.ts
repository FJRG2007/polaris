/**
 * The live stream's reads.
 *
 * Each tick asks a cheap fingerprint whether the feed could have changed, and
 * only reads the list when it did - or when the last read is old enough that a
 * renamed person could be showing under their old name.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let version = "1:100:0";
let lists = 0;
let failList = false;

vi.mock("@/lib/notification-service", () => ({
    NOTIFICATION_FEED_LIMIT: 50,
    notificationFeedVersion: async () => version,
    listNotifications: async () => {
        lists += 1;
        if (failList) throw new Error("database away");
        return [{ id: `read-${lists}` }];
    }
}));

const { createFeedReader, FEED_FULL_READ_MS } = await import("@/lib/notifications/feed-reader");

describe("feed reader", () => {
    let clock = 0;
    const now = () => clock;

    beforeEach(() => {
        version = "1:100:0";
        lists = 0;
        failList = false;
        clock = 0;
    });

    it("reads the list once and serves it while nothing changed", async () => {
        const feed = createFeedReader("u1", "personal", now);
        const first = await feed.read();
        clock += 5000;
        const second = await feed.read();
        expect(lists).toBe(1);
        expect(second).toBe(first);
    });

    it("reads again when the fingerprint moves", async () => {
        const feed = createFeedReader("u1", "personal", now);
        await feed.read();
        version = "1:100:200";
        const after = await feed.read();
        expect(lists).toBe(2);
        expect(after).toEqual([{ id: "read-2" }]);
    });

    it("reads again once the last read is too old, fingerprint or not", async () => {
        const feed = createFeedReader("u1", "personal", now);
        await feed.read();
        clock += FEED_FULL_READ_MS;
        await feed.read();
        expect(lists).toBe(2);
    });

    it("retries a failed read on the next tick rather than treating it as unchanged", async () => {
        const feed = createFeedReader("u1", "personal", now);
        failList = true;
        await expect(feed.read()).rejects.toThrow();
        failList = false;
        await feed.read();
        expect(lists).toBe(2);
    });
});
