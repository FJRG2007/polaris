/**
 * The live bus hands a change to the listeners of its own conversation and the
 * accounts it names - never to every open connection to be turned down by each.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    chatListenersOn,
    listenersFor,
    publishChatChange,
    subscribeChatChanges,
    type ChatSubscription
} from "@/lib/chat/live";

const held: ChatSubscription[] = [];
const hold = (subscription: ChatSubscription) => {
    held.push(subscription);
    return subscription;
};

afterEach(() => {
    for (const unsubscribe of held.splice(0)) unsubscribe();
});

describe("a message in a busy instance", () => {
    it("calls only the listeners of its conversation, however many others are open", () => {
        const others = vi.fn();
        for (let i = 0; i < 10_000; i += 1) {
            hold(subscribeChatChanges(others, { userId: `reader-${i}`, channels: [`room-${i % 500}`] }));
        }
        const mine = vi.fn();
        hold(subscribeChatChanges(mine, { userId: "ada", channels: ["general"] }));

        const change = { channelId: "general", kind: "posted", actorId: "grace" } as const;
        // No scan: the candidates are the conversation's, not the instance's.
        expect(listenersFor(change).size).toBe(1);
        publishChatChange(change);
        expect(mine).toHaveBeenCalledTimes(1);
        expect(others).not.toHaveBeenCalled();
    });

    it("reaches an addressed account through its own index, not through a room", () => {
        const ring = vi.fn();
        hold(subscribeChatChanges(ring, { userId: "ada", channels: [] }));
        publishChatChange({ kind: "call-settled", actorId: "ada", meetingId: "m", audience: ["ada"] });
        publishChatChange({ kind: "game-invite", actorId: "grace", sessionId: "s", audience: ["linus"] });
        expect(ring).toHaveBeenCalledTimes(1);
    });

    it("hands a face change to the rooms it names", () => {
        const face = vi.fn();
        hold(subscribeChatChanges(face, { userId: "ada", channels: ["dm"] }));
        publishChatChange({ kind: "appearance", actorId: "grace", channels: ["dm", "elsewhere"] });
        expect(face).toHaveBeenCalledTimes(1);
    });

    it("gives a structural change addressed to nobody to everybody", () => {
        const a = vi.fn();
        const b = vi.fn();
        hold(subscribeChatChanges(a, { userId: "ada", channels: [] }));
        hold(subscribeChatChanges(b, { userId: "linus", channels: ["x"] }));
        publishChatChange({ channelId: "new-room", kind: "channels", actorId: "grace" });
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });
});

describe("the index follows the reader", () => {
    it("moves with a new answer and empties when the stream closes", () => {
        const listener = vi.fn();
        const subscription = subscribeChatChanges(listener, { userId: "ada", channels: ["a"] });
        expect(chatListenersOn("a")).toBe(1);
        subscription.retarget(["b"]);
        expect(chatListenersOn("a")).toBe(0);
        expect(chatListenersOn("b")).toBe(1);
        publishChatChange({ channelId: "a", kind: "posted", actorId: "grace" });
        expect(listener).not.toHaveBeenCalled();
        subscription();
        expect(chatListenersOn("b")).toBe(0);
    });

    it("still offers everything to a listener with no interest", () => {
        const wide = vi.fn();
        hold(subscribeChatChanges(wide));
        publishChatChange({ channelId: "anywhere", kind: "posted", actorId: "grace" });
        expect(wide).toHaveBeenCalledTimes(1);
    });
});
