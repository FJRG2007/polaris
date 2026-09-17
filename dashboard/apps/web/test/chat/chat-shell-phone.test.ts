/**
 * Which addresses take the whole screen on a phone.
 *
 * Opening the conversation with somebody from search lands on its own page
 * first, and when that fails it says why - which nobody sees if the column it is
 * drawn in is the hidden one.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/chat/chat-context", () => ({ ChatProvider: () => null, useChat: () => ({}) }));
vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));
vi.mock("@/app/(app)/chat/server-rail", () => ({ ServerRail: () => null }));
vi.mock("@/app/(app)/chat/chat-sidebar", () => ({ ChatSidebar: () => null }));

const { conversationOnScreen } = await import("@/app/(app)/chat/chat-shell");

describe("the conversation column on a phone", () => {
    it("is shown for a conversation and for opening one with somebody", () => {
        expect(conversationOnScreen("/chat/c/abc")).toBe(true);
        expect(conversationOnScreen("/chat/c/abc/def")).toBe(true);
        expect(conversationOnScreen("/chat/with/abc")).toBe(true);
    });

    it("steps aside for the list", () => {
        expect(conversationOnScreen("/chat")).toBe(false);
    });
});
