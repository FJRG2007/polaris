/**
 * Files in a sealed conversation (proposal 10b): the seal carries each file's
 * key, digest, name and type; a reader's row draws a sealed attachment as
 * what its seal says once opened; the bytes uploaded are the sealed blob and
 * open back to the file only with that key and digest; and the server's
 * sealed send claims only sealed uploads, under the attach rules.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    allowed: true,
    maxAttachments: 10,
    claimed: [] as unknown[][],
    sent: [] as unknown[][],
    removed: [] as unknown[],
    existing: null as { id: string } | null,
    sendFails: false
}));

vi.mock("@polaris/db", () => ({
    Prisma: {},
    prisma: {
        mlsDevice: { findUnique: async () => ({ signatureKey: new Uint8Array(32) }) },
        mlsGroup: { findUnique: async () => ({ epoch: 3n }) },
        chatMessage: { findFirst: async () => state.existing }
    }
}));
vi.mock("@polaris/auth", () => ({ can: async () => state.allowed }));
vi.mock("@/lib/chat/rules", () => ({ rulesForChannel: async () => ({ maxAttachments: state.maxAttachments, keepEditHistory: false }) }));
vi.mock("@/lib/chat/uploads", () => {
    class UploadRefused extends Error {}
    return {
        UploadRefused,
        claimUploads: async (...args: unknown[]) => {
            state.claimed.push(args);
            if ((args[2] as string[]).includes("00000000-0000-4000-8000-00000000dead")) throw new UploadRefused("gone");
            return (args[2] as string[]).map((id) => ({ id, sealed: true, name: "file", path: `p/${id}`, connectionId: null }));
        }
    };
});
vi.mock("@/lib/chat/attachments", () => ({ removeStoredFiles: async (files: unknown) => void state.removed.push(files) }));
vi.mock("@/lib/chat/messages", () => ({
    send: async (...args: unknown[]) => {
        state.sent.push(args);
        if (state.sendFails) throw new Error("database down");
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
import * as sealedFiles from "@/lib/chat/e2ee/sealed-files";
import { unopenedFiles, withOpened } from "@/app/(app)/chat/opened-sealed";
import { sendSealed, SealedRefusal } from "@/lib/chat/e2ee/sealed-messages";

const FILE_ID = "0190a8c1-0000-7000-8000-000000000001";
const OTHER_ID = "0190a8c1-0000-7000-8000-0000000000ff";
const KEY = "A".repeat(43);
const ref = (id = FILE_ID): sealedChat.SealedFileRef => ({
    id,
    key: KEY,
    sha256: KEY,
    name: "holiday.png",
    type: "image/png",
    size: 1234,
    shape: { w: 40, h: 30 },
    spoiler: true
});
const storedFile = (id: string, sealed: boolean) => ({
    id,
    name: "file",
    size: 1250,
    contentType: "application/octet-stream",
    inline: false,
    hasPoster: false,
    width: null,
    height: null,
    thumbhash: null,
    spoiler: false,
    borrowed: false,
    durationMs: null,
    waveform: null,
    ...(sealed ? { sealed: true } : {})
});
const row = (attachments: unknown[]) => ({ id: "m", channelId: "c", body: "", sealed: true, attachments }) as unknown as ChatMessageView;

describe("files inside the seal", () => {
    it("round-trips the files a message carries and refuses a malformed one", () => {
        const content: sealedChat.SealedContent = { body: "look", files: [ref()] };
        expect(sealedChat.decodeSealedContent(sealedChat.encodeSealedContent(content))).toEqual(content);
        const bad = (file: unknown) => new TextEncoder().encode(JSON.stringify({ v: 1, body: "x", files: [file] }));
        expect(sealedChat.decodeSealedContent(bad({ ...ref(), key: "short" }))).toBeNull();
        expect(sealedChat.decodeSealedContent(bad({ ...ref(), url: "https://elsewhere" }))).toBeNull();
        expect(sealedChat.decodeSealedContent(bad({ ...ref(), id: "not-a-uuid" }))).toBeNull();
        // An empty list is not written at all.
        expect(new TextDecoder().decode(sealedChat.encodeSealedContent({ body: "x", files: [] }))).not.toContain("files");
    });

    it("draws a sealed attachment as its seal says, and only one the row stores", () => {
        const plain = storedFile("0190a8c1-0000-7000-8000-000000000002", false);
        const message = row([storedFile(FILE_ID, true), plain]);
        const [drawn] = withOpened([message], () => ({ body: "look", files: [ref()] }), (id) => (id === FILE_ID ? "blob:opened" : undefined));
        const [sealedOne, plainOne] = drawn!.attachments;
        expect(sealedOne).toMatchObject({
            name: "holiday.png",
            contentType: "image/png",
            size: 1234,
            width: 40,
            height: 30,
            inline: true,
            spoiler: true,
            openedUrl: "blob:opened",
            hasPoster: false
        });
        expect(plainOne).toBe(plain);
        // A ref naming a file the row does not store is ignored, and an unopened one has no URL yet.
        const opened = () => ({ body: "", files: [ref(), ref(OTHER_ID)] });
        const [notYet] = withOpened([row([storedFile(FILE_ID, true)])], opened, () => undefined);
        expect(notYet!.attachments).toHaveLength(1);
        expect(notYet!.attachments[0]!.openedUrl).toBeUndefined();
        expect(unopenedFiles([row([storedFile(FILE_ID, true)])], opened).map((one) => one.id)).toEqual([FILE_ID]);
    });

    it("uploads only the sealed blob, which opens back to the file with the key in the seal", async () => {
        const clear = new Uint8Array(200_000).map((_, at) => at & 0xff);
        const file = new File([clear], "notes.pdf", { type: "application/pdf" });
        const sealing = await sealedFiles.sealForUpload(file, { durationMs: 1500, waveform: "123", spoiler: false });
        const uploaded = new Uint8Array(await sealing.blob.arrayBuffer());
        expect(sealing.blob.type).toBe("application/octet-stream");
        expect(uploaded.length).toBeGreaterThan(clear.length);
        const sealedRef = sealing.ref(FILE_ID);
        expect(sealedRef).toMatchObject({ id: FILE_ID, name: "notes.pdf", type: "application/pdf", size: 200_000, durationMs: 1500, waveform: "123" });
        expect(sealedChat.sealedFileSchema.safeParse(sealedRef).success).toBe(true);

        const blobs: Blob[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(uploaded))
        );
        URL.createObjectURL = ((blob: Blob) => {
            blobs.push(blob);
            return `blob:${blobs.length}`;
        }) as typeof URL.createObjectURL;
        URL.revokeObjectURL = () => undefined;
        expect(await sealedFiles.openSealedFile(sealedRef)).toBe("blob:1");
        expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(clear);
        expect(blobs[0]!.type).toBe("application/pdf");
        expect(sealedFiles.openedFileUrl(FILE_ID)).toBe("blob:1");

        // A blob that is not the one the seal names never draws, and is not fetched again.
        const other = { ...sealedRef, id: "0190a8c1-0000-7000-8000-000000000009", sha256: KEY };
        expect(await sealedFiles.openSealedFile(other)).toBeNull();
        expect(await sealedFiles.openSealedFile(other)).toBeNull();
        expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
        vi.unstubAllGlobals();
    });
});

describe("the server's sealed send with files", () => {
    const input = (uploads?: string[]) => ({
        channelId: "c",
        device: "d",
        clientKey: "0190a8c1-0000-7000-8000-0000000000aa",
        epoch: 3n,
        senderLeaf: 0,
        ciphertext: new Uint8Array(40),
        signature: new Uint8Array(64),
        ...(uploads ? { uploads } : {})
    });

    beforeEach(() => {
        Object.assign(state, { allowed: true, maxAttachments: 10, claimed: [], sent: [], removed: [], existing: null, sendFails: false });
    });

    it("claims the sealed uploads and stores them on the message", async () => {
        expect(await sendSealed("u1", input([FILE_ID]))).toBe("m1");
        expect(state.claimed[0]).toEqual(["u1", "c", [FILE_ID], undefined, true]);
        expect((state.sent[0]![2] as { id: string; sealed: boolean }[])[0]).toMatchObject({ id: FILE_ID, sealed: true });
    });

    it("refuses files to someone who may not attach, where files are off, past the limit, or not staged", async () => {
        state.allowed = false;
        await expect(sendSealed("u1", input([FILE_ID]))).rejects.toMatchObject({ reason: "filesRefused" });
        state.allowed = true;
        state.maxAttachments = 0;
        await expect(sendSealed("u1", input([FILE_ID]))).rejects.toBeInstanceOf(SealedRefusal);
        state.maxAttachments = 1;
        await expect(sendSealed("u1", input([FILE_ID, "0190a8c1-0000-7000-8000-000000000003"]))).rejects.toMatchObject({ reason: "filesRefused" });
        await expect(sendSealed("u1", input(["00000000-0000-4000-8000-00000000dead"]))).rejects.toMatchObject({ reason: "filesRefused" });
        expect(state.sent).toHaveLength(0);
    });

    it("answers the stored message on a retry, and takes the files off when the send fails", async () => {
        state.existing = { id: "m0" };
        expect(await sendSealed("u1", input([FILE_ID]))).toBe("m0");
        expect(state.claimed).toHaveLength(0);
        state.existing = null;
        state.sendFails = true;
        await expect(sendSealed("u1", input([FILE_ID]))).rejects.toThrow("database down");
        expect(state.removed).toHaveLength(1);
    });

    it("sends a message with no files exactly as before", async () => {
        expect(await sendSealed("u1", input())).toBe("m1");
        expect(state.claimed).toHaveLength(0);
        expect(state.sent[0]![2]).toEqual([]);
    });
});

describe("a sealed picture in the viewer", () => {
    it("steps only onto sealed pictures this page opened", async () => {
        const { messageGallery } = await import("@/app/(app)/chat/message-gallery");
        const picture = { id: FILE_ID, name: "a.png", inline: true, spoiler: false, thumbhash: null, sealed: true };
        const message = {
            id: "m1",
            forwardable: true,
            attachments: [
                { ...picture, openedUrl: "blob:opened" },
                { ...picture, id: OTHER_ID }
            ]
        } as unknown as ChatMessageView;
        expect(messageGallery(message, false, "blob:opened").map((image) => image.url)).toEqual(["blob:opened"]);
    });
});
