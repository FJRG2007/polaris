/**
 * The second tick, live: a device of somebody picking messages up reaches the
 * people whose ticks it moves, and nobody else.
 */

import { describe, expect, it, vi } from "vitest";

const READER = { id: "reader", isAdmin: false, name: "Reader" };

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

const { GET } = await import("../../src/app/api/chat/stream/route");
const { publishChatChange } = await import("../../src/lib/chat/live");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(): Promise<{ frames: () => Record<string, unknown>[]; close: () => void }> {
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
                .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>),
        close: () => controller.abort()
    };
}

describe("a delivery, on the wire", () => {
    it("reaches the sender it names, with who picked it up", async () => {
        const tab = await listen();
        publishChatChange({ channelId: "dm", kind: "delivered", actorId: "grace", audience: ["reader"] });
        await wait(100);
        tab.close();
        expect(tab.frames()).toContainEqual({ kind: "delivered", channelId: "dm", userId: "grace" });
    });

    it("reaches nobody the publisher did not address, and no conversation out of reach", async () => {
        const tab = await listen();
        publishChatChange({ channelId: "group", kind: "delivered", actorId: "grace", audience: ["linus"] });
        publishChatChange({ channelId: "group", kind: "delivered", actorId: "grace" });
        publishChatChange({ channelId: "elsewhere", kind: "delivered", actorId: "grace", audience: ["reader"] });
        await wait(100);
        tab.close();
        expect(tab.frames().filter((frame) => frame.kind === "delivered")).toEqual([]);
    });

    it("never goes back to the person whose device it was", async () => {
        const tab = await listen();
        publishChatChange({ channelId: "dm", kind: "delivered", actorId: "reader", audience: ["reader"] });
        await wait(100);
        tab.close();
        expect(tab.frames().filter((frame) => frame.kind === "delivered")).toEqual([]);
    });
});
