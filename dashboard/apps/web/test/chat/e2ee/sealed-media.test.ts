/**
 * Sealed files beyond the conversation itself: the shared-media gallery draws
 * a sealed picture or video as its opened seal says (and leaves out anything
 * else, or one that did not open), a sealed video gets a still taken on the
 * reader's page, and a surface can ask to open only the sealed files it draws.
 */

import { describe, expect, it } from "vitest";
import type { ChatMessageView } from "@/lib/chat/messages";
import type * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import type { SharedMediaItem } from "@/app/(app)/chat/actions";
import { unopenedFiles, withOpened } from "@/app/(app)/chat/opened-sealed";
import { galleryRef, sharedTiles, type SealedState } from "@/app/(app)/chat/shared-media-items";

const PICTURE = "0190a8c1-0000-7000-8000-000000000001";
const VIDEO = "0190a8c1-0000-7000-8000-000000000002";
const PAPER = "0190a8c1-0000-7000-8000-000000000003";
const KEY = "A".repeat(43);

const ref = (id: string, type: string, extra: Partial<sealedChat.SealedFileRef> = {}): sealedChat.SealedFileRef => ({
    id,
    key: KEY,
    sha256: KEY,
    name: `${id.slice(-1)}.${type.split("/")[1]}`,
    type,
    size: 10,
    ...extra
});
const stored = (id: string) => ({
    id,
    name: "file",
    size: 30,
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
    sealed: true
});
const message = (id: string, files: string[]) =>
    ({ id, channelId: "c", body: "", sealed: true, attachments: files.map(stored) }) as unknown as ChatMessageView;
const item = (id: string, messageId: string, sealed = true): SharedMediaItem => ({
    id,
    messageId,
    forwardable: true,
    name: "file",
    video: false,
    durationMs: null,
    hasPoster: false,
    thumbhash: null,
    sentAt: "2026-11-25T10:00:00.000Z",
    ...(sealed ? { sealed: true as const } : {})
});
const content = { body: "", files: [ref(PICTURE, "image/png"), ref(VIDEO, "video/mp4", { durationMs: 4000 }), ref(PAPER, "application/pdf")] };
const state = (over: Partial<SealedState> = {}): SealedState => ({ readable: true, content: () => content, fileFailed: () => false, ...over });

describe("the shared-media gallery with sealed files", () => {
    const sealedMessage = message("m1", [PICTURE, VIDEO, PAPER]);
    const items = [item(PICTURE, "m1"), item(VIDEO, "m1"), item(PAPER, "m1")];

    it("keeps a plain list as it came", () => {
        const plain = [item("p1", "m0", false)];
        expect(sharedTiles(plain, [], state())).toBe(plain);
    });

    it("draws sealed pictures and videos from the opened seal and leaves the rest out", () => {
        const urls: Record<string, string> = { [PICTURE]: "blob:picture", [VIDEO]: "blob:video" };
        const [opened] = withOpened([sealedMessage], () => content, (id) => urls[id], (id) => (id === VIDEO ? "blob:still" : undefined));
        const tiles = sharedTiles(items, [opened!], state());
        expect(tiles.map((tile) => tile.id)).toEqual([PICTURE, VIDEO]);
        expect(tiles[0]).toMatchObject({ name: "1.png", video: false, openedUrl: "blob:picture" });
        expect(tiles[0]!.pending).toBeUndefined();
        expect(tiles[1]).toMatchObject({ video: true, durationMs: 4000, openedUrl: "blob:video", openedPosterUrl: "blob:still" });
    });

    it("shows a sealed file still opening as a tile that cannot be opened yet", () => {
        const waiting = sharedTiles(items, [sealedMessage], state({ content: () => undefined }));
        expect(waiting.every((tile) => tile.pending && tile.name === "")).toBe(true);
        // Opened seal, bytes not yet: a picture waits for them.
        const [opened] = withOpened([sealedMessage], () => content, () => undefined);
        expect(sharedTiles(items, [opened!], state())[0]).toMatchObject({ pending: true, name: "1.png" });
    });

    it("leaves out what this page cannot open: no sealed chat, a seal or a file that did not open", () => {
        expect(sharedTiles(items, [sealedMessage], state({ readable: false }))).toEqual([]);
        expect(sharedTiles(items, [sealedMessage], state({ content: () => null }))).toEqual([]);
        expect(sharedTiles(items, [sealedMessage], state({ fileFailed: (id) => id === PICTURE })).map((tile) => tile.id)).toEqual([VIDEO]);
        // A covered picture is not a tile, as a plain one is not.
        const covered = { body: "", files: [ref(PICTURE, "image/png", { spoiler: true })] };
        expect(sharedTiles([item(PICTURE, "m1")], [sealedMessage], state({ content: () => covered }))).toEqual([]);
    });

    it("opens only the sealed files a surface draws", () => {
        expect(unopenedFiles([sealedMessage], () => content, galleryRef).map((one) => one.id)).toEqual([PICTURE, VIDEO]);
        expect(unopenedFiles([sealedMessage], () => content).map((one) => one.id)).toEqual([PICTURE, VIDEO, PAPER]);
    });
});

describe("a sealed video's still", () => {
    it("is drawn from the still this page took, and never asks the server for one", () => {
        const [opened] = withOpened([message("m1", [VIDEO])], () => ({ body: "", files: [ref(VIDEO, "video/mp4")] }), () => "blob:video", () => "blob:still");
        expect(opened!.attachments[0]).toMatchObject({ openedPosterUrl: "blob:still", hasPoster: false, contentType: "video/mp4" });
        const [none] = withOpened([message("m1", [VIDEO])], () => ({ body: "", files: [ref(VIDEO, "video/mp4")] }), () => "blob:video", () => undefined);
        expect(none!.attachments[0]!.openedPosterUrl).toBeUndefined();
    });
});
