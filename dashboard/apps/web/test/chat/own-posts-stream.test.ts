/**
 * What the live channel tells somebody about their own doing.
 *
 * What is pinned: a line posted in their name reaches their own screens - a
 * "you started a call" or "you added Ana" written by the server was settled in
 * no tab, and appeared for everybody but them until they reloaded - while their
 * own typing and their own call ringing are still kept from them.
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

describe("their own doing", () => {
    it("tells them about a line posted in their name", async () => {
        const tab = await listen();
        publishChatChange({ channelId: "room", kind: "posted", actorId: READER.id });
        await wait(250);
        tab.close();
        expect(tab.frames()).toEqual([
            expect.objectContaining({ kind: "posted", channels: ["room"] })
        ]);
    });

    it("still keeps their own typing and their own call from them", async () => {
        const tab = await listen();
        publishChatChange({
            channelId: "room",
            kind: "typing",
            actorId: READER.id,
            actorName: "Reader"
        });
        publishChatChange({
            channelId: "room",
            kind: "call",
            actorId: READER.id,
            call: { meetingId: "m1", state: "ringing", count: 1 }
        });
        await wait(250);
        tab.close();
        expect(tab.frames()).toEqual([]);
    });
});
