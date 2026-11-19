/**
 * The list's "typing..." comes from one store fed by the stream, and goes on
 * its own a few seconds after the last frame.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/chat/use-chat-stream", () => ({ useChatStream: () => undefined }));

const typing = await import("@/app/(app)/chat/typing-everywhere");

afterEach(() => typing.resetTyping());

describe("who is typing", () => {
    it("keeps a typist for a few seconds after their last frame", () => {
        const entry = { userId: "ana", name: "Ana", activity: "typing" as const, at: 1_000 };
        expect(typing.typistsAt([entry], 1_000 + typing.TYPING_TTL_MS - 1)).toEqual([entry]);
        expect(typing.typistsAt([entry], 1_000 + typing.TYPING_TTL_MS)).toEqual([]);
    });

    it("returns the same list when nothing expired, so a row does not draw again", () => {
        const list = [{ userId: "ana", name: "Ana", activity: "typing" as const, at: 1_000 }];
        expect(typing.typistsAt(list, 1_500)).toBe(list);
    });
});
