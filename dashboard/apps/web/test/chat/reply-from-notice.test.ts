/**
 * Answering a message from its notice.
 *
 * The answer is sent to the conversation, and the conversation is then read up
 * to that answer - somebody who answered has seen what they answered. What is
 * pinned: both happen, in that order, for the caller only; a refused answer is a
 * sentence and nothing is read; an answer that went is reported as gone even
 * when reading up to it failed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const SENT = "22222222-2222-4222-8222-222222222222";

const fake = vi.hoisted(() => ({
    calls: [] as string[],
    refuse: null as string | null,
    readFails: false
}));

vi.mock("@/lib/session", () => ({
    requirePermission: async () => ({ id: "ana", name: "Ana" })
}));
vi.mock("@/lib/chat/messages", async () => {
    const { ChatAccessError } = await import("@/lib/chat/access");
    return {
        send: async (actor: { id: string }, input: { channelId: string; body: string }) => {
            fake.calls.push(`send ${actor.id} ${input.channelId} ${input.body}`);
            if (fake.refuse) throw new ChatAccessError(fake.refuse);
            return SENT;
        },
        markRead: async (
            actor: { id: string },
            input: { channelId: string; messageId: string }
        ) => {
            fake.calls.push(`read ${actor.id} ${input.channelId} ${input.messageId}`);
            if (fake.readFails) throw new Error("database gone");
        }
    };
});

const { replyFromNoticeAction } = await import("@/app/(app)/chat/actions");

beforeEach(() => {
    fake.calls = [];
    fake.refuse = null;
    fake.readFails = false;
});

describe("answering from a notice", () => {
    it("sends the answer, then reads the conversation up to it", async () => {
        expect(await replyFromNoticeAction({ channelId: CHANNEL, body: "on my way" })).toEqual({
            id: SENT
        });
        expect(fake.calls).toEqual([
            `send ana ${CHANNEL} on my way`,
            `read ana ${CHANNEL} ${SENT}`
        ]);
    });

    it("says why an answer was refused, and reads nothing", async () => {
        fake.refuse = "You cannot post in this conversation";
        expect(await replyFromNoticeAction({ channelId: CHANNEL, body: "hi" })).toEqual({
            error: "You cannot post in this conversation"
        });
        expect(fake.calls).toEqual([`send ana ${CHANNEL} hi`]);
    });

    it("reports an answer that went as gone, even when reading up to it failed", async () => {
        fake.readFails = true;
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await replyFromNoticeAction({ channelId: CHANNEL, body: "hi" })).toEqual({
            id: SENT
        });
        quiet.mockRestore();
    });

    it("refuses something that is not an answer to a conversation", async () => {
        expect((await replyFromNoticeAction({ channelId: "nope", body: "hi" })).error).toBeTruthy();
        expect((await replyFromNoticeAction({ channelId: CHANNEL, body: "" })).error).toBeTruthy();
        expect(fake.calls).toEqual([]);
    });
});
