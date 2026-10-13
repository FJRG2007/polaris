/**
 * What the live channel says when a message changes in place.
 *
 * What is pinned: a deletion, an edit or a reaction names the message it
 * touched, so a screen can read that one again - a bare wake was answered with
 * "what is newer than what I hold", which brought nothing back, and a deleted
 * message stayed on every other screen until it was reloaded. Several in one
 * burst are one frame, and too many to name become "read everything again".
 */

import { describe, expect, it, vi } from "vitest";

const READER = { id: "reader", isAdmin: false, name: "Reader" };

vi.mock("../../src/lib/session", () => ({
    resolveSession: async () => READER,
    backgroundUser: async () => READER,
    sessionCan: async () => true
}));
vi.mock("../../src/lib/chat/access", () => ({
    reachableChannelIds: async () => new Set(["room"])
}));

const { GET } = await import("../../src/app/api/chat/stream/route");
const { publishChatChange } = await import("../../src/lib/chat/live");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(): Promise<{ frames: () => { kind: string }[]; close: () => void }> {
    const controller = new AbortController();
    const response = await GET(
        new Request("http://polaris.test/api/chat/stream", { signal: controller.signal })
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const seen: string[] = [];
    void (async () => {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) return;
                seen.push(decoder.decode(value));
            }
        } catch {
            // Aborting is how the test ends.
        }
    })();
    await wait(30);
    return {
        frames: () =>
            seen
                .join("")
                .split("\n\n")
                .filter((frame) => frame.startsWith("data: "))
                .map((frame) => JSON.parse(frame.slice(6)) as { kind: string }),
        close: () => controller.abort()
    };
}

const OTHER = "someone-else";

describe("a message changed in place", () => {
    it("names the deleted message, so other screens take it down", async () => {
        const tab = await listen();
        publishChatChange({
            channelId: "room",
            kind: "posted",
            actorId: OTHER,
            messageIds: ["m1"]
        });
        await wait(250);
        tab.close();
        expect(tab.frames()).toEqual([
            expect.objectContaining({
                kind: "posted",
                channels: ["room"],
                changed: { room: ["m1"] }
            })
        ]);
    });

    it("gathers a burst of edits and reactions into one frame", async () => {
        const tab = await listen();
        publishChatChange({
            channelId: "room",
            kind: "posted",
            actorId: OTHER,
            messageIds: ["m1"]
        });
        publishChatChange({
            channelId: "room",
            kind: "posted",
            actorId: OTHER,
            messageIds: ["m2", "m1"]
        });
        publishChatChange({ channelId: "room", kind: "posted", actorId: OTHER });
        await wait(250);
        tab.close();
        const frames = tab.frames() as { changed?: Record<string, string[]> }[];
        expect(frames).toHaveLength(1);
        expect(frames[0]?.changed?.room?.sort()).toEqual(["m1", "m2"]);
    });

    it("tells the actor's own other screens too", async () => {
        const tab = await listen();
        publishChatChange({
            channelId: "room",
            kind: "posted",
            actorId: READER.id,
            messageIds: ["m3"]
        });
        await wait(250);
        tab.close();
        expect(tab.frames()).toEqual([expect.objectContaining({ changed: { room: ["m3"] } })]);
    });

    it("asks for everything again once too many changed to name", async () => {
        const tab = await listen();
        for (let index = 0; index < 120; index += 1) {
            publishChatChange({
                channelId: "room",
                kind: "posted",
                actorId: OTHER,
                messageIds: [`m${index}`]
            });
        }
        await wait(250);
        tab.close();
        expect(tab.frames()).toEqual([expect.objectContaining({ changed: { room: [] } })]);
    });

    it("sends the plain wake when only new messages arrived", async () => {
        const tab = await listen();
        publishChatChange({ channelId: "room", kind: "posted", actorId: OTHER });
        await wait(250);
        tab.close();
        const frames = tab.frames() as { changed?: unknown }[];
        expect(frames).toHaveLength(1);
        expect(frames[0]?.changed).toBeUndefined();
    });

    it("does not count an edit as something that arrived", async () => {
        const tab = await listen();
        publishChatChange({
            channelId: "room",
            kind: "posted",
            actorId: OTHER,
            messageIds: ["m1"]
        });
        await wait(250);
        tab.close();
        expect(tab.frames()).toEqual([
            expect.objectContaining({ channels: ["room"], arrived: [] })
        ]);
    });

    it("counts a new message as arrived even when an edit rides with it", async () => {
        const tab = await listen();
        publishChatChange({
            channelId: "room",
            kind: "posted",
            actorId: OTHER,
            messageIds: ["m1"]
        });
        publishChatChange({ channelId: "room", kind: "posted", actorId: OTHER });
        await wait(250);
        tab.close();
        expect(tab.frames()).toEqual([expect.objectContaining({ arrived: ["room"] })]);
    });

    it("says nothing about a conversation this reader is not in", async () => {
        const tab = await listen();
        publishChatChange({
            channelId: "private",
            kind: "posted",
            actorId: OTHER,
            messageIds: ["x"]
        });
        await wait(250);
        tab.close();
        expect(tab.frames()).toEqual([]);
    });
});
