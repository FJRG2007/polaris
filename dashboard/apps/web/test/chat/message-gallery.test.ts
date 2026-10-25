import { describe, expect, it } from "vitest";
import { messageGallery } from "@/app/(app)/chat/message-gallery";

type Attachment = Parameters<typeof messageGallery>[0]["attachments"][number];

function file(id: string, extra: Partial<Attachment> = {}): Attachment {
    return { id, name: `${id}.png`, inline: true, spoiler: false, ...extra } as Attachment;
}

const message = (attachments: Attachment[]) => ({ id: "m1", forwardable: true, attachments });

describe("messageGallery", () => {
    it("lists every picture on the message, in order, for the arrows", () => {
        const gallery = messageGallery(
            message([file("a"), file("doc", { inline: false }), file("b"), file("c")]),
            false,
            "/api/chat/attachments/b"
        );
        expect(gallery.map((image) => image.url)).toEqual([
            "/api/chat/attachments/a",
            "/api/chat/attachments/b",
            "/api/chat/attachments/c"
        ]);
        expect(gallery[0]).toMatchObject({ name: "a.png", messageId: "m1", forwardable: true });
    });

    it("skips a picture still under a spoiler, but keeps the one already open", () => {
        const pictures = [file("a"), file("hidden", { spoiler: true }), file("open", { spoiler: true })];
        const gallery = messageGallery(message(pictures), false, "/api/chat/attachments/open");
        expect(gallery.map((image) => image.url)).toEqual([
            "/api/chat/attachments/a",
            "/api/chat/attachments/open"
        ]);
    });

    it("steps through nothing when the whole conversation is covered", () => {
        const gallery = messageGallery(message([file("a"), file("b")]), true, "/api/chat/attachments/a");
        expect(gallery.map((image) => image.url)).toEqual(["/api/chat/attachments/a"]);
    });
});
