/**
 * A conversation being read stops counting as unread on this tab at once.
 *
 * What is pinned: opening a conversation, answering in it, or a message landing
 * while it is being read takes it off the rail and the badge totals before the
 * server has said anything; an answer that set off before the read cannot put
 * the badge back; and a read the server refuses is taken back. The read itself
 * goes to the server in the background, newest first and never in a pile.
 */

import * as readMarks from "@/lib/chat/read-marks";
import { afterEach, describe, expect, it, vi } from "vitest";

const T0 = Date.parse("2026-11-22T10:00:00.000Z");
const iso = (offset: number) => new Date(T0 + offset).toISOString();

/** A sender the test answers by hand, so "before the server said so" is real. */
function heldSender() {
    const calls: { channelId: string; messageId: string; answer: (ok: boolean) => void }[] = [];
    const send: readMarks.ReadSender = (channelId, messageId) =>
        new Promise<boolean>((resolve) => calls.push({ channelId, messageId, answer: resolve }));
    return { calls, send };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => readMarks.resetReadMarks());

describe("opening a conversation", () => {
    it("clears its count and the totals before any request", () => {
        const before = readMarks.readMarksVersion();
        const server = {
            messages: 7,
            conversations: 2,
            waiting: [
                { id: "a", unread: 5, at: T0 },
                { id: "b", unread: 2, at: T0 }
            ]
        };
        readMarks.watchReading("a", () => true);
        expect(readMarks.readMarksVersion()).toBeGreaterThan(before);
        expect(readMarks.settledUnread("a", 5, iso(0))).toBe(0);
        expect(readMarks.settledTotals(server)).toEqual({ messages: 2, conversations: 1 });
    });

    it("counts again once nobody is reading it and nothing was marked", () => {
        const stop = readMarks.watchReading("a", () => true);
        stop();
        expect(readMarks.settledUnread("a", 5, iso(0))).toBe(5);
    });

    it("still counts in a hidden tab", () => {
        let visible = false;
        readMarks.watchReading("a", () => visible);
        expect(readMarks.settledUnread("a", 3, iso(0))).toBe(3);
        visible = true;
        expect(readMarks.settledUnread("a", 3, iso(0))).toBe(0);
    });

    it("leaves the totals alone when the server names no conversations", () => {
        readMarks.watchReading("a", () => true);
        expect(readMarks.settledTotals({ messages: 4, conversations: 1 })).toEqual({
            messages: 4,
            conversations: 1
        });
    });
});

describe("reading up to a message", () => {
    it("clears at once while the request is still on its way", () => {
        const { calls, send } = heldSender();
        readMarks.markRead("a", "m1", iso(0), send);
        expect(calls.map((call) => call.messageId)).toEqual(["m1"]);
        expect(readMarks.settledUnread("a", 4, iso(0))).toBe(0);
        expect(
            readMarks.settledTotals({
                messages: 4,
                conversations: 1,
                waiting: [{ id: "a", unread: 4, at: T0 }]
            })
        ).toEqual({ messages: 0, conversations: 0 });
    });

    it("an own send clears everything above it, here and on the server", async () => {
        const { calls, send } = heldSender();
        // What `sendText` does first: catch up on what is on screen.
        readMarks.markRead("a", "theirs", iso(0), send);
        expect(readMarks.settledUnread("a", 2, iso(0))).toBe(0);
        calls[0]?.answer(true);
        await flush();
        // Their echo of our own reply then moves the mark to it.
        readMarks.markRead("a", "mine", iso(5), send);
        expect(calls.map((call) => call.messageId)).toEqual(["theirs", "mine"]);
        expect(readMarks.readMarkOf("a")).toBe(T0 + 5);
    });

    it("sends the newest read only, never every one in between", async () => {
        const { calls, send } = heldSender();
        readMarks.markRead("a", "m1", iso(0), send);
        readMarks.markRead("a", "m2", iso(1), send);
        readMarks.markRead("a", "m3", iso(2), send);
        expect(calls.map((call) => call.messageId)).toEqual(["m1"]);
        calls[0]?.answer(true);
        await flush();
        expect(calls.map((call) => call.messageId)).toEqual(["m1", "m3"]);
        calls[1]?.answer(true);
        await flush();
        // Nothing older than the mark is sent again.
        readMarks.markRead("a", "m2", iso(1), send);
        expect(calls).toHaveLength(2);
    });
});

