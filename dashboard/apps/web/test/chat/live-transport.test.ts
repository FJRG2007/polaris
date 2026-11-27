/**
 * Chat's live changes between replicas: every notice under Postgres' payload
 * limit, a long change cut and joined again, and a lone process sending nothing.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { ChatNoticeReader, ChatRelay, MOST_PIECES, chatNotices } = await import("@/lib/chat/live-transport");
const { NOTIFY_PAYLOAD_LIMIT } = await import("@/lib/live/pg-listener");

const ME = "00000000-0000-4000-8000-000000000001";
const THEM = "00000000-0000-4000-8000-000000000002";
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("a change on the wire", () => {
    it("is one notice when it fits", () => {
        const notices = chatNotices({ channelId: "c", kind: "posted", actorId: "a" }, THEM);
        expect(notices).toHaveLength(1);
        expect(bytes(notices[0]!)).toBeLessThan(NOTIFY_PAYLOAD_LIMIT);
    });

    it("is cut into pieces under the limit and joined back whole, in any order", () => {
        const change = {
            channelId: "c",
            kind: "call",
            actorId: "a",
            audience: Array.from({ length: 1_500 }, (_, i) => uuid(i))
        } as const;
        const notices = chatNotices(change, THEM);
        expect(notices.length).toBeGreaterThan(1);
        for (const notice of notices) expect(bytes(notice)).toBeLessThan(NOTIFY_PAYLOAD_LIMIT);
        const got: unknown[] = [];
        const reader = new ChatNoticeReader((c) => got.push(c), undefined, ME);
        for (const notice of [...notices].reverse()) reader.read(notice);
        expect(got).toEqual([change]);
        expect(reader.pending).toBe(0);
    });

    it("keeps every piece under the limit when each character takes several bytes", () => {
        const text = "\u{1F600}中".repeat(6_000);
        const notices = chatNotices(
            { channelId: "c", kind: "draft", actorId: "polar", draft: { key: "k", parentId: null, text } },
            THEM
        );
        expect(notices.length).toBeGreaterThan(1);
        for (const notice of notices) expect(bytes(notice)).toBeLessThan(NOTIFY_PAYLOAD_LIMIT);
    });

    it("is not sent at all past the most pieces", () => {
        const text = "x".repeat(1_000 * (MOST_PIECES + 1));
        expect(
            chatNotices({ channelId: "c", kind: "draft", actorId: "p", draft: { key: "k", parentId: null, text } })
        ).toEqual([]);
    });

    it("from this same process, or malformed, is never delivered", () => {
        const got: unknown[] = [];
        const reader = new ChatNoticeReader((c) => got.push(c), undefined, ME);
        reader.read(chatNotices({ channelId: "c", kind: "posted", actorId: "a" }, ME)[0]!);
        reader.read("not json");
        reader.read(JSON.stringify({ n: THEM, c: { kind: "posted" } }));
        expect(got).toEqual([]);
        reader.read(chatNotices({ channelId: "c", kind: "posted", actorId: "a" }, THEM)[0]!);
        expect(got).toHaveLength(1);
    });
});

describe("the relay", () => {
    function sender(listeners: number) {
        return {
            notify: vi.fn(async (_payloads: readonly string[]) => undefined),
            listeners: vi.fn(async () => listeners),
            selfListening: () => true
        };
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("sends until the first count, which is asked for at once", async () => {
        const db = sender(1);
        const relay = new ChatRelay(db, Date.now, ME);
        relay.send({ channelId: "c", kind: "posted", actorId: "a" });
        await settle();
        expect(db.notify).toHaveBeenCalledTimes(1);
        expect(relay.sendsToPeers).toBe(false);
    });

    it("sends nothing while this process is the only one listening", async () => {
        const db = sender(1);
        const relay = new ChatRelay(db, Date.now, ME);
        relay.prime();
        await settle();
        relay.send({ channelId: "c", kind: "posted", actorId: "a" });
        await settle();
        relay.send({ channelId: "c", kind: "posted", actorId: "a" });
        await settle();
        expect(db.notify).not.toHaveBeenCalled();
        // Asked once for the window, not once per message.
        expect(db.listeners).toHaveBeenCalledTimes(1);
    });

    it("sends once another replica is counted, or the moment one says hello", async () => {
        const counted = sender(2);
        const relay = new ChatRelay(counted, Date.now, ME);
        relay.prime();
        await settle();
        relay.send({ channelId: "c", kind: "posted", actorId: "a" });
        await settle();
        expect(counted.notify).toHaveBeenCalledTimes(1);

        const alone = sender(1);
        const greeted = new ChatRelay(alone, Date.now, ME);
        greeted.prime();
        await settle();
        greeted.send({ channelId: "c", kind: "posted", actorId: "a" });
        await settle();
        greeted.heard();
        greeted.send({ channelId: "c", kind: "posted", actorId: "a" });
        await settle();
        expect(alone.notify).toHaveBeenCalledTimes(1);
        const payloads = alone.notify.mock.calls[0]![0];
        expect(JSON.parse(payloads[0]!)).toMatchObject({ n: ME, c: { channelId: "c" } });
    });
});
