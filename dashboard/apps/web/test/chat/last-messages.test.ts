/** The last message a list row shows: one query, and ticks only where allowed. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();
vi.mock("@polaris/db", () => ({ prisma: { $queryRaw: queryRaw } }));

const { lastMessages, withReceipt } = await import("@/lib/chat/last-messages");

const row = {
    channelId: "c1",
    authorId: "u1",
    kind: "text",
    body: "hello",
    createdAt: new Date("2026-11-05T10:00:00Z"),
    delivered: true,
    read: true,
    deleted: false
};

beforeEach(() => queryRaw.mockReset());

describe("lastMessages", () => {
    it("asks nothing for no conversations", async () => {
        expect((await lastMessages([])).size).toBe(0);
        expect(queryRaw).not.toHaveBeenCalled();
    });

    it("answers every conversation from one query", async () => {
        queryRaw.mockResolvedValue([row, { ...row, channelId: "c2" }]);
        const found = await lastMessages(["c1", "c2", "c3"]);
        expect(queryRaw).toHaveBeenCalledTimes(1);
        expect([...found.keys()]).toEqual(["c1", "c2"]);
        expect(found.get("c1")).toMatchObject({ body: "hello", receipts: false });
    });

    it("reads as plain text, never the stored Markdown", async () => {
        const link = "https://polaris.example.com/some/page";
        queryRaw.mockResolvedValue([
            { ...row, body: `look [${link}](${link})` },
            { ...row, channelId: "c2", body: "**bold** and `code`\n\n- one" },
            { ...row, channelId: "c3", body: "", deleted: true }
        ]);
        const found = await lastMessages(["c1", "c2", "c3"]);
        expect(found.get("c1")?.body).toBe(`look ${link}`);
        expect(found.get("c2")?.body).toBe("bold and code one");
        expect(found.get("c3")?.body).toBe("");
    });

    it("cuts a long message to one row's worth", async () => {
        queryRaw.mockResolvedValue([{ ...row, body: "word ".repeat(200) }]);
        const body = (await lastMessages(["c1"])).get("c1")?.body ?? "";
        expect(body.length).toBeLessThanOrEqual(163);
        expect(body.endsWith("...")).toBe(true);
    });
});

describe("withReceipt", () => {
    const last = {
        authorId: "u1",
        kind: "text",
        body: "hi",
        at: "2026-11-05T10:00:00.000Z",
        receipts: false,
        delivered: true,
        read: true,
        deleted: false
    };

    it("keeps the ticks where receipts are allowed", () => {
        expect(withReceipt(last, true)).toMatchObject({ receipts: true, read: true });
    });

    it("clears them where they are not", () => {
        expect(withReceipt(last, false)).toMatchObject({
            receipts: false,
            read: false,
            delivered: false
        });
    });

    it("takes a group's tick over what the message carries", () => {
        // A group message is never stamped; its tick is worked out from the
        // members' marks, so it replaces whatever the row says.
        expect(withReceipt({ ...last, read: false, delivered: false }, "read")).toMatchObject({
            receipts: true,
            read: true,
            delivered: true
        });
        expect(withReceipt(last, "delivered")).toMatchObject({ read: false, delivered: true });
        expect(withReceipt(last, "sent")).toMatchObject({
            receipts: true,
            read: false,
            delivered: false
        });
    });

    it("passes no message through as none", () => {
        expect(withReceipt(null, true)).toBeNull();
    });
});
