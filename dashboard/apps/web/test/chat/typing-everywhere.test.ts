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

    it("drops a writer the moment their message lands, Polar included", () => {
        const ana = { userId: "ana", name: "Ana", activity: "typing" as const, at: 1_000 };
        const polar = { userId: "polar", name: "Polar", activity: "typing" as const, at: 1_000 };
        expect(typing.withoutWriters([ana, polar], [{ authorId: null, fromAgent: "polar" }])).toEqual([ana]);
        expect(typing.withoutWriters([ana, polar], [{ authorId: "ana" }])).toEqual([polar]);
        const both = [ana, polar];
        expect(typing.withoutWriters(both, [{ authorId: "bea" }])).toBe(both);
    });

    it("stops the list's dots when a message arrives, and only Polar's when it answers in place", () => {
        const ana = { userId: "ana", name: "Ana", activity: "typing" as const, at: Date.now() };
        const polar = { userId: "polar", name: "Polar", activity: "typing" as const, at: Date.now() };
        typing.noteTyping("c1", ana);
        typing.noteTyping("c1", polar);
        typing.stopTyping("c1", new Set(["polar"]));
        expect(typing.typistsAt([ana], Date.now())).toEqual([ana]);
        typing.stopTyping("c1");
        typing.noteTyping("c2", ana);
        typing.stopTyping("c2");
        // Nothing left to stop: a second call is a no-op.
        expect(() => typing.stopTyping("c2")).not.toThrow();
    });
});
