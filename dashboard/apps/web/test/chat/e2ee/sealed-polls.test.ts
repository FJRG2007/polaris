/**
 * Polls in a sealed conversation: the question and answers ride inside the
 * seal; the server is told only how many answers there are and the rules, and
 * keeps one wordless answer row per answer; a reader's row and a refreshed
 * card take the words from the seal, by position.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sent: [] as unknown[][] }));

vi.mock("@polaris/db", () => ({
    Prisma: {},
    prisma: {
        mlsDevice: { findUnique: async () => ({ signatureKey: new Uint8Array(32) }) },
        mlsGroup: { findUnique: async () => ({ epoch: 3n }) },
        chatMessage: { findFirst: async () => null }
    }
}));
vi.mock("@polaris/auth", () => ({ can: async () => true }));
vi.mock("@/lib/chat/rules", () => ({ rulesForChannel: async () => ({ maxAttachments: 10, keepEditHistory: false }) }));
vi.mock("@/lib/chat/uploads", () => ({ UploadRefused: class extends Error {}, claimUploads: async () => [] }));
vi.mock("@/lib/chat/attachments", () => ({ removeStoredFiles: async () => undefined }));
vi.mock("@/lib/chat/messages", () => ({
    send: async (...args: unknown[]) => {
        state.sent.push(args);
        return "m1";
    }
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/vanish", () => ({ expiryForChannel: async () => null }));
vi.mock("@/lib/chat/chat-lock", () => ({ unhideOnMessage: async () => undefined }));
vi.mock("@polaris/chat-crypto/message-content", () => ({ verifyMessageSignature: async () => true }));
vi.mock("@/lib/chat/e2ee/sealed-polar", () => ({ answerSealedPolarLater: () => undefined }));

import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import type { ChatMessageView } from "@/lib/chat/messages";
import type { ChatPollView } from "@/lib/chat/polls";
import { openedPoll, withOpened } from "@/app/(app)/chat/opened-sealed";
import { keepTexts } from "@/app/(app)/chat/opened-sealed";
import { mlsBody } from "@/lib/chat/e2ee/schemas";
import { sendSealed } from "@/lib/chat/e2ee/sealed-messages";
import { POLAR_SERVICE_ID } from "@/lib/chat/service-members";

const view = (texts: string[]): ChatPollView => ({
    multiple: false,
    hideResults: false,
    closed: false,
    closesAt: null,
    endedEarly: false,
    results: true,
    voters: 1,
    voted: true,
    options: texts.map((text, at) => ({ id: `o${at}`, text, votes: at === 0 ? 1 : 0, mine: at === 0 }))
});

describe("a sealed poll's content", () => {
    it("carries the answers through the seal and refuses a malformed one", () => {
        const content = { body: "Lunch?", poll: { options: ["Pizza", "Sushi"] } };
        expect(sealedChat.decodeSealedContent(sealedChat.encodeSealedContent(content))).toEqual(content);
        const one = new TextEncoder().encode(JSON.stringify({ v: 1, body: "x", poll: { options: ["only"] } }));
        expect(sealedChat.decodeSealedContent(one)).toBeNull();
        const extra = new TextEncoder().encode(JSON.stringify({ v: 1, body: "x", poll: { options: ["a", "b"], votes: 3 } }));
        expect(sealedChat.decodeSealedContent(extra)).toBeNull();
        expect(sealedChat.decodeSealedContent(sealedChat.encodeSealedContent({ body: "plain" }))).toEqual({ body: "plain" });
    });

    it("names the server's wordless answers by position, on the row and on a refreshed card", () => {
        const named = openedPoll(view(["", ""]), { options: ["Pizza", "Sushi"] });
        expect(named.options.map((option) => option.text)).toEqual(["Pizza", "Sushi"]);
        expect(named.options[0]).toMatchObject({ votes: 1, mine: true });
        const message = { id: "m1", channelId: "c", sealed: true, body: "", poll: view(["", ""]) } as unknown as ChatMessageView;
        const [row] = withOpened([message], () => ({ body: "Lunch?", poll: { options: ["Pizza", "Sushi"] } }));
        expect(row!.body).toBe("Lunch?");
        expect(row!.poll!.options.map((option) => option.text)).toEqual(["Pizza", "Sushi"]);
        const fresh = { ...view(["", ""]), voters: 2 };
        expect(keepTexts(fresh, named).options.map((option) => option.text)).toEqual(["Pizza", "Sushi"]);
        expect(keepTexts(view(["A", "B"]), named).options.map((option) => option.text)).toEqual(["A", "B"]);
    });
});

describe("the server's sealed poll", () => {
    const input = (extra: object = {}) => ({
        channelId: "c",
        device: "d",
        clientKey: "0190a8c1-0000-7000-8000-0000000000aa",
        epoch: 3n,
        senderLeaf: 0,
        ciphertext: new Uint8Array(40),
        signature: new Uint8Array(64),
        ...extra
    });

    beforeEach(() => {
        state.sent = [];
    });

    it("stores one wordless answer row per answer, with the rules", async () => {
        expect(await sendSealed("u1", input({ poll: { options: 3, multiple: true, hideResults: true, anonymous: false, hours: 0 } }))).toBe("m1");
        expect(state.sent[0]![4]).toEqual({ options: ["", "", ""], multiple: true, hideResults: true, anonymous: false, closesAt: null });
        expect(state.sent[0]![1]).toMatchObject({ body: "" });
    });

    it("refuses a poll with files or from a service member, and sends no poll otherwise", async () => {
        await expect(sendSealed("u1", input({ uploads: ["0190a8c1-0000-7000-8000-000000000001"], poll: { options: 2, multiple: false, hideResults: false, hours: 24 } }))).rejects.toMatchObject({ reason: "pollRefused" });
        await expect(sendSealed(POLAR_SERVICE_ID, input({ poll: { options: 2, multiple: false, hideResults: false, hours: 24 } }))).rejects.toMatchObject({ reason: "pollRefused" });
        expect(state.sent).toHaveLength(0);
        await sendSealed("u1", input());
        expect(state.sent[0]![4]).toBeNull();
    });

    it("bounds what a device may claim about a poll", () => {
        const body = (poll: object) => ({ op: "send-sealed", channelId: "0190a8c1-0000-7000-8000-0000000000cc", device: "device-01", clientKey: "0190a8c1-0000-7000-8000-0000000000aa", epoch: "3", senderLeaf: 0, ciphertext: "A".repeat(40), signature: "A".repeat(86), poll });
        expect(mlsBody.safeParse(body({ options: 2, multiple: false, hideResults: false, hours: 24 })).success).toBe(true);
        expect(mlsBody.safeParse(body({ options: 1, multiple: false, hideResults: false, hours: 24 })).success).toBe(false);
        expect(mlsBody.safeParse(body({ options: 11, multiple: false, hideResults: false, hours: 24 })).success).toBe(false);
        expect(mlsBody.safeParse(body({ options: 2, multiple: false, hideResults: false, hours: 5 })).success).toBe(false);
        expect(mlsBody.safeParse(body({ options: 2, multiple: false, hideResults: false, hours: 24, words: ["a"] })).success).toBe(false);
        // A tab from before the choice says nothing about it: anonymous, which publishes nothing.
        const older = mlsBody.safeParse(body({ options: 2, multiple: false, hideResults: false, hours: 24 }));
        expect(older.success && "poll" in older.data ? older.data.poll?.anonymous : null).toBe(true);
        const open = mlsBody.safeParse(body({ options: 2, multiple: false, hideResults: false, anonymous: false, hours: 24 }));
        expect(open.success && "poll" in open.data ? open.data.poll?.anonymous : null).toBe(false);
    });
});