describe("a message arriving while the conversation is being read", () => {
    it("never bumps its badge, whichever answer lands first", () => {
        const { send } = heldSender();
        readMarks.markRead("a", "m1", iso(0), send);
        readMarks.watchReading("a", () => true);
        // The rail's answer, counted before the new message was marked.
        expect(readMarks.settledUnread("a", 1, iso(10))).toBe(0);
        expect(
            readMarks.settledTotals({
                messages: 1,
                conversations: 1,
                waiting: [{ id: "a", unread: 1, at: T0 + 10 }]
            })
        ).toEqual({ messages: 0, conversations: 0 });
    });

    it("does bump a conversation nobody is reading", () => {
        readMarks.watchReading("a", () => true);
        expect(readMarks.settledUnread("b", 1, iso(10))).toBe(1);
    });
});

describe("a stale answer", () => {
    it("does not bring the badge back", () => {
        const { send } = heldSender();
        readMarks.markRead("a", "m1", iso(0), send);
        // Counted on the server before the read reached it.
        expect(readMarks.settledUnread("a", 3, iso(0))).toBe(0);
        expect(readMarks.settledUnread("a", 3, iso(-1000))).toBe(0);
        expect(
            readMarks.settledTotals({
                messages: 5,
                conversations: 2,
                waiting: [
                    { id: "a", unread: 3, at: T0 },
                    { id: "b", unread: 2, at: T0 + 1 }
                ]
            })
        ).toEqual({ messages: 2, conversations: 1 });
    });

    it("lets a genuinely newer message count", () => {
        const { send } = heldSender();
        readMarks.markRead("a", "m1", iso(0), send);
        expect(readMarks.settledUnread("a", 1, iso(1))).toBe(1);
    });

    it("never moves the mark backwards", () => {
        const { send } = heldSender();
        readMarks.markRead("a", "m2", iso(10), send);
        readMarks.markRead("a", "m1", iso(0), send);
        expect(readMarks.readMarkOf("a")).toBe(T0 + 10);
    });
});

describe("a read the server refuses", () => {
    it("is taken back", async () => {
        const { calls, send } = heldSender();
        readMarks.markRead("a", "m1", iso(0), send);
        expect(readMarks.settledUnread("a", 2, iso(0))).toBe(0);
        calls[0]?.answer(false);
        await flush();
        expect(readMarks.readMarkOf("a")).toBeUndefined();
        expect(readMarks.settledUnread("a", 2, iso(0))).toBe(2);
    });

    it("goes back to the last read the server took, not further", async () => {
        const { calls, send } = heldSender();
        readMarks.markRead("a", "m1", iso(0), send);
        calls[0]?.answer(true);
        await flush();
        readMarks.markRead("a", "m2", iso(5), send);
        calls[1]?.answer(false);
        await flush();
        expect(readMarks.readMarkOf("a")).toBe(T0);
        expect(readMarks.settledUnread("a", 1, iso(5))).toBe(1);
    });

    it("is settled by a newer read already on its way", async () => {
        const { calls, send } = heldSender();
        readMarks.markRead("a", "m1", iso(0), send);
        readMarks.markRead("a", "m2", iso(5), send);
        calls[0]?.answer(false);
        await flush();
        expect(readMarks.readMarkOf("a")).toBe(T0 + 5);
        calls[1]?.answer(true);
        await flush();
        expect(readMarks.readMarkOf("a")).toBe(T0 + 5);
    });

    it("from the list's menu, puts every conversation back", () => {
        const undo = readMarks.readThrough([
            { id: "a", lastMessageAt: iso(0) },
            { id: "b", lastMessageAt: iso(1) }
        ]);
        expect(readMarks.settledUnread("b", 4, iso(1))).toBe(0);
        undo();
        expect(readMarks.settledUnread("a", 4, iso(0))).toBe(4);
        expect(readMarks.settledUnread("b", 4, iso(1))).toBe(4);
    });
});

describe("marking unread on purpose", () => {
    it("drops what this tab read ahead of the server", () => {
        const { send } = heldSender();
        readMarks.markRead("a", "m1", iso(0), send);
        readMarks.forgetReadMark("a");
        expect(readMarks.settledUnread("a", 1, iso(0))).toBe(1);
    });
});

describe("the default sender", () => {
    it("posts to the read route and reports a refusal", async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 403 }));
        vi.stubGlobal("fetch", fetchMock);
        try {
            await expect(readMarks.postRead("chan", "msg")).resolves.toBe(false);
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/chat/channels/chan/read",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify({ messageId: "msg" })
                })
            );
            fetchMock.mockImplementationOnce(async () => {
                throw new Error("offline");
            });
            await expect(readMarks.postRead("chan", "msg")).resolves.toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
