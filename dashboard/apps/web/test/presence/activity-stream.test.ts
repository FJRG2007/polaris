/**
 * An activity change on the live channel: who is told, and what they are told.
 *
 * What is pinned: a reader who shares a room with the person hears an id and
 * nothing about the activity (the browser asks the presence endpoint, which is
 * where the privacy settings are applied); a reader who shares no room hears
 * nothing; and the person's own screens hear it too, because the change came
 * from a desktop app or a music service rather than from the tab.
 */

import { describe, expect, it, vi } from "vitest";

const READER = { id: "reader", isAdmin: false, name: "Reader" };

vi.mock("../../src/lib/session", () => ({
    resolveSession: async () => READER,
    sessionCan: async () => true
}));
vi.mock("../../src/lib/chat/access", () => ({
    reachableChannelIds: async () => new Set(["room"])
}));

const { GET } = await import("../../src/app/api/chat/stream/route");
const { publishChatChange } = await import("../../src/lib/chat/live");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(): Promise<{ frames: () => unknown[]; close: () => void }> {
    const controller = new AbortController();
    const response = await GET(new Request("http://polaris.test/api/chat/stream", { signal: controller.signal }));
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
                .map((frame) => JSON.parse(frame.slice(6)) as unknown),
        close: () => controller.abort()
    };
}

describe("an activity change", () => {
    it("reaches a reader in one of the person's rooms as an id alone", async () => {
        const tab = await listen();
        publishChatChange({ kind: "activity", actorId: "ada", channels: ["room"] });
        await wait(30);
        tab.close();
        expect(tab.frames()).toEqual([{ kind: "activity", actorId: "ada" }]);
    });

    it("does not reach a reader who shares no room with them", async () => {
        const tab = await listen();
        publishChatChange({ kind: "activity", actorId: "ada", channels: ["elsewhere"] });
        await wait(30);
        tab.close();
        expect(tab.frames()).toEqual([]);
    });

    it("reaches the person's own screens, rooms or not", async () => {
        const tab = await listen();
        publishChatChange({ kind: "activity", actorId: READER.id, channels: [] });
        await wait(30);
        tab.close();
        expect(tab.frames()).toEqual([{ kind: "activity", actorId: READER.id }]);
    });
});
