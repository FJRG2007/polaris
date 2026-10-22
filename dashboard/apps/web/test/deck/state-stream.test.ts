/**
 * The state stream's pure parts: the frame's shape, and which chat changes may
 * move this person's unread count. Also the key kind a stored row names, and a
 * change announced on the deck bus reaching an open stream within a second.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/chat/access", () => ({ reachableChannelIds: async () => new Set<string>() }));
vi.mock("@/lib/chat/live", () => ({ subscribeChatChanges: () => () => undefined }));
let reads = 0;
vi.mock("@/lib/deck/deck-service", () => ({
    readDeckStates: async () => {
        reads += 1;
        const state = { tone: "ok", value: String(reads) };
        return { readings: [{ key: "k1", state }], chat: false };
    }
}));

const { chatChangeConcerns, deckChangeConcerns, deckStateStream, stateFrame } =
    await import("@/lib/deck/state-stream");
const { deckChanged } = await import("@/lib/deck/live");
const { apiKeyKindOf } = await import("../../../../packages/auth/src/api-keys");

describe("stateFrame", () => {
    it("is one named event with the readings as JSON", () => {
        expect(stateFrame([{ key: "a", state: { tone: "ok", on: true } }])).toBe(
            'event: state\ndata: {"readings":[{"key":"a","state":{"tone":"ok","on":true}}]}\n\n'
        );
    });
});

describe("chatChangeConcerns", () => {
    const reachable = new Set(["c1"]);

    it("wakes for a message or a read in a conversation this person reaches", () => {
        expect(
            chatChangeConcerns({ kind: "posted", channelId: "c1" } as never, "u1", reachable)
        ).toBe(true);
        expect(
            chatChangeConcerns({ kind: "read", channelId: "c1" } as never, "u1", reachable)
        ).toBe(true);
    });

    it("wakes for a change addressed to them", () => {
        expect(
            chatChangeConcerns({ kind: "channels", audience: ["u1"] } as never, "u1", reachable)
        ).toBe(true);
    });

    it("ignores other conversations and changes that move no count", () => {
        expect(
            chatChangeConcerns({ kind: "posted", channelId: "c9" } as never, "u1", reachable)
        ).toBe(false);
        expect(
            chatChangeConcerns({ kind: "typing", channelId: "c1" } as never, "u1", reachable)
        ).toBe(false);
    });
});

describe("apiKeyKindOf", () => {
    it("names a deck's key, and reads anything unknown as an ordinary key", () => {
        expect(apiKeyKindOf("streamdeck")).toBe("streamdeck");
        expect(apiKeyKindOf("cli")).toBe("cli");
        expect(apiKeyKindOf("key")).toBe("key");
        expect(apiKeyKindOf("something-else")).toBe("key");
    });
});

describe("the deck bus", () => {
    const watched = [{ key: "k1", action: "calendar.timer", options: {} }];

    it("concerns a stream of the same account showing one of the actions", () => {
        expect(deckChangeConcerns(watched, "u1", "u1", ["calendar.timer"])).toBe(true);
        expect(deckChangeConcerns(watched, "u1", "u2", ["calendar.timer"])).toBe(false);
        expect(deckChangeConcerns(watched, "u1", "u1", ["chat.unread"])).toBe(false);
    });

    it("reads the keys again within a second of a change, not on the next tick", async () => {
        reads = 0;
        const abort = new AbortController();
        const stream = deckStateStream(
            { userId: "u1", locale: "en-US" } as never,
            watched,
            (() => "") as never,
            abort.signal
        );
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        const frames: string[] = [];
        const next = async () => {
            for (;;) {
                const { value } = await reader.read();
                const text = decoder.decode(value);
                if (text.startsWith("event: state")) return frames.push(text);
            }
        };
        await next();
        expect(reads).toBe(1);
        // Another account's change, or one no key shows, wakes nothing.
        void deckChanged("u2", ["calendar.timer"]);
        void deckChanged("u1", ["chat.unread"]);
        const started = Date.now();
        void deckChanged("u1", ["calendar.timer"]);
        void deckChanged("u1", ["calendar.timer"]);
        await next();
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(reads).toBe(2);
        expect(frames[1]).toContain('"value":"2"');
        abort.abort();
    });
});
