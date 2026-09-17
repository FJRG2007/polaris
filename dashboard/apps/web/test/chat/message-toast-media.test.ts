/**
 * What a message toast says and shows when the message has no words in it.
 *
 * A photo, a GIF, a video or a voice note arrives with an empty body, and a
 * toast that reads nothing under somebody's name says nothing happened.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { describeFiles, previewOf } = await import("@/lib/chat/toasts");
const { plainExcerpt } = await import("@/components/rich-text/excerpt");

function file(
    contentType: string,
    overrides: Partial<Parameters<typeof previewOf>[0][number]> = {}
) {
    return {
        id: "f1",
        name: "picture.png",
        contentType,
        posterPath: null,
        spoiler: false,
        ...overrides
    };
}

describe("what a toast says for a message with no words", () => {
    it("names the kind of thing that was sent", () => {
        expect(describeFiles([file("image/png")])).toBe("Sent a photo");
        expect(describeFiles([file("image/gif")])).toBe("Sent a GIF");
        expect(describeFiles([file("video/mp4")])).toBe("Sent a video");
        expect(describeFiles([file("audio/webm", { name: "voice-message.webm" })])).toBe(
            "Sent a voice message"
        );
        expect(describeFiles([file("application/pdf", { name: "plan.pdf" })])).toBe(
            "Sent plan.pdf"
        );
    });

    it("counts several", () => {
        expect(describeFiles([file("image/png"), file("image/jpeg")])).toBe("Sent 2 photos");
        expect(describeFiles([file("image/png"), file("application/pdf")])).toBe("Sent 2 files");
    });

    it("does not name what is behind a spoiler", () => {
        expect(describeFiles([file("image/png", { spoiler: true })])).toBe("Sent a spoiler");
        const hidden = { spoiler: true };
        expect(describeFiles([file("image/png", hidden), file("image/jpeg", hidden)])).toBe(
            "Sent 2 spoilers"
        );
        expect(describeFiles([file("video/mp4", hidden), file("video/mp4")])).toBe("Sent 2 files");
    });
});

describe("the picture a toast shows", () => {
    it("is the image itself", () => {
        expect(previewOf([file("image/webp")])).toEqual({
            kind: "image",
            src: "/api/chat/attachments/f1"
        });
    });

    it("is a video's still, and nothing for a video without one", () => {
        expect(previewOf([file("video/mp4", { posterPath: "p.jpg" })])).toEqual({
            kind: "video",
            src: "/api/chat/attachments/f1?poster=1"
        });
        expect(previewOf([file("video/mp4")])).toBeNull();
    });

    it("is never a spoiler, and never a file that is not a picture", () => {
        expect(previewOf([file("image/png", { spoiler: true })])).toBeNull();
        expect(previewOf([file("image/svg+xml")])).toBeNull();
        expect(previewOf([])).toBeNull();
    });
});

describe("a message that is only emoji", () => {
    it("keeps the emoji in the line", () => {
        expect(plainExcerpt("😀🎉", 90)).toBe("😀🎉");
    });
});
