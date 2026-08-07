import { describe, expect, it } from "vitest";
import type { NotificationView } from "@/lib/notification-service";
import { applyFeedMutation, feedMessageSchema } from "@/lib/notifications/feed-sync";

function row(id: string, read = false): NotificationView {
    return {
        id,
        type: "tasks.assigned",
        title: `Alert ${id}`,
        body: null,
        href: null,
        level: "info",
        audience: "you",
        audienceLabel: null,
        actionRequired: false,
        read,
        createdAt: "2026-08-07T10:00:00.000Z"
    };
}

describe("applyFeedMutation", () => {
    const rows = [row("a"), row("b", true), row("c")];

    it("reads the one named and leaves the rest alone", () => {
        const next = applyFeedMutation(rows, { kind: "read", id: "a" });
        expect(next.map((item) => item.read)).toEqual([true, true, false]);
        // The untouched rows keep their identity, so nothing re-renders for them.
        expect(next[2]).toBe(rows[2]);
    });

    it("ignores an id that is not in the feed", () => {
        expect(applyFeedMutation(rows, { kind: "read", id: "gone" })).toEqual(rows);
    });

    it("reads everything at once", () => {
        expect(applyFeedMutation(rows, { kind: "readAll" }).every((item) => item.read)).toBe(true);
    });

    it("removes one and clears all", () => {
        expect(applyFeedMutation(rows, { kind: "remove", id: "b" }).map((item) => item.id)).toEqual(["a", "c"]);
        expect(applyFeedMutation(rows, { kind: "clear" })).toEqual([]);
    });

    it("does not touch the snapshot it was given, which is what rollback restores", () => {
        applyFeedMutation(rows, { kind: "readAll" });
        expect(rows.map((item) => item.read)).toEqual([false, true, false]);
    });
});

describe("feedMessageSchema", () => {
    it("accepts what a tab sends", () => {
        expect(feedMessageSchema.safeParse({ kind: "begin", mutation: { kind: "read", id: "a" } }).success).toBe(true);
        expect(feedMessageSchema.safeParse({ kind: "end" }).success).toBe(true);
    });

    it("refuses anything else, because a tab on an older build is on the channel too", () => {
        expect(feedMessageSchema.safeParse({ kind: "begin" }).success).toBe(false);
        expect(feedMessageSchema.safeParse({ kind: "begin", mutation: { kind: "read" } }).success).toBe(false);
        expect(feedMessageSchema.safeParse({ kind: "begin", mutation: { kind: "burn" } }).success).toBe(false);
        expect(feedMessageSchema.safeParse({ kind: "begin", mutation: { kind: "read", id: "" } }).success).toBe(false);
        expect(feedMessageSchema.safeParse("end").success).toBe(false);
        expect(feedMessageSchema.safeParse(null).success).toBe(false);
    });
});
