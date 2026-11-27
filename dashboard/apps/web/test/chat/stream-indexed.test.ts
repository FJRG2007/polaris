/**
 * The chat stream is indexed under the rooms its reader reaches, and says the
 * delivery of what lands on it itself instead of waiting for the device to.
 */

import { describe, expect, it, vi } from "vitest";

const READER = { id: "reader", isAdmin: false, name: "Reader" };
const queued = vi.hoisted(() => [] as Array<{ userId: string; channelIds: readonly string[] }>);

vi.mock("../../src/lib/session", () => ({
    resolveSession: async () => READER,
    backgroundUser: async () => READER,
    sessionCan: async () => true
}));
vi.mock("../../src/lib/chat/access", () => ({
    reachableChannelIds: async () => new Set(["dm", "group"])
}));
vi.mock("../../src/lib/chat/vanish", () => ({
    chatPrivacyOf: async () => ({ receipts: "follow", typing: "follow" })
}));
vi.mock("../../src/lib/privacy-service", () => ({ typingAllowed: async () => true }));
vi.mock("../../src/lib/chat/delivered-batch", () => ({
    queueDelivered: (userId: string, channelIds: readonly string[]) => queued.push({ userId, channelIds })
}));

const { GET } = await import("../../src/app/api/chat/stream/route");
const { chatListenersOn, publishChatChange } = await import("../../src/lib/chat/live");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(): Promise<{ frames: () => Record<string, unknown>[]; close: () => void }> {
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
                .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>),
        close: () => controller.abort()
    };
}

describe("an open chat stream", () => {
    it("is indexed under the rooms its reader reaches and nowhere else, until it closes", async () => {
        const tab = await listen();
        expect(chatListenersOn("dm")).toBe(1);
        expect(chatListenersOn("group")).toBe(1);
        expect(chatListenersOn("elsewhere")).toBe(0);
        tab.close();
        await wait(10);
        expect(chatListenersOn("dm")).toBe(0);
    });

    it("says the delivery of a new message itself and tells the device it did", async () => {
        queued.length = 0;
        const tab = await listen();
        publishChatChange({ channelId: "dm", kind: "posted", actorId: "grace" });
        await wait(250);
        tab.close();
        expect(tab.frames()).toContainEqual(
            expect.objectContaining({ kind: "posted", arrived: ["dm"], delivered: true })
        );
        expect(queued).toEqual([{ userId: "reader", channelIds: ["dm"] }]);
    });

    it("says nothing about delivery for a message that only changed in place", async () => {
        queued.length = 0;
        const tab = await listen();
        publishChatChange({ channelId: "dm", kind: "posted", actorId: "grace", messageIds: ["m1"] });
        await wait(250);
        tab.close();
        const frame = tab.frames().find((f) => f.kind === "posted");
        expect(frame).toBeDefined();
        expect(frame).not.toHaveProperty("delivered");
        expect(queued).toEqual([]);
    });
});
