/**
 * Answering a message from its notice.
 *
 * The conversation is read up to the message the notice announced, and the
 * answer is sent - somebody who answered has seen what they answered. Read
 * first, because sending moves the sender's own mark past everything and would
 * leave the read nothing to do. What is pinned: both happen, in that order, for
 * the caller only; a refused answer is a sentence; an answer is sent even when
 * reading failed, and without an announced message is only sent.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const SENT = "22222222-2222-4222-8222-222222222222";
const ANNOUNCED = "33333333-3333-4333-8333-333333333333";

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
    it("reads the conversation up to the announced message, then sends the answer", async () => {
        expect(
            await replyFromNoticeAction({
                channelId: CHANNEL,
                messageId: ANNOUNCED,
                body: "on my way"
            })
        ).toEqual({ id: SENT });
        expect(fake.calls).toEqual([
            `read ana ${CHANNEL} ${ANNOUNCED}`,
            `send ana ${CHANNEL} on my way`
        ]);
    });

    it("says why an answer was refused", async () => {
        fake.refuse = "You cannot post in this conversation";
        expect(
            await replyFromNoticeAction({ channelId: CHANNEL, messageId: ANNOUNCED, body: "hi" })
        ).toEqual({ error: "You cannot post in this conversation" });
    });

    it("still sends the answer when reading failed", async () => {
        fake.readFails = true;
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(
            await replyFromNoticeAction({ channelId: CHANNEL, messageId: ANNOUNCED, body: "hi" })
        ).toEqual({ id: SENT });
        expect(fake.calls).toEqual([`read ana ${CHANNEL} ${ANNOUNCED}`, `send ana ${CHANNEL} hi`]);
        quiet.mockRestore();
    });

    it("only sends when there is no announced message to read up to", async () => {
        expect(await replyFromNoticeAction({ channelId: CHANNEL, body: "hi" })).toEqual({
            id: SENT
        });
        expect(fake.calls).toEqual([`send ana ${CHANNEL} hi`]);
    });

    it("refuses something that is not an answer to a conversation", async () => {
        expect((await replyFromNoticeAction({ channelId: "nope", body: "hi" })).error).toBeTruthy();
        expect((await replyFromNoticeAction({ channelId: CHANNEL, body: "" })).error).toBeTruthy();
        expect(
            (await replyFromNoticeAction({ channelId: CHANNEL, messageId: "nope", body: "hi" }))
                .error
        ).toBeTruthy();
        expect(fake.calls).toEqual([]);
    });
});
