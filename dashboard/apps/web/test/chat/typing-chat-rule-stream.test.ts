/**
 * Typing on the live channel under a conversation's own rule.
 *
 * What is pinned: the stream asks for the rule of the conversation the dots
 * are in and hands it to `typingAllowed`, so a chat set to "off" keeps them
 * from a reader both accounts would have allowed, and "on" shows them to a
 * reader an account would have kept them from - in that chat only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const READER = { id: "reader", isAdmin: false, name: "Reader" };
const TYPIST = "0190f0a0-0000-7000-8000-000000000001";

/** Each conversation's typing rule, and what the two accounts would answer. */
let rules = new Map<string, "follow" | "on" | "off">();
let accountsAllow = true;

vi.mock("../../src/lib/session", () => ({
    resolveSession: async () => READER,
    backgroundUser: async () => READER,
    sessionCan: async () => true
}));
vi.mock("../../src/lib/chat/access", () => ({
    reachableChannelIds: async () => new Set(["quiet", "loud", "plain"])
}));
vi.mock("../../src/lib/chat/vanish", () => ({
    chatPrivacyOf: async (channelId: string) => ({
        receipts: "follow",
        typing: rules.get(channelId) ?? "follow"
    })
}));
// The chat's rule is decided inside `typingAllowed` (tested in
// test/privacy/receipts-among); here it only has to arrive there.
vi.mock("../../src/lib/privacy-service", () => ({
    typingAllowed: async (_viewer: unknown, _typer: string, rule = "follow") =>
        rule === "on" ? true : rule === "off" ? false : accountsAllow
}));

const { GET } = await import("../../src/app/api/chat/stream/route");
const { publishChatChange } = await import("../../src/lib/chat/live");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(): Promise<{ frames: () => { kind: string; channelId?: string }[]; close: () => void }> {
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
                .map((frame) => JSON.parse(frame.slice(6)) as { kind: string; channelId?: string }),
        close: () => controller.abort()
    };
}

function typing(channelId: string): void {
    publishChatChange({ channelId, kind: "typing", actorId: TYPIST, actorName: "Grace" });
}

beforeEach(() => {
    rules = new Map([
        ["quiet", "off"],
        ["loud", "on"]
    ]);
    accountsAllow = true;
});

describe("typing under a chat's own rule", () => {
    it("off hides the dots even where both accounts allow them", async () => {
        const tab = await listen();
        typing("quiet");
        typing("plain");
        await wait(150);
        tab.close();
        expect(tab.frames().map((frame) => frame.channelId)).toEqual(["plain"]);
    });

    it("on shows them even where an account withholds them, in that chat only", async () => {
        accountsAllow = false;
        const tab = await listen();
        typing("loud");
        typing("plain");
        await wait(150);
        tab.close();
        expect(tab.frames().map((frame) => frame.channelId)).toEqual(["loud"]);
    });
});
