/**
 * The state stream's pure parts: the frame's shape, and which chat changes may
 * move this person's unread count. Also the key kind a stored row names.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/chat/access", () => ({ reachableChannelIds: async () => new Set<string>() }));
vi.mock("@/lib/chat/live", () => ({ subscribeChatChanges: () => () => undefined }));
vi.mock("@/lib/deck/deck-service", () => ({
    readDeckStates: async () => ({ readings: [], chat: false })
}));

const { chatChangeConcerns, stateFrame } = await import("@/lib/deck/state-stream");
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
