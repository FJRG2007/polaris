/**
 * Saying that somebody is recording, not just that somebody is doing something.
 *
 * A voice message is half a minute of nothing from the other side, and no dots,
 * because nobody is typing - which reads exactly like having been left
 * mid-conversation. So the announcement carries which of the two it is, and the
 * line under the conversation words it.
 *
 * The value comes off a browser, so the part worth pinning is that it is checked
 * rather than taken: this is a string from outside that decides what a room full
 * of people is told about somebody.
 */

import { describe, expect, it, vi } from "vitest";
import { CHAT_ACTIVITIES, chatActivitySchema } from "@polaris/core";

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: { findMany: async () => [], findFirst: async () => null },
        chatReaction: { findMany: async () => [] },
        chatAttachment: { findMany: async () => [] },
        chatStar: { findMany: async () => [] },
        chatChannel: { findUnique: async () => ({ kind: "text" }) },
        chatChannelMember: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
        user: { findMany: async () => [] }
    }
}));
vi.mock("@/lib/chat/access", () => ({
    requireChannel: async () => undefined,
    requirePostable: async () => undefined,
    reachableChannelIds: async () => new Set<string>(),
    ChatAccessError: class extends Error {},
    ChatRuleError: class extends Error {}
}));
vi.mock("@/lib/privacy-service", () => ({ receiptsBetween: async () => null }));
vi.mock("@/lib/chat/rules", () => ({ rulesForChannel: async () => ({ keepEditHistory: false }) }));
vi.mock("@/lib/chat/room-mentions", () => ({ announceRoomMention: async () => undefined }));
vi.mock("@/lib/chat/link-preview", () => ({
    knownPreviews: async () => new Map(),
    unfurl: async () => undefined
}));

const { announceTyping } = await import("@/lib/chat/messages");
const { subscribeChatChanges } = await import("@/lib/chat/live");

const actor = { id: "ada", name: "Ada" };

/** What the bus carried while `run` was running. */
async function heard(run: () => Promise<void>) {
    const changes: { kind: string; activity?: string }[] = [];
    const stop = subscribeChatChanges((change) => changes.push(change));
    try {
        await run();
    } finally {
        stop();
    }
    return changes;
}

describe("what the other side is told", () => {
    it("carries the recording, so it can be worded as one", async () => {
        const changes = await heard(() => announceTyping(actor, "c1", "recording"));

        expect(changes).toHaveLength(1);
        expect(changes[0]?.kind).toBe("typing");
        expect(changes[0]?.activity).toBe("recording");
    });

    it("is typing when nothing says otherwise", async () => {
        // A tab running the build from before recordings were announced calls
        // this with nothing, and the room still gets its dots.
        const changes = await heard(() => announceTyping(actor, "c1"));

        expect(changes[0]?.activity).toBe("typing");
    });
});

describe("what a browser is allowed to claim it is doing", () => {
    it("takes the two there are", () => {
        for (const activity of CHAT_ACTIVITIES) {
            expect(chatActivitySchema.parse(activity)).toBe(activity);
        }
    });

    it("reads anything else as typing rather than refusing the call", () => {
        // The indicator is a courtesy. Failing somebody's keystroke because
        // their tab sent a word this build does not know would be a worse trade
        // than drawing the dots.
        expect(chatActivitySchema.parse(undefined)).toBe("typing");
        expect(chatActivitySchema.parse("dancing")).toBe("typing");
        expect(chatActivitySchema.parse({ activity: "recording" })).toBe("typing");
    });
});
