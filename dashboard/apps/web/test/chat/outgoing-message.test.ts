/**
 * A message with files, drawn as a row of the conversation while they go.
 *
 * The owner's report: the blurred "sending" picture sat in a box of its own off
 * to the right, and when it landed a second, different picture appeared in the
 * message. The row now is the message - same list, same attachment components,
 * same size - and the landed message takes its key so nothing is drawn twice.
 */

import type { Outgoing } from "@/app/(app)/chat/outgoing";
import type { ChatMessageView } from "@/lib/chat/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    isOutgoingRow,
    outgoingFileId,
    outgoingFileIndex,
    outgoingMessage,
    outgoingRowId,
    unlandedOutgoing,
    withSending
} from "@/app/(app)/chat/outgoing-message";
import { draftMessage } from "@/app/(app)/chat/draft-message";
import {
    heldLocalUrl,
    landedAs,
    localUrl,
    releaseFiles,
    rememberLanded
} from "@/app/(app)/chat/local-media";

const facts = { channelId: "channel-1", authorId: "user-me", authorName: "Alex Iglesias" };

function picture(name = "photo.jpg"): File {
    return new File([new Uint8Array([1, 2, 3])], name, { type: "image/jpeg" });
}

function outgoing(overrides: Partial<Outgoing> = {}): Outgoing {
    return {
        id: "outgoing-a-1",
        scope: "channel:channel-1",
        body: "look",
        files: [picture()],
        kept: [],
        hidden: [],
        phase: "sending",
        items: [{ phase: "sending", fraction: 0.4 }],
        at: "2026-11-21T10:00:00.000Z",
        ...overrides
    };
}

function stored(id: string, createdAt: string): ChatMessageView {
    return { ...draftMessage({ id, ...facts, body: "x" }), createdAt };
}

describe("a message with files on its way", () => {
    it("is a row of the conversation, written by the sender, at the time it was sent", () => {
        const row = outgoingMessage(outgoing(), facts);
        expect(row.id).toBe(outgoingRowId("outgoing-a-1"));
        expect(isOutgoingRow(row.id)).toBe(true);
        expect(row.authorName).toBe("Alex Iglesias");
        expect(row.body).toBe("look");
        expect(row.createdAt).toBe("2026-11-21T10:00:00.000Z");
    });

    it("carries each picture inline, at the size it was measured at", () => {
        const row = outgoingMessage(
            outgoing({ shapes: [{ width: 1200, height: 800, thumbhash: "abc" }] }),
            facts
        );
        expect(row.attachments).toHaveLength(1);
        const [file] = row.attachments;
        expect(file!.inline).toBe(true);
        expect(file!.width).toBe(1200);
        expect(file!.height).toBe(800);
        expect(file!.thumbhash).toBe("abc");
        expect(outgoingFileIndex(file!.id)).toBe(0);
    });

    it("leaves out a file the sender stopped, and keeps the others' own index", () => {
        const row = outgoingMessage(
            outgoing({
                files: [picture("a.jpg"), picture("b.jpg")],
                items: [
                    { phase: "cancelled", fraction: 0 },
                    { phase: "sending", fraction: 0.1 }
                ]
            }),
            facts
        );
        expect(row.attachments.map((file) => file.name)).toEqual(["b.jpg"]);
        expect(outgoingFileIndex(row.attachments[0]!.id)).toBe(1);
    });

    it("draws a generic file as a file, and a Drive pick after the files, covered by its own position", () => {
        const row = outgoingMessage(
            outgoing({
                files: [new File(["x"], "notes.zip", { type: "application/zip" })],
                kept: [{ connectionId: "c", path: "/a.pdf", name: "a.pdf", size: 10 }],
                hidden: [1],
                items: [{ phase: "waiting", fraction: 0 }]
            }),
            facts
        );
        expect(row.attachments.map((file) => [file.name, file.inline, file.spoiler, file.borrowed])).toEqual([
            ["notes.zip", false, false, false],
            ["a.pdf", false, true, true]
        ]);
        expect(outgoingFileIndex(row.attachments[1]!.id)).toBeNull();
    });

    it("draws a picture sent to be seen once as the once card, not inline", () => {
        const row = outgoingMessage(
            outgoing({ viewOnce: [{ index: 0, seconds: null, captured: null }] }),
            facts
        );
        expect(row.attachments[0]!.inline).toBe(false);
        expect(row.attachments[0]!.viewOnce?.opened).toBe(false);
    });

    it("is no longer drawn once the message it became is on screen", () => {
        const one = outgoing({ posted: "message-9" });
        expect(unlandedOutgoing([one], [])).toEqual([one]);
        expect(unlandedOutgoing([one], [stored("message-9", "2026-11-21T10:00:01.000Z")])).toEqual([]);
        expect(unlandedOutgoing([outgoing()], [stored("message-9", "x")])).toHaveLength(1);
    });

    it("sits after what is stored, in the order things were sent", () => {
        const old = stored("message-1", "2026-11-21T09:00:00.000Z");
        const late = outgoingMessage(outgoing({ id: "b", at: "2026-11-21T10:00:05.000Z" }), facts);
        const early = outgoingMessage(outgoing({ id: "a", at: "2026-11-21T10:00:00.000Z" }), facts);
        expect(withSending([old], [late, early]).map((message) => message.id)).toEqual([
            "message-1",
            outgoingRowId("a"),
            outgoingRowId("b")
        ]);
    });

    it("never treats a stored attachment as one on its way", () => {
        expect(outgoingFileIndex("3f2b0c1e-0000-4000-8000-000000000000")).toBeNull();
        expect(outgoingFileIndex(outgoingFileId(outgoingRowId("a"), 2))).toBe(2);
    });
});

describe("the sender's own copy of a landed picture", () => {
    afterEach(() => vi.restoreAllMocks());

    it("is kept for the landed message to draw, under the row's keys, and let go of everything else", () => {
        let made = 0;
        vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test-${++made}`);
        const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
        const photo = picture();
        const archive = new File(["x"], "notes.zip", { type: "application/zip" });
        const address = localUrl(photo);
        expect(localUrl(photo)).toBe(address);
        localUrl(archive);
        const row = outgoingRowId("landed-1");
        rememberLanded("message-1", {
            key: row,
            files: [
                { file: photo, key: outgoingFileId(row, 0) },
                { file: archive, key: outgoingFileId(row, 1) }
            ]
        });
        releaseFiles([photo, archive]);
        expect(heldLocalUrl(photo)).toBe(address);
        expect(heldLocalUrl(archive)).toBeUndefined();
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(landedAs("message-1")?.key).toBe(row);
        expect(landedAs("message-1")?.files[0]?.key).toBe(outgoingFileId(row, 0));
    });
});
