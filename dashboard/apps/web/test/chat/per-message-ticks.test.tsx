// @vitest-environment jsdom

/**
 * The two client rules behind the second tick: which conversations a frame says
 * a message landed in, and which rows of the list a delivery can move. Where the
 * ticks are drawn is `message-ticks/once-per-block`.
 */

import type { ChatChannelView } from "@/lib/chat/chat-service";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/chat/actions", () => ({
    deleteMessageAction: async () => ({}),
    saveMediaAction: async () => ({}),
    unsaveMediaAction: async () => ({}),
    linkPreviewAction: async () => ({}),
    openDirectAction: async () => ({ id: "d1" })
}));
vi.mock("@/app/(app)/account/privacy/actions", () => ({
    listBlockedAction: async () => ({ people: [] }),
    blockPersonAction: async () => ({}),
    unblockPersonAction: async () => ({})
}));
vi.mock("@/app/(app)/account/report-actions", () => ({ reportPersonAction: async () => ({}) }));
vi.mock("@/app/(app)/chat/chat-context", () => ({
    ChatProvider: () => null,
    useChat: () => ({
        blocked: new Set<string>(),
        friends: new Set<string>(),
        channels: [],
        spaces: [],
        may: {},
        refresh: () => undefined
    })
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
    usePathname: () => "/chat"
}));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/app/(app)/chat/server-rail", () => ({ ServerRail: () => null }));
vi.mock("@/app/(app)/chat/chat-sidebar", () => ({ ChatSidebar: () => null }));
vi.mock("@/app/(app)/chat/live-location-bar", () => ({ LiveLocationBar: () => null }));
vi.mock("@/app/(app)/chat/lock-dialogs", () => ({
    ChatLockProvider: ({ children }: { children: unknown }) => children
}));

const { deliveryMayMove } = await import("@/app/(app)/chat/chat-shell");
const { arrivedIn } = await import("@/components/chat-unread");

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

describe("which conversations a frame says a message landed in", () => {
    it("is the arrivals, falling back to every conversation named by an older server", () => {
        expect(arrivedIn({ kind: "posted", seq: 1, channels: ["a", "b"], arrived: ["a"] })).toEqual(["a"]);
        expect(arrivedIn({ kind: "posted", seq: 1, channels: ["a", "b"] })).toEqual(["a", "b"]);
    });

    it("is nothing for an edit in place or any other frame", () => {
        expect(arrivedIn({ kind: "posted", seq: 1, channels: ["a"], arrived: [] })).toEqual([]);
        expect(arrivedIn({ kind: "read", channelId: "a", userId: "u" })).toEqual([]);
        expect(arrivedIn(null)).toEqual([]);
    });
});

describe("which rows a delivery can move", () => {
    const row = (last: Partial<NonNullable<ChatChannelView["last"]>> | null) =>
        [{ id: "c1", last: last && { receipts: true, delivered: false, read: false, ...last } }] as unknown as ChatChannelView[];

    it("is a row whose own last message is still on one tick", () => {
        expect(deliveryMayMove(row({}), "c1")).toBe(true);
        expect(deliveryMayMove(row({ delivered: true }), "c1")).toBe(false);
        expect(deliveryMayMove(row({ read: true }), "c1")).toBe(false);
        expect(deliveryMayMove(row({ receipts: false }), "c1")).toBe(false);
        expect(deliveryMayMove(row(null), "c1")).toBe(false);
        // A row the list does not hold yet: asked again, to be safe.
        expect(deliveryMayMove(row({}), "elsewhere")).toBe(true);
    });
});
