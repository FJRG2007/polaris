/**
 * Forum posts in a sealed forum: the title rides inside the seal of the
 * first message, the server keeps the post row with no title and its tags,
 * and each reader's browser names the post and searches it from the seal.
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
import type { ChatForumPostView } from "@/lib/chat/forum";
import type { ChatMessageView } from "@/lib/chat/messages";
import { hasSealedTitle, openedPost } from "@/app/(app)/chat/sealed-forum";
import { mlsBody } from "@/lib/chat/e2ee/schemas";
import { sendSealed } from "@/lib/chat/e2ee/sealed-messages";
import { POLAR_SERVICE_ID } from "@/lib/chat/service-members";

const tag = "0190a8c1-0000-7000-8000-0000000000dd";

const root = (extra: object = {}) => ({ id: "m1", channelId: "c", sealed: true, body: "", ...extra }) as unknown as ChatMessageView;
const post = (title: string, extra: object = {}) =>
    ({ id: "p1", title, tagIds: [], createdAt: "", lastActivityAt: "", root: root(extra) }) as unknown as ChatForumPostView;

describe("a sealed forum post's content", () => {
    it("carries the title through the seal and refuses one too long", () => {
        const content = { body: "It crashes on start", title: "Crash on start" };
        expect(sealedChat.decodeSealedContent(sealedChat.encodeSealedContent(content))).toEqual(content);
        const long = new TextEncoder().encode(JSON.stringify({ v: 1, body: "x", title: "t".repeat(1000) }));
        expect(sealedChat.decodeSealedContent(long)).toBeNull();
        expect(sealedChat.encodeSealedContent({ body: "x", title: "" })).toEqual(sealedChat.encodeSealedContent({ body: "x" }));
    });
});

describe("the forum list in the reader's browser", () => {
    const opened = () => ({ body: "It crashes on start", title: "Crash on start" });

    it("names a sealed post from its opened first message", () => {
        expect(hasSealedTitle(post(""))).toBe(true);
        expect(openedPost(post(""), root({ body: "It crashes on start" }), "", opened)?.title).toBe("Crash on start");
        // Not opened yet: no title, still listed.
        expect(openedPost(post(""), root(), "", () => undefined)?.title).toBe("");
    });

    it("keeps a plain title, also on a migrated post whose first message is sealed", () => {
        const plain = post("Old title");
        expect(hasSealedTitle(plain)).toBe(false);
        expect(openedPost(plain, plain.root, "zzz", opened)).toBe(plain);
        expect(hasSealedTitle(post("", { sealed: false }))).toBe(false);
    });

    it("searches a sealed post by its title and words, as the server cannot", () => {
        expect(openedPost(post(""), root({ body: "It crashes on start" }), "CRASH", opened)).not.toBeNull();
        expect(openedPost(post(""), root({ body: "It crashes on start" }), "start", opened)).not.toBeNull();
        expect(openedPost(post(""), root({ body: "It crashes on start" }), "printer", opened)).toBeNull();
        expect(openedPost(post(""), root(), "crash", () => undefined)).toBeNull();
    });
});

describe("the server's sealed forum post", () => {
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

    it("writes the post with no title and its tags, and the message with an empty body", async () => {
        expect(await sendSealed("u1", input({ forum: { tagIds: [tag] } }))).toBe("m1");
        expect(state.sent[0]![6]).toEqual({ title: "", tagIds: [tag] });
        expect(state.sent[0]![1]).toMatchObject({ body: "" });
        await sendSealed("u1", input());
        expect(state.sent[1]![6]).toBeNull();
    });

    it("refuses a post from a service member or one that is also a poll", async () => {
        await expect(sendSealed(POLAR_SERVICE_ID, input({ forum: { tagIds: [] } }))).rejects.toMatchObject({ reason: "forumRefused" });
        await expect(
            sendSealed("u1", input({ forum: { tagIds: [] }, poll: { options: 2, multiple: false, hideResults: false, anonymous: true, hours: 24 } }))
        ).rejects.toMatchObject({ reason: "forumRefused" });
        expect(state.sent).toHaveLength(0);
    });

    it("bounds what a device may claim about a post", () => {
        const body = (forum: object) => ({ op: "send-sealed", channelId: "0190a8c1-0000-7000-8000-0000000000cc", device: "device-01", clientKey: "0190a8c1-0000-7000-8000-0000000000aa", epoch: "3", senderLeaf: 0, ciphertext: "A".repeat(40), signature: "A".repeat(86), forum });
        expect(mlsBody.safeParse(body({ tagIds: [tag] })).success).toBe(true);
        expect(mlsBody.safeParse(body({})).success).toBe(true);
        expect(mlsBody.safeParse(body({ tagIds: ["not-a-uuid"] })).success).toBe(false);
        expect(mlsBody.safeParse(body({ tagIds: [], title: "in the clear" })).success).toBe(false);
    });
});
